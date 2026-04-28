interface SpanRecord {
  ts: number;
  isError: boolean;
}

const records = new Map<string, SpanRecord[]>();
const WINDOW_MS = 60_000;

export function recordSpan(service: string, isError: boolean): void {
  if (!records.has(service)) {
    records.set(service, []);
  }
  records.get(service)!.push({ ts: Date.now(), isError });
}

export function getKnownServices(): string[] {
  return Array.from(records.keys());
}

export function getHealthSnapshot(service: string): {
  status: 'healthy' | 'degraded' | 'down';
  errorRate: number;
} {
  const now = Date.now();
  const all = records.get(service) ?? [];
  const recent = all.filter(r => now - r.ts < WINDOW_MS);
  records.set(service, recent);

  if (recent.length === 0) {
    return { status: 'down', errorRate: 0 };
  }

  const errorRate = recent.filter(r => r.isError).length / recent.length;
  return {
    status: errorRate > 0 ? 'degraded' : 'healthy',
    errorRate,
  };
}
