import { describe, expect, it } from "vitest";
import {
  comparePeriods,
  ctrOf,
  deltaPct,
  expectedCtrByBucket,
  lowCtrQueries,
  median,
  positionBucket,
  positionRange,
  previousPeriod,
  resolveRange,
  toStat,
  weightedPosition,
  type QueryStat,
} from "@/core/search/insights";
import { backfillRanges, dailySyncRange, errorRetryDelayMs, isStaleSync, statusForResult, syncScheduleDecision, type HealthInput } from "@/core/integrations/health";
import { AuthExpiredError, clipBytes, IntegrationConfigError, isAuthFailure, isRetryableProviderError, ProviderHttpError, sanitizeProviderMessage, searchRow } from "@/integrations/types";
import { dedupeSearchRows, searchTotalsAsMetrics } from "@/services/search-data";

const stat = (key: string, impressions: number, clicks: number, position: number | null): QueryStat => ({ key, impressions, clicks, ctr: ctrOf(clicks, impressions), position });

describe("search insight math", () => {
  it("weights positions by impressions and ignores rows without a position", () => {
    expect(weightedPosition([{ impressions: 100, position: 2 }, { impressions: 300, position: 10 }])).toBe(8);
    expect(weightedPosition([{ impressions: 50, position: null }, { impressions: 50, position: 4 }])).toBe(4);
    expect(weightedPosition([{ impressions: 0, position: 3 }])).toBeNull();
    expect(toStat({ key: "q", clicks: 3, impressions: 60, positionSum: 600, positionWeight: 60 })).toEqual({ key: "q", clicks: 3, impressions: 60, ctr: 0.05, position: 10 });
  });

  it("never makes up a percentage without a baseline", () => {
    expect(deltaPct(120, 100)).toBeCloseTo(0.2);
    expect(deltaPct(5, 0)).toBeNull();
    expect(ctrOf(1, 0)).toBeNull();
  });

  it("buckets positions and computes medians", () => {
    expect(positionBucket(1)).toBe("1");
    expect(positionBucket(1.6)).toBe("2");
    expect(positionBucket(4.2)).toBe("4-5");
    expect(positionBucket(8)).toBe("6-10");
    expect(positionBucket(15)).toBe("11-20");
    expect(positionBucket(42)).toBe("21+");
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });

  it("expected CTR is the median CTR of the bucket, from the organisation's own data, with a minimum sample", () => {
    const stats = [stat("a", 100, 10, 2), stat("b", 100, 20, 2), stat("c", 100, 30, 2), stat("d", 100, 40, 2), stat("e", 100, 50, 2), stat("small", 5, 0, 2), stat("lonely", 100, 1, 8)];
    const exp = expectedCtrByBucket(stats, { minImpressions: 20 });
    expect(exp.get("2")).toEqual({ median: 0.3, queries: 5 });
    // Bucket 6-10 has one query only: no expectation, so no low-CTR verdict.
    expect(exp.has("6-10")).toBe(false);
    const low = lowCtrQueries(stats, { minImpressions: 20 });
    expect(low.map((l) => l.key)).toEqual(["a", "b"]);
    expect(low[0]).toMatchObject({ bucket: "2", expectedCtr: 0.3, bucketQueries: 5 });
    // A baseline (e.g. the whole organisation) can provide the expectation for a product's queries.
    expect(lowCtrQueries([stat("p", 200, 2, 2)], { minImpressions: 20, baseline: stats }).map((l) => l.key)).toEqual(["p"]);
  });

  it("lists positions 4 to 15 by impressions-weighted position", () => {
    const stats = [stat("top", 500, 50, 1.2), stat("near", 300, 6, 6.4), stat("edge", 100, 1, 15), stat("far", 900, 0, 22), stat("nearer", 400, 9, 4)];
    expect(positionRange(stats, { min: 4, max: 15 }).map((s) => s.key)).toEqual(["nearer", "near", "edge"]);
    expect(positionRange(stats, { min: 4, max: 15, minImpressions: 200 }).map((s) => s.key)).toEqual(["nearer", "near"]);
  });

  it("compares periods: growing, declining, new and lost, above the impressions threshold", () => {
    const now = [stat("up", 200, 20, 5), stat("down", 100, 2, 9), stat("fresh", 80, 4, 7), stat("tiny-new", 3, 0, 30), stat("flat-imp-up", 150, 5, 6)];
    const prev = [stat("up", 150, 10, 6), stat("down", 160, 9, 7), stat("gone", 90, 3, 8), stat("flat-imp-up", 100, 5, 6)];
    const r = comparePeriods(now, prev, { minImpressions: 20 });
    expect(r.growing.map((m) => m.key)).toEqual(["up", "flat-imp-up"]);
    expect(r.growing[0]).toMatchObject({ clicksDelta: 10, impressionsDelta: 50 });
    expect(r.declining.map((m) => m.key)).toEqual(["down"]);
    expect(r.added.map((m) => m.key)).toEqual(["fresh"]);
    expect(r.lost.map((m) => m.key)).toEqual(["gone"]);
  });

  it("previous period has the same length and ends the day before", () => {
    expect(previousPeriod({ start: "2026-09-01", end: "2026-09-28" })).toEqual({ start: "2026-08-04", end: "2026-08-31" });
    expect(previousPeriod({ start: "2026-03-01", end: "2026-03-01" })).toEqual({ start: "2026-02-28", end: "2026-02-28" });
  });

  it("resolves presets against the latest day with data and validates custom ranges", () => {
    expect(resolveRange({ preset: "7d" }, "2026-09-28")).toEqual({ preset: "7d", start: "2026-09-22", end: "2026-09-28" });
    expect(resolveRange({ preset: "28d" }, "2026-09-28").start).toBe("2026-09-01");
    expect(resolveRange({ preset: "3m" }, "2026-09-28").start).toBe("2026-06-30");
    expect(resolveRange({ preset: "custom", start: "2026-01-01", end: "2026-01-31" }, "2026-09-28")).toEqual({ preset: "custom", start: "2026-01-01", end: "2026-01-31" });
    expect(resolveRange({ preset: "custom", start: "2026-02-01", end: "2026-01-01" }, "2026-09-28").preset).toBe("28d");
    expect(resolveRange({ preset: "bogus" }, "2026-09-28").preset).toBe("28d");
  });
});

