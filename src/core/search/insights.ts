/**
 * Search insights: pure math over aggregated search rows (no DB, no network).
 * Positions are always impressions-weighted; CTR is clicks / impressions.
 */

export type QueryAgg = { key: string; clicks: number; impressions: number; positionSum: number; positionWeight: number };
export type QueryStat = { key: string; clicks: number; impressions: number; ctr: number | null; position: number | null };

export const ctrOf = (clicks: number, impressions: number): number | null => (impressions > 0 ? clicks / impressions : null);

/** Average position weighted by impressions; rows without a position are ignored. */
export function weightedPosition(rows: { impressions: number; position: number | null }[]): number | null {
  let sum = 0;
  let w = 0;
  for (const r of rows) {
    if (r.position === null || !Number.isFinite(r.position) || r.impressions <= 0) continue;
    sum += r.position * r.impressions;
    w += r.impressions;
  }
  return w > 0 ? sum / w : null;
}

export function toStat(a: QueryAgg): QueryStat {
  return { key: a.key, clicks: a.clicks, impressions: a.impressions, ctr: ctrOf(a.clicks, a.impressions), position: a.positionWeight > 0 ? a.positionSum / a.positionWeight : null };
}

/** Relative change; null when there is no baseline (never a made-up percentage). */
export function deltaPct(now: number, prev: number): number | null {
  return prev > 0 ? (now - prev) / prev : null;
}

/** Position buckets used to compare like with like (CTR depends heavily on position). */
export const POSITION_BUCKETS = [
  { key: "1", min: 0, max: 1.5 },
  { key: "2", min: 1.5, max: 2.5 },
  { key: "3", min: 2.5, max: 3.5 },
  { key: "4-5", min: 3.5, max: 5.5 },
  { key: "6-10", min: 5.5, max: 10.5 },
  { key: "11-20", min: 10.5, max: 20.5 },
  { key: "21+", min: 20.5, max: Infinity },
] as const;

export function positionBucket(position: number): string {
  return (POSITION_BUCKETS.find((b) => position >= b.min && position < b.max) ?? POSITION_BUCKETS[POSITION_BUCKETS.length - 1]).key;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Expected CTR per position bucket: the median CTR of this organisation's own
 * queries in that bucket (queries above the impressions threshold only).
 * Buckets with fewer than `minQueries` queries have no expectation.
 */
export function expectedCtrByBucket(stats: QueryStat[], opts: { minImpressions: number; minQueries?: number }): Map<string, { median: number; queries: number }> {
  const groups = new Map<string, number[]>();
  for (const s of stats) {
    if (s.impressions < opts.minImpressions || s.position === null || s.ctr === null) continue;
    const b = positionBucket(s.position);
    groups.set(b, [...(groups.get(b) ?? []), s.ctr]);
  }
  const out = new Map<string, { median: number; queries: number }>();
  for (const [b, list] of groups) if (list.length >= (opts.minQueries ?? 5)) out.set(b, { median: median(list)!, queries: list.length });
  return out;
}

export type LowCtr = QueryStat & { bucket: string; expectedCtr: number; bucketQueries: number };

/** High impressions, CTR below the median CTR of queries at a similar position. */
export function lowCtrQueries(stats: QueryStat[], opts: { minImpressions: number; minQueries?: number; limit?: number; baseline?: QueryStat[] }): LowCtr[] {
  // The expectation comes from `baseline` (e.g. all queries of the organisation) when given.
  const expected = expectedCtrByBucket(opts.baseline ?? stats, opts);
  const out: LowCtr[] = [];
  for (const s of stats) {
    if (s.impressions < opts.minImpressions || s.position === null || s.ctr === null) continue;
    const bucket = positionBucket(s.position);
    const e = expected.get(bucket);
    if (e && s.ctr < e.median) out.push({ ...s, bucket, expectedCtr: e.median, bucketQueries: e.queries });
  }
  return out.sort((a, b) => b.impressions - a.impressions).slice(0, opts.limit ?? 25);
}

/** Queries ranking between positions `min` and `max` (impressions-weighted), most impressions first. */
export function positionRange(stats: QueryStat[], opts: { min: number; max: number; minImpressions?: number; limit?: number }): QueryStat[] {
  return stats
    .filter((s) => s.position !== null && s.position >= opts.min && s.position <= opts.max && s.impressions >= (opts.minImpressions ?? 0))
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, opts.limit ?? 25);
}

