import { getContainerRunning } from './docker';

interface SpanRecord {
  ts: number;
  isError: boolean;
}

const records = new Map<string, SpanRecord[]>();
const WINDOW_MS = 60_000;
const ERROR_RATE_THRESHOLD = 0.1; // 10 %
const MIN_SAMPLES_FOR_DEGRADED = 5;

export function registerService(service: string): void {
  if (!records.has(service)) {
    records.set(service, []);
  }
}

export function recordSpan(service: string, isError: boolean): void {
  registerService(service);
  records.get(service)!.push({ ts: Date.now(), isError });
}

export function getKnownServices(): string[] {
  return Array.from(records.keys());
}

function errorRateInWindow(service: string): { rate: number; samples: number } {
  const now = Date.now();
  const all = records.get(service) ?? [];
  const recent = all.filter(r => now - r.ts < WINDOW_MS);
  records.set(service, recent);

  if (recent.length === 0) return { rate: 0, samples: 0 };
  return {
    rate: recent.filter(r => r.isError).length / recent.length,
    samples: recent.length,
  };
}

export async function getHealthSnapshot(service: string): Promise<{
  status: 'healthy' | 'degraded' | 'down';
  errorRate: number;
}> {
  const { rate, samples } = errorRateInWindow(service);
  const elevated = samples >= MIN_SAMPLES_FOR_DEGRADED && rate > ERROR_RATE_THRESHOLD;

  const running = await getContainerRunning(service);

  if (running === null) {
    // Docker unavailable — default healthy, degrade on errors
    return {
      status: elevated ? 'degraded' : 'healthy',
      errorRate: rate,
    };
  }

  if (!running) {
    return { status: 'down', errorRate: rate };
  }

  return {
    status: elevated ? 'degraded' : 'healthy',
    errorRate: rate,
  };
}
