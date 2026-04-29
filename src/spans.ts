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
const STATUS_CODE_ERROR = 2;

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string };
}

interface OtlpSpan {
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
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
  return attrs?.find(a => a.key === key)?.value?.stringValue ?? '';
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
    const source = getAttr(rs.resource?.attributes, 'service.name');
    if (!source) continue;

    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        if (span.kind !== SPAN_KIND_CLIENT) continue;

        const target =
          getAttr(span.attributes, 'peer.service') ||
          getAttr(span.attributes, 'net.peer.name') ||
          getAttr(span.attributes, 'server.address');
        if (!target) continue;

        const startNs = BigInt(span.startTimeUnixNano ?? '0');
        const endNs = BigInt(span.endTimeUnixNano ?? '0');
        const duration = Number(endNs - startNs) / 1_000_000;

        result.push({
          source,
          target,
          traceId: span.traceId ?? '',
          spanId: span.spanId ?? '',
          parentSpanId: span.parentSpanId ?? '',
          rpcMethod: getAttr(span.attributes, 'rpc.method'),
          status: span.status?.code === STATUS_CODE_ERROR ? 'error' : 'ok',
          startTime: Number(startNs) / 1_000_000,
          duration,
        });
      }
    }
  }

  return result;
}