export type Movement = { key: string; now: QueryStat | null; prev: QueryStat | null; clicksDelta: number; impressionsDelta: number };

/**
 * Compare two periods key by key. Growing and declining lists only consider
 * keys with at least `minImpressions` impressions in one of the periods.
 */
export function comparePeriods(now: QueryStat[], prev: QueryStat[], opts: { minImpressions: number; limit?: number }) {
  const a = new Map(now.map((s) => [s.key, s]));
  const b = new Map(prev.map((s) => [s.key, s]));
  const keys = new Set([...a.keys(), ...b.keys()]);
  const moves: Movement[] = [];
  for (const k of keys) {
    const n = a.get(k) ?? null;
    const p = b.get(k) ?? null;
    moves.push({ key: k, now: n, prev: p, clicksDelta: (n?.clicks ?? 0) - (p?.clicks ?? 0), impressionsDelta: (n?.impressions ?? 0) - (p?.impressions ?? 0) });
  }
  const limit = opts.limit ?? 25;
  const eligible = moves.filter((m) => Math.max(m.now?.impressions ?? 0, m.prev?.impressions ?? 0) >= opts.minImpressions);
  const byGrowth = (x: Movement, y: Movement) => y.clicksDelta - x.clicksDelta || y.impressionsDelta - x.impressionsDelta || x.key.localeCompare(y.key);
  const growing = eligible.filter((m) => m.now && m.prev && (m.clicksDelta > 0 || (m.clicksDelta === 0 && m.impressionsDelta > 0))).sort(byGrowth).slice(0, limit);
  const declining = eligible
    .filter((m) => m.now && m.prev && (m.clicksDelta < 0 || (m.clicksDelta === 0 && m.impressionsDelta < 0)))
    .sort((x, y) => byGrowth(y, x))
    .slice(0, limit);
  const added = eligible.filter((m) => m.now && !m.prev).sort((x, y) => (y.now!.impressions - x.now!.impressions) || x.key.localeCompare(y.key)).slice(0, limit);
  const lost = eligible.filter((m) => !m.now && m.prev).sort((x, y) => (y.prev!.impressions - x.prev!.impressions) || x.key.localeCompare(y.key)).slice(0, limit);
  return { growing, declining, added, lost };
}

/** Previous period of the same length, immediately before [start, end] (ISO days, inclusive). */
export function previousPeriod(range: { start: string; end: string }): { start: string; end: string } {
  const s = Date.parse(`${range.start}T00:00:00Z`);
  const e = Date.parse(`${range.end}T00:00:00Z`);
  const len = Math.round((e - s) / 86_400_000) + 1;
  const day = (t: number) => new Date(t).toISOString().slice(0, 10);
  return { start: day(s - len * 86_400_000), end: day(s - 86_400_000) };
}

export const RANGE_PRESETS = { "7d": 7, "28d": 28, "3m": 91, "6m": 182 } as const;
export type RangePreset = keyof typeof RANGE_PRESETS | "custom";

/**
 * Resolve a range picker value against the latest day with data (Search
 * Console lags 2 to 3 days; anchoring avoids comparing empty days).
 */
export function resolveRange(input: { preset?: string | null; start?: string | null; end?: string | null }, anchor: string): { preset: RangePreset; start: string; end: string } {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (input.preset === "custom" && input.start && input.end && iso.test(input.start) && iso.test(input.end) && input.start <= input.end) {
    const maxDays = 31 * 16;
    const span = (Date.parse(input.end) - Date.parse(input.start)) / 86_400_000;
    if (span <= maxDays) return { preset: "custom", start: input.start, end: input.end };
  }
  const preset = (input.preset && input.preset in RANGE_PRESETS ? input.preset : "28d") as keyof typeof RANGE_PRESETS;
  const days = RANGE_PRESETS[preset];
  const end = Date.parse(`${anchor}T00:00:00Z`);
  return { preset, start: new Date(end - (days - 1) * 86_400_000).toISOString().slice(0, 10), end: anchor };
}