describe("normalized search rows", () => {
  it("derives CTR, clips long dimensions by bytes and treats non-positive positions as unknown", () => {
    expect(searchRow({ day: "2026-09-01", query: "q", clicks: 2, impressions: 40, position: -1 })).toEqual({ day: "2026-09-01", query: "q", page: null, country: null, device: null, clicks: 2, impressions: 40, ctr: 0.05, position: null });
    expect(searchRow({ day: "2026-09-01", country: "FRA", device: "mobile", clicks: 0, impressions: 0 })).toMatchObject({ country: "fra", device: "MOBILE", ctr: 0 });
    const long = "é".repeat(1000);
    const clipped = clipBytes(long, 601);
    expect(Buffer.byteLength(clipped)).toBeLessThanOrEqual(601);
    expect(clipped.endsWith("�")).toBe(false);
  });

  it("merges duplicate keys in one batch without double counting and keeps positions weighted", () => {
    const rows = [searchRow({ day: "2026-09-01", query: "x", clicks: 1, impressions: 10, position: 2 }), searchRow({ day: "2026-09-01", query: "x", clicks: 3, impressions: 30, position: 6 }), searchRow({ day: "2026-09-01", clicks: 9, impressions: 90, position: 4 })];
    const d = dedupeSearchRows(rows);
    expect(d).toHaveLength(2);
    expect(d.find((r) => r.query === "x")).toMatchObject({ clicks: 4, impressions: 40, ctr: 0.1, position: 5 });
    expect(searchTotalsAsMetrics(rows)).toEqual([
      { metric: "search_impressions", day: "2026-09-01", value: 90 },
      { metric: "search_clicks", day: "2026-09-01", value: 9 },
      { metric: "search_position", day: "2026-09-01", value: 4, weight: 90 },
    ]);
  });
});

