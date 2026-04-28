import http from 'http';

interface ContainerState {
  Status: string; // "running" | "exited" | "paused" | "restarting" | ...
  Running: boolean;
}

interface ContainerInspect {
  State?: ContainerState;
}

function inspect(containerName: string): Promise<ContainerInspect> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath: '/var/run/docker.sock',
        path: `/containers/${encodeURIComponent(containerName)}/json`,
        method: 'GET',
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as ContainerInspect);
          } catch {
            reject(new Error('Failed to parse Docker response'));
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
    const data = await inspect(containerName(service));
    return data.State?.Running ?? false;
  } catch {
    // Docker socket unavailable or container not found
    return null;
  }
}
