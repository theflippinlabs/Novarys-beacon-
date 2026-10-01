/**
 * In-process operational metrics (per instance): API latency and job
 * durations. Exposed on the System Health page and /api/health/metrics.
 * For fleet-wide metrics, ship the structured logs to your log platform.
 */
type Hist = { count: number; sum: number; max: number; buckets: number[]; errors: number };
const BOUNDS = [50, 100, 250, 500, 1000, 2500, 5000, 10000];
const g = globalThis as unknown as { beaconMetrics?: { routes: Map<string, Hist>; jobs: Map<string, Hist & { dead: number }>; startedAt: number } };
const store = () => (g.beaconMetrics ??= { routes: new Map(), jobs: new Map(), startedAt: Date.now() });

function observe(h: Hist, ms: number) {
  h.count++;
  h.sum += ms;
  h.max = Math.max(h.max, ms);
  const i = BOUNDS.findIndex((b) => ms <= b);
  h.buckets[i === -1 ? BOUNDS.length : i]++;
}
const empty = (): Hist => ({ count: 0, sum: 0, max: 0, buckets: new Array(BOUNDS.length + 1).fill(0), errors: 0 });

export function recordRequest(route: string, status: number, ms: number) {
  const s = store();
  const h = s.routes.get(route) ?? empty();
  observe(h, ms);
  if (status >= 500) h.errors++;
  s.routes.set(route, h);
}

export function recordJobMetric(type: string, outcome: "SUCCEEDED" | "FAILED" | "DEAD", ms: number) {
  const s = store();
  const h = s.jobs.get(type) ?? { ...empty(), dead: 0 };
  observe(h, ms);
  if (outcome !== "SUCCEEDED") h.errors++;
  if (outcome === "DEAD") h.dead++;
  s.jobs.set(type, h);
}

function percentile(h: Hist, p: number) {
  const target = h.count * p;
  let acc = 0;
  for (let i = 0; i < h.buckets.length; i++) {
    acc += h.buckets[i];
    if (acc >= target) return i < BOUNDS.length ? BOUNDS[i] : h.max;
  }
  return h.max;
}

export type RouteStat = { count: number; avgMs: number; p95Ms: number; maxMs: number; errors: number };

export function snapshot(): { since: string; routes: Record<string, RouteStat>; jobs: Record<string, RouteStat & { dead: number }> } {
  const s = store();
  const fmt = (h: Hist): RouteStat => ({ count: h.count, avgMs: h.count ? Math.round(h.sum / h.count) : 0, p95Ms: percentile(h, 0.95), maxMs: Math.round(h.max), errors: h.errors });
  return {
    since: new Date(s.startedAt).toISOString(),
    routes: Object.fromEntries([...s.routes.entries()].map(([k, h]) => [k, fmt(h)])),
    jobs: Object.fromEntries([...s.jobs.entries()].map(([k, h]) => [k, { ...fmt(h), dead: h.dead }])),
  };
}

/** Wrap a route handler to record latency and status. */
export function instrument<A extends unknown[]>(route: string, fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    const t0 = performance.now();
    let status = 500;
    try {
      const res = await fn(...args);
      status = res.status;
      return res;
    } finally {
      recordRequest(route, status, performance.now() - t0);
    }
  };
}
