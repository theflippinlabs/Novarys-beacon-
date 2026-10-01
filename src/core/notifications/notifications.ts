import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Notifications (pure): kinds, default thresholds, signal detection math,
 * digest merging and webhook signatures. Evaluation produces signals; a
 * signal is notified once (its fingerprint is remembered), and signals of one
 * kind are merged into one digest per day, so nothing is spammed.
 */
export const NOTIFICATION_KINDS = [
  "CRITICAL_SEO_ISSUE",
  "TRAFFIC_DROP",
  "QUERY_ENTERED_TOP",
  "INTEGRATION_DISCONNECTED",
  "CRAWL_FAILED",
  "CONTENT_AWAITING_APPROVAL",
  "CONVERSION_ANOMALY",
  "HIGH_PRIORITY_OPPORTUNITY",
  "COMPETITOR_PAGE_CHANGED",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];
export const NOTIFICATION_CHANNELS = ["IN_APP", "EMAIL", "WEBHOOK"] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

/** English labels of each kind (rendered through t()). */
export const KIND_LABELS: Record<NotificationKind, string> = {
  CRITICAL_SEO_ISSUE: "Critical SEO issue",
  TRAFFIC_DROP: "Traffic drop",
  QUERY_ENTERED_TOP: "Query entered the top positions",
  INTEGRATION_DISCONNECTED: "Integration disconnected",
  CRAWL_FAILED: "Crawl failed",
  CONTENT_AWAITING_APPROVAL: "Content awaiting approval",
  CONVERSION_ANOMALY: "Conversion anomaly",
  HIGH_PRIORITY_OPPORTUNITY: "High-priority opportunity",
  COMPETITOR_PAGE_CHANGED: "Competitor page changed",
};

/** Digest titles per kind (`{n}` = number of signals in the digest). */
export const KIND_TITLES: Record<NotificationKind, string> = {
  CRITICAL_SEO_ISSUE: "New critical SEO findings: {n}",
  TRAFFIC_DROP: "Organic traffic drops detected: {n}",
  QUERY_ENTERED_TOP: "Queries that entered the top positions: {n}",
  INTEGRATION_DISCONNECTED: "Integrations to reconnect: {n}",
  CRAWL_FAILED: "Failed crawls: {n}",
  CONTENT_AWAITING_APPROVAL: "Drafts awaiting approval: {n}",
  CONVERSION_ANOMALY: "Conversion anomalies: {n}",
  HIGH_PRIORITY_OPPORTUNITY: "New high-priority opportunities: {n}",
  COMPETITOR_PAGE_CHANGED: "Competitor pages changed, to review: {n}",
};

/** Item templates (English keys, rendered through t()). */
export const ITEM_TEMPLATES = [
  "Open critical issues in the latest audit of {product}: {n}",
  "{product}: organic clicks down {pct}% week over week ({now} vs {prev})",
  "{query} ({product}) entered positions 1 to 3 (average {position})",
  "{query} ({product}) entered positions 4 to 10 (average {position})",
  "{provider} is {status}: reconnect it",
  "The crawl of {product} failed",
  "{title} is awaiting approval",
  "Conversions on {day}: {value} vs a 28-day average of {mean} (z = {z})",
  "{title} (priority {priority})",
  "{competitor}: {url} changed ({added} line(s) added, {removed} removed). Review it before updating any fact.",
] as const;

/** Item variables for display: a `status` variable is an enum value and is translated like every enum label. */
export function displayVars(t: (k: string) => string, vars: Record<string, string | number>): Record<string, string | number> {
  return typeof vars.status === "string" && vars.status ? { ...vars, status: t(vars.status.replace(/_/g, " ")) } : vars;
}

export const KIND_LINKS: Record<NotificationKind, string> = {
  CRITICAL_SEO_ISSUE: "/discovery",
  TRAFFIC_DROP: "/queries/search",
  QUERY_ENTERED_TOP: "/queries/search",
  INTEGRATION_DISCONNECTED: "/settings/integrations",
  CRAWL_FAILED: "/discovery",
  CONTENT_AWAITING_APPROVAL: "/content?status=HUMAN_APPROVAL",
  CONVERSION_ANOMALY: "/conversions",
  HIGH_PRIORITY_OPPORTUNITY: "/opportunities?potential=HIGH",
  COMPETITOR_PAGE_CHANGED: "/ai-visibility#watched-pages",
};

export type Thresholds = {
  TRAFFIC_DROP: { dropPct: number; minClicks: number };
  QUERY_ENTERED_TOP: { range: "TOP_3" | "TOP_10" | "BOTH"; minImpressions: number };
  CONVERSION_ANOMALY: { z: number; minDailyMean: number };
};
export const DEFAULT_THRESHOLDS: Thresholds = {
  TRAFFIC_DROP: { dropPct: 30, minClicks: 20 },
  QUERY_ENTERED_TOP: { range: "BOTH", minImpressions: 10 },
  CONVERSION_ANOMALY: { z: 3, minDailyMean: 5 },
};

const numIn = (v: unknown, min: number, max: number, def: number) => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

