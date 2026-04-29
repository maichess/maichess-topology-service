import { addNode, addEdge } from './graph';
import { recordSpan, registerService } from './health';
import type { ParsedSpan } from './spans';

const PROMETHEUS_URL = process.env.OTEL_PROMETHEUS_URL ?? 'http://otel-collector:8889';
const POLL_MS = 5_000;

// Accumulated totals from the previous poll, keyed by "client->server"
const prevTotal = new Map<string, number>();
const prevFailed = new Map<string, number>();

function labelValue(line: string, key: string): string {
  const m = line.match(new RegExp(`${key}="([^"]*)"`));
  return m?.[1] ?? '';
}

interface EdgeCounts {
  client: string;
  server: string;
  total: number;
  failed: number;
}

function parseServiceGraphMetrics(text: string): EdgeCounts[] {
  const byEdge = new Map<string, EdgeCounts>();

  for (const line of text.split('\n')) {
    if (!line.startsWith('traces_service_graph_request_total{')) continue;

    const client = labelValue(line, 'client');
    const server = labelValue(line, 'server');
    if (!client || !server) continue;

    const isFailed = labelValue(line, 'failed') === 'true';
    const parts = line.split(' ');
    const value = Number(parts[parts.length - 1]);
    if (isNaN(value)) continue;

    const key = `${client}->${server}`;
    const existing = byEdge.get(key) ?? { client, server, total: 0, failed: 0 };
    byEdge.set(key, {
      client,
      server,
      total: existing.total + value,
      failed: existing.failed + (isFailed ? value : 0),
    });
  }

  return Array.from(byEdge.values());
}

export function startMetricsPoller(onActivity: (span: ParsedSpan) => void): void {
  setInterval(async () => {
    let text: string;
    try {
      const res = await fetch(`${PROMETHEUS_URL}/metrics`);
      if (!res.ok) return;
      text = await res.text();
    } catch {
      return; // collector not reachable yet — will retry next tick
    }

    for (const { client, server, total, failed } of parseServiceGraphMetrics(text)) {
      addNode(client);
      addNode(server);
      addEdge(client, server);
      registerService(client);
      registerService(server);

      const key = `${client}->${server}`;
      const deltaTotal = total - (prevTotal.get(key) ?? 0);
      const deltaFailed = failed - (prevFailed.get(key) ?? 0);
      prevTotal.set(key, total);
      prevFailed.set(key, failed);

      if (deltaTotal <= 0) continue;

      // Emit one activity event per poll cycle per edge so the client
      // shows the animated dot. rpcMethod/traceId are unavailable from
      // aggregated metrics but source+target+status are sufficient.
      recordSpan(client, deltaFailed > 0);
      onActivity({
        source: client,
        target: server,
        traceId: '',
        spanId: '',
        parentSpanId: '',
        rpcMethod: '',
        status: deltaFailed > 0 ? 'error' : 'ok',
        startTime: Date.now(),
        duration: 0,
      });
    }
  }, POLL_MS);
}
