import http from 'http';

interface ContainerState {
  Status: string; // "running" | "exited" | "paused" | "restarting" | ...
  Running: boolean;
}

interface ContainerSummary {
  Id: string;
  Names: string[];
}

interface ContainerInspect {
  State?: ContainerState;
  Config?: {
    Env?: string[];
  };
}

function dockerRequest<T>(path: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: '/var/run/docker.sock',
        path,
        method: 'GET',
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as T);
          } catch {
            reject(new Error(`Failed to parse Docker response for ${path}`));
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// OTel service name → Docker container name (maichess-{service})
function containerName(service: string): string {
  return `maichess-${service}`;
}

export async function getContainerRunning(service: string): Promise<boolean | null> {
  try {
    const data = await dockerRequest<ContainerInspect>(
      `/containers/${encodeURIComponent(containerName(service))}/json`,
    );
    return data.State?.Running ?? false;
  } catch {
    // Docker socket unavailable or container not found
    return null;
  }
}

// ─── Graph discovery from Docker env vars ────────────────────────────────────

export interface DiscoveredGraph {
  nodes: string[];
  edges: Array<{ source: string; target: string }>;
}

// Matches hostname:port patterns with optional protocol/auth prefix.
// Covers: http://host:port, redis://:pass@host:port, host:port, mongodb://user:pass@host:port
const HOST_PORT_RE = /(?:[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?)?([a-z][a-z0-9-]*):\d+/g;

// Infra containers that should not appear as topology nodes
const EXCLUDED_HOSTS = new Set([
  'otel-collector',
  'tempo',
  'grafana',
  'traefik',
  'localhost',
  '127.0.0.1',
  'topology-service',
  'topology-client',
]);

export async function discoverGraphFromDocker(): Promise<DiscoveredGraph> {
  const containers = await dockerRequest<ContainerSummary[]>('/containers/json');

  // Map from Docker container name (without leading /) → service name
  const containerToService = new Map<string, string>();
  for (const c of containers) {
    const rawName = c.Names[0] ?? '';
    const name = rawName.startsWith('/') ? rawName.slice(1) : rawName;
    if (!name.startsWith('maichess-')) continue;
    const serviceName = name.slice('maichess-'.length);
    containerToService.set(name, serviceName);
  }

  const knownServiceNames = new Set(containerToService.values());
  const discoveredNodes = new Set<string>();
  const edgeSet = new Set<string>(); // "source->target" dedup keys
  const discoveredEdges: Array<{ source: string; target: string }> = [];

  function addEdge(source: string, target: string) {
    const key = `${source}->${target}`;
    if (!edgeSet.has(key)) {
      edgeSet.add(key);
      discoveredEdges.push({ source, target });
    }
  }

  for (const [dockerName, serviceName] of containerToService) {
    let inspectData: ContainerInspect;
    try {
      inspectData = await dockerRequest<ContainerInspect>(
        `/containers/${encodeURIComponent(dockerName)}/json`,
      );
    } catch {
      continue;
    }

    const envVars = inspectData.Config?.Env ?? [];
    const hasOtel = envVars.some((e) => e.startsWith('OTEL_EXPORTER_OTLP_ENDPOINT='));
    const isClient = serviceName === 'client';

    // Only process OTel-enabled services and the client container
    if (!hasOtel && !isClient) continue;

    // OTel-enabled services become topology nodes
    if (hasOtel) {
      // Prefer explicit OTEL_SERVICE_NAME if set, otherwise use container-derived name
      const otelNameVar = envVars.find((e) => e.startsWith('OTEL_SERVICE_NAME='));
      const otelName = otelNameVar ? otelNameVar.slice('OTEL_SERVICE_NAME='.length) : serviceName;
      discoveredNodes.add(otelName);
    }
    // 'client' is always injected by the frontend, not added as a backend node

    // Scan all env var values for hostname:port references to infer edges
    const edgeSource = isClient ? 'client' : serviceName;
    for (const envLine of envVars) {
      // Skip the OTel exporter endpoint itself — otel-collector is not a topology peer
      if (envLine.startsWith('OTEL_EXPORTER_OTLP_ENDPOINT=')) continue;

      const eqIdx = envLine.indexOf('=');
      if (eqIdx === -1) continue;
      const value = envLine.slice(eqIdx + 1);

      HOST_PORT_RE.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = HOST_PORT_RE.exec(value)) !== null) {
        const host = match[1];
        if (EXCLUDED_HOSTS.has(host)) continue;
        if (host === serviceName) continue; // skip self-references
        if (!knownServiceNames.has(host)) continue; // not a maichess container

        // Add the peer as a node (may be a raw DB with no OTel — still show it)
        discoveredNodes.add(host);
        addEdge(edgeSource, host);
      }
    }
  }

  return {
    nodes: Array.from(discoveredNodes),
    edges: discoveredEdges,
  };
}