describe("integration health", () => {
  const base = (over: Partial<HealthInput>): HealthInput => ({ id: "i1", status: "CONNECTED", consecutiveFailures: 0, lastSuccessAt: null, lastFailureAt: null, ...over });
  const now = new Date("2026-10-01T12:00:00Z");

  it("schedules CONNECTED daily, ERROR after a back-off, never EXPIRED or DISABLED", () => {
    expect(syncScheduleDecision(base({}), now)).toEqual({ enqueue: true, key: "sync:i1:2026-10-01", reason: "daily" });
    expect(syncScheduleDecision(base({ status: "EXPIRED" }), now).enqueue).toBe(false);
    expect(syncScheduleDecision(base({ status: "DISABLED" }), now).enqueue).toBe(false);
    expect(syncScheduleDecision(base({ status: "NOT_CONNECTED" }), now).enqueue).toBe(false);
    const err = base({ status: "ERROR", consecutiveFailures: 3, lastFailureAt: new Date(now.getTime() - 3 * 3_600_000) });
    expect(errorRetryDelayMs(3)).toBe(4 * 3_600_000);
    expect(syncScheduleDecision(err, now)).toMatchObject({ enqueue: false, reason: "backoff" });
    expect(syncScheduleDecision({ ...err, lastFailureAt: new Date(now.getTime() - 5 * 3_600_000) }, now)).toEqual({ enqueue: true, key: "sync:i1:2026-10-01:retry3", reason: "retry" });
    expect(errorRetryDelayMs(30)).toBe(24 * 3_600_000);
  });

  it("flags connected integrations without a successful sync for 36 hours", () => {
    expect(isStaleSync(base({ lastSuccessAt: new Date(now.getTime() - 37 * 3_600_000) }), now)).toBe(true);
    expect(isStaleSync(base({ lastSuccessAt: new Date(now.getTime() - 10 * 3_600_000) }), now)).toBe(false);
    expect(isStaleSync(base({ status: "DISABLED", lastSuccessAt: new Date(0) }), now)).toBe(false);
  });

  it("maps 401/403 to EXPIRED, other failures to ERROR", () => {
    expect(statusForResult({ ok: true })).toBe("CONNECTED");
    expect(statusForResult({ ok: false, httpStatus: 401 })).toBe("EXPIRED");
    expect(statusForResult({ ok: false, httpStatus: 403 })).toBe("EXPIRED");
    expect(statusForResult({ ok: false, authFailure: true })).toBe("EXPIRED");
    expect(statusForResult({ ok: false, httpStatus: 429 })).toBe("ERROR");
    expect(statusForResult({ ok: false })).toBe("ERROR");
    expect(isAuthFailure(new ProviderHttpError("x", 403, "no"))).toBe(true);
    expect(isAuthFailure(new AuthExpiredError("invalid_grant"))).toBe(true);
    expect(isRetryableProviderError(new ProviderHttpError("x", 401, "no"))).toBe(false);
    expect(isRetryableProviderError(new ProviderHttpError("x", 429, "slow down"))).toBe(true);
    expect(isRetryableProviderError(new ProviderHttpError("x", 503, "down"))).toBe(true);
    expect(isRetryableProviderError(new ProviderHttpError("x", 400, "bad"))).toBe(false);
    expect(isRetryableProviderError(new IntegrationConfigError("missing"))).toBe(false);
    expect(isRetryableProviderError(new Error("fetch failed"))).toBe(true);
  });

  it("sanitises error messages: no query strings, keys or tokens", () => {
    const msg = sanitizeProviderMessage('GET https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?siteUrl=x&apikey=SECRET123 failed apikey=SECRET123 Bearer ya29.abc {"access_token":"tok"}');
    expect(msg).not.toContain("SECRET123");
    expect(msg).not.toContain("ya29");
    expect(msg).not.toContain('"tok"');
    expect(msg).toContain("https://ssl.bing.com/webmaster/api.svc/json/GetQueryStats?[redacted]");
    expect(new ProviderHttpError("bing", 400, "bad apikey=SECRET123").message).not.toContain("SECRET123");
  });

  it("daily syncs re-pull the last 5 days; backfills cover 16 months in calendar-month chunks, newest first", () => {
    expect(dailySyncRange(now)).toEqual({ start: "2026-09-25", end: "2026-09-29" });
    const chunks = backfillRanges("2026-09-29", 16, { chunked: true });
    expect(chunks[0]).toEqual({ start: "2026-09-01", end: "2026-09-29" });
    expect(chunks[1]).toEqual({ start: "2026-08-01", end: "2026-08-31" });
    expect(chunks.at(-1)).toEqual({ start: "2025-05-30", end: "2025-05-31" });
    expect(chunks).toHaveLength(17);
    // Contiguous, no overlap, no gap.
    for (let i = 1; i < chunks.length; i++) expect(new Date(Date.parse(`${chunks[i - 1].start}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10)).toBe(chunks[i].end);
    expect(backfillRanges("2026-09-29", 6, { chunked: false })).toEqual([{ start: "2026-03-30", end: "2026-09-29" }]);
    expect(backfillRanges("2026-09-29", 16, { chunked: true, since: "2026-08-15" })).toEqual([
      { start: "2026-09-01", end: "2026-09-29" },
      { start: "2026-08-15", end: "2026-08-31" },
    ]);
  });
});
