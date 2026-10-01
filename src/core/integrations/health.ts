/**
 * Integration health decisions (pure): scheduling with back-off, staleness,
 * status mapping and the date ranges imported by syncs and backfills.
 */

export type IntegrationStatus = "NOT_CONNECTED" | "CONNECTED" | "ERROR" | "DISABLED" | "EXPIRED";
export type HealthInput = {
  id: string;
  status: IntegrationStatus;
  consecutiveFailures: number;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastSyncAt?: Date | null;
  createdAt?: Date | null;
};

const HOUR = 3_600_000;
const DAY = 86_400_000;
export const STALE_SYNC_HOURS = 36;
/** Days re-pulled by every daily sync (late data and corrections are upserted). */
export const DAILY_SYNC_DAYS = 5;
/** Search data lags: the newest day requested is today minus this many days. */
export const SEARCH_LAG_DAYS = 2;

/** Back-off before the scheduler retries an integration in ERROR: 1 h, 2 h, 4 h … capped at 24 h. */
export function errorRetryDelayMs(consecutiveFailures: number): number {
  return Math.min(24 * HOUR, HOUR * 2 ** Math.max(0, consecutiveFailures - 1));
}

const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/**
 * Should the scheduler enqueue a sync now? CONNECTED: once per day.
 * ERROR: again after the back-off. DISABLED, EXPIRED and NOT_CONNECTED: never
 * (a human must reconnect or test first).
 */
export function syncScheduleDecision(i: HealthInput, now = new Date()): { enqueue: boolean; key: string | null; reason: string } {
  const day = isoDay(now);
  if (i.status === "CONNECTED") return { enqueue: true, key: `sync:${i.id}:${day}`, reason: "daily" };
  if (i.status === "ERROR") {
    const wait = errorRetryDelayMs(i.consecutiveFailures);
    if (i.lastFailureAt && now.getTime() - i.lastFailureAt.getTime() < wait) return { enqueue: false, key: null, reason: "backoff" };
    return { enqueue: true, key: `sync:${i.id}:${day}:retry${i.consecutiveFailures}`, reason: "retry" };
  }
  return { enqueue: false, key: null, reason: i.status.toLowerCase() };
}

/** A connected integration that has not synced successfully for 36 hours. */
export function isStaleSync(i: HealthInput, now = new Date(), hours = STALE_SYNC_HOURS): boolean {
  if (i.status !== "CONNECTED" && i.status !== "ERROR") return false;
  const last = i.lastSuccessAt ?? i.lastSyncAt ?? null;
  const ref = last ?? i.createdAt ?? null;
  if (!ref) return false;
  return now.getTime() - ref.getTime() > hours * HOUR;
}

/** Status after a connection test or sync: 401/403 means the access expired or was revoked. */
export function statusForResult(r: { ok: boolean; httpStatus?: number; authFailure?: boolean }): "CONNECTED" | "ERROR" | "EXPIRED" {
  if (r.ok) return "CONNECTED";
  return r.authFailure || r.httpStatus === 401 || r.httpStatus === 403 ? "EXPIRED" : "ERROR";
}

/** Daily sync window: the last 5 days up to today minus the provider lag. */
export function dailySyncRange(now = new Date(), days = DAILY_SYNC_DAYS): { start: string; end: string } {
  const end = new Date(now.getTime() - SEARCH_LAG_DAYS * DAY);
  return { start: isoDay(new Date(end.getTime() - (days - 1) * DAY)), end: isoDay(end) };
}

/**
 * Backfill ranges, newest first: `months` calendar months back from `end`,
 * split into calendar-month chunks (or one range when not chunked).
 * `since` (optional) limits the backfill to fill a gap.
 */
export function backfillRanges(end: string, months: number, opts: { chunked: boolean; since?: string | null } = { chunked: true }): { start: string; end: string }[] {
  const e = new Date(`${end}T00:00:00Z`);
  const startDate = new Date(Date.UTC(e.getUTCFullYear(), e.getUTCMonth() - months, e.getUTCDate() + 1));
  let start = isoDay(startDate);
  if (opts.since && opts.since > start) start = opts.since;
  if (start > end) return [];
  if (!opts.chunked) return [{ start, end }];
  const out: { start: string; end: string }[] = [];
  let cursorEnd = end;
  while (cursorEnd >= start) {
    const c = new Date(`${cursorEnd}T00:00:00Z`);
    const monthStart = isoDay(new Date(Date.UTC(c.getUTCFullYear(), c.getUTCMonth(), 1)));
    const chunkStart = monthStart < start ? start : monthStart;
    out.push({ start: chunkStart, end: cursorEnd });
    cursorEnd = isoDay(new Date(Date.parse(`${monthStart}T00:00:00Z`) - DAY));
  }
  return out;
}
