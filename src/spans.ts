export interface ParsedSpan {
  source: string;
  target: string;
  traceId: string;
  spanId: string;
  parentSpanId: string;
  rpcMethod: string;
  status: 'ok' | 'error';
  startTime: number;
  duration: number;
}

const SPAN_KIND_CLIENT = 3;
const SPAN_KIND_SERVER = 2;
const STATUS_CODE_ERROR = 2;

const DEBUG = process.env.DEBUG_SPANS === 'true';

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; intValue?: string | number };
}

interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  name?: string;
  kind?: number;
  startTimeUnixNano?: string;
  endTimeUnixNano?: string;
  attributes?: OtlpAttribute[];
  status?: { code?: number };
}

interface OtlpScopeSpans {
  spans?: OtlpSpan[];
}

interface OtlpResourceSpans {
  resource?: { attributes?: OtlpAttribute[] };
  scopeSpans?: OtlpScopeSpans[];
}

interface OtlpExportRequest {
  resourceSpans?: OtlpResourceSpans[];
}

function getAttr(attrs: OtlpAttribute[] | undefined, key: string): string {
  const found = attrs?.find(a => a.key === key);
  if (!found) return '';
  return found.value?.stringValue ?? String(found.value?.intValue ?? '');
}

// Extract hostname from a "host:port" or "http://host:port/..." string
function hostnameFrom(raw: string): string {
  if (!raw) return '';
  // Try URL parsing first (handles http://host:port/...)
  try {
    const u = new URL(raw);
    return u.hostname;
  } catch { /* not a URL */ }
  // Fall back to splitting on ':' for bare "host:port"
  return raw.split(':')[0] ?? '';
}

export function parseSpanLine(line: string): ParsedSpan[] {
  const trimmed = line.trim();
  if (!trimmed) return [];

  let parsed: OtlpExportRequest;
  try {
    parsed = JSON.parse(trimmed) as OtlpExportRequest;
  } catch {
    return [];
  }

  const result: ParsedSpan[] = [];

  for (const rs of parsed.resourceSpans ?? []) {
    const serviceName = getAttr(rs.resource?.attributes, 'service.name');
    if (!serviceName) continue;

    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const startNs = BigInt(span.startTimeUnixNano ?? '0');
        const endNs   = BigInt(span.endTimeUnixNano ?? '0');
        const duration = Number(endNs - startNs) / 1_000_000;
        const status   = span.status?.code === STATUS_CODE_ERROR ? 'error' : 'ok';

        // ── CLIENT spans: service A is calling service B ──────────────────────
        if (span.kind === SPAN_KIND_CLIENT) {
          // Try several attribute names in order of reliability
          let target =
            getAttr(span.attributes, 'peer.service') ||
            getAttr(span.attributes, 'net.peer.name') ||
            getAttr(span.attributes, 'server.address');

          // Fallback: extract from http.host (may include port)
          if (!target) {
            target = hostnameFrom(getAttr(span.attributes, 'http.host'));
          }

          // Fallback: extract hostname from full URL attributes
          if (!target) {
            const urlRaw =
              getAttr(span.attributes, 'url.full') ||
              getAttr(span.attributes, 'http.url');
            if (urlRaw) target = hostnameFrom(urlRaw);
          }

          if (!target) {
            if (DEBUG) {
              console.debug(
                `[spans] CLIENT span no target: service=${serviceName} name=${span.name ?? ''} attrs=${JSON.stringify(span.attributes?.map(a => a.key))}`,
              );
            }
            continue;
          }

          // rpcMethod: gRPC method, then HTTP method+route, then span name
          const rpcMethod =
            getAttr(span.attributes, 'rpc.method') ||
            buildHttpMethod(span.attributes, span.name) ||
            span.name ||
            '';

          result.push({
            source: serviceName,
            target,
            traceId:      span.traceId ?? '',
            spanId:       span.spanId ?? '',
            parentSpanId: span.parentSpanId ?? '',
            rpcMethod,
            status,
            startTime: Number(startNs) / 1_000_000,
            duration,
          });
          continue;
        }

        // ── HTTP SERVER spans: an external client hit this service ────────────
        // Identified by kind=SERVER + presence of http.method (not rpc.system,
        // which would indicate gRPC — those are handled via the gRPC CLIENT span
        // emitted by the calling service).
        if (span.kind === SPAN_KIND_SERVER) {
          const httpMethod = getAttr(span.attributes, 'http.method') ||
                             getAttr(span.attributes, 'http.request.method');
          const isGrpc     = !!getAttr(span.attributes, 'rpc.system');

          if (!httpMethod || isGrpc) continue;

          const route =
            getAttr(span.attributes, 'http.route') ||
            getAttr(span.attributes, 'http.target') ||
            getAttr(span.attributes, 'url.path') ||
            '';

          result.push({
            source:       'client',
            target:       serviceName,
            traceId:      span.traceId ?? '',
            spanId:       span.spanId ?? '',
            parentSpanId: span.parentSpanId ?? '',
            rpcMethod:    route ? `${httpMethod} ${route}` : httpMethod,
            status,
            startTime:    Number(startNs) / 1_000_000,
            duration,
          });
        }
      }
    }
  }

  return result;
}

function buildHttpMethod(
  attrs: OtlpAttribute[] | undefined,
  spanName: string | undefined,
): string {
  const method =
    getAttr(attrs, 'http.method') ||
    getAttr(attrs, 'http.request.method');
  if (!method) return '';
  const route =
    getAttr(attrs, 'http.route') ||
    getAttr(attrs, 'http.target') ||
    getAttr(attrs, 'url.path') ||
    spanName ||
    '';
  return route ? `${method} ${route}` : method;
}