/** Thresholds from stored jsonb, clamped to sane bounds, defaults for anything missing. */
export function parseThresholds(stored: Partial<Record<NotificationKind, Record<string, unknown>>>): Thresholds {
  const d = DEFAULT_THRESHOLDS;
  const td = stored.TRAFFIC_DROP ?? {};
  const qt = stored.QUERY_ENTERED_TOP ?? {};
  const ca = stored.CONVERSION_ANOMALY ?? {};
  return {
    TRAFFIC_DROP: { dropPct: numIn(td.dropPct, 5, 95, d.TRAFFIC_DROP.dropPct), minClicks: numIn(td.minClicks, 1, 100000, d.TRAFFIC_DROP.minClicks) },
    QUERY_ENTERED_TOP: { range: qt.range === "TOP_3" || qt.range === "TOP_10" ? qt.range : "BOTH", minImpressions: numIn(qt.minImpressions, 1, 100000, d.QUERY_ENTERED_TOP.minImpressions) },
    CONVERSION_ANOMALY: { z: numIn(ca.z, 1.5, 10, d.CONVERSION_ANOMALY.z), minDailyMean: numIn(ca.minDailyMean, 1, 100000, d.CONVERSION_ANOMALY.minDailyMean) },
  };
}

/** Week-over-week drop: the share lost, when the previous week had enough clicks to judge; null otherwise. */
export function trafficDrop(now: number, prev: number, t: Thresholds["TRAFFIC_DROP"]): number | null {
  if (prev < t.minClicks || prev <= 0) return null;
  const drop = (prev - now) / prev;
  return drop * 100 >= t.dropPct ? drop : null;
}

export type PositionBand = "TOP_3" | "TOP_10";
export function positionBand(position: number | null): PositionBand | null {
  if (position === null || !Number.isFinite(position)) return null;
  if (position >= 1 && position <= 3.5) return "TOP_3";
  if (position > 3.5 && position <= 10.5) return "TOP_10";
  return null;
}

/** A query "entered" a band when it is in the band now and was in no better band before (or unranked). */
export function enteredBand(now: number | null, before: number | null, range: Thresholds["QUERY_ENTERED_TOP"]["range"]): PositionBand | null {
  const b = positionBand(now);
  if (!b) return null;
  if (range !== "BOTH" && range !== b) return null;
  const was = positionBand(before);
  if (was === b || was === "TOP_3") return null;
  return b;
}

export type Anomaly = { z: number; mean: number; sd: number; value: number; direction: "UP" | "DOWN" };

/**
 * Z-score of a day's conversions against the trailing days (default 28).
 * Needs at least 14 trailing days and a mean of at least `minDailyMean`
 * (low volumes are noise). The standard deviation is floored at the Poisson
 * deviation sqrt(mean), so a flat history does not turn any change into an
 * infinite z.
 */
export function conversionAnomaly(trailing: number[], value: number, t: Thresholds["CONVERSION_ANOMALY"]): Anomaly | null {
  if (trailing.length < 14) return null;
  const mean = trailing.reduce((a, b) => a + b, 0) / trailing.length;
  if (mean < t.minDailyMean) return null;
  const variance = trailing.reduce((a, b) => a + (b - mean) ** 2, 0) / (trailing.length - 1);
  const sd = Math.max(Math.sqrt(variance), Math.sqrt(mean));
  const z = (value - mean) / sd;
  if (Math.abs(z) < t.z) return null;
  return { z: Math.round(z * 100) / 100, mean: Math.round(mean * 100) / 100, sd: Math.round(sd * 100) / 100, value, direction: z > 0 ? "UP" : "DOWN" };
}

// ─── Signals and digests ─────────────────────────────────────────────────

export type SignalItem = { fp: string; key: string; vars: Record<string, string | number>; href: string };
export type Signal = { kind: NotificationKind; severity: Severity; item: SignalItem };
export type DigestParams = { n: number; items: SignalItem[]; signals: string[] };

const SEVERITY_ORDER: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
export const maxSeverity = (a: Severity, b: Severity): Severity => (SEVERITY_ORDER.indexOf(a) <= SEVERITY_ORDER.indexOf(b) ? a : b);
export const MAX_DIGEST_ITEMS = 50;

/** Signals not notified before (fingerprints already in a digest are dropped), deduplicated. */
export function freshSignals(signals: Signal[], notified: ReadonlySet<string>): Signal[] {
  const seen = new Set<string>();
  return signals.filter((s) => {
    if (notified.has(s.item.fp) || seen.has(s.item.fp)) return false;
    seen.add(s.item.fp);
    return true;
  });
}

/** Merge new signal items into a day's digest (the item list is capped; `n` and `signals` stay exact). */
export function mergeDigest(existing: DigestParams | null, items: SignalItem[]): DigestParams {
  const base = existing ?? { n: 0, items: [], signals: [] };
  const known = new Set(base.signals);
  const add = items.filter((i) => !known.has(i.fp));
  const signals = [...base.signals, ...add.map((i) => i.fp)];
  return { n: signals.length, items: [...base.items, ...add].slice(0, MAX_DIGEST_ITEMS), signals };
}

/** The digest link: the single item's page, else the kind's list page. */
export const digestLink = (kind: NotificationKind, p: DigestParams) => (p.items.length === 1 ? p.items[0].href : KIND_LINKS[kind]);
export const digestKey = (kind: NotificationKind, day: string) => `${kind}:${day}`;

// ─── Webhook signatures ─────────────────────────────────────────────────

/** HMAC-SHA256 over "<timestamp>.<body>"; header value "t=<timestamp>,v1=<hex>". */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  const mac = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${mac}`;
}

/** Receiver-side check (documented for integrators, used in tests): signature valid and timestamp within tolerance. */
export function verifyWebhook(secret: string, header: string, body: string, nowSec: number, toleranceSec = 300): boolean {
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const ts = Number(parts.t);
  if (!Number.isFinite(ts) || !parts.v1 || Math.abs(nowSec - ts) > toleranceSec) return false;
  const expected = Buffer.from(signWebhook(secret, ts, body).split("v1=")[1], "hex");
  const got = Buffer.from(parts.v1, "hex");
  return expected.length === got.length && timingSafeEqual(expected, got);
}
