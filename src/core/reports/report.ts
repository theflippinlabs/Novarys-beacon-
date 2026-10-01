/**
 * Weekly executive report (pure). The stored payload holds measured data
 * only: metric keys, English label keys, states and numbers. Every label is
 * rendered through t() at display or export time, so one stored report reads
 * in English or French. A metric that is not connected or has no data keeps
 * that state; it is never shown as 0.
 */

export const REPORT_SECTIONS = ["DISCOVERY", "VISIBILITY", "CONTENT", "CONVERSION", "REVENUE", "AI_OBSERVATIONS", "OPPORTUNITIES", "EXPERIMENTS", "RISKS", "NEXT_ACTIONS"] as const;
export type SectionKey = (typeof REPORT_SECTIONS)[number];

/** Section titles (English keys, rendered through t()). */
export const SECTION_TITLES: Record<SectionKey, string> = {
  DISCOVERY: "Discovery",
  VISIBILITY: "Visibility",
  CONTENT: "Content",
  CONVERSION: "Conversion",
  REVENUE: "Revenue",
  AI_OBSERVATIONS: "AI observations",
  OPPORTUNITIES: "Opportunities",
  EXPERIMENTS: "Experiments",
  RISKS: "Risks",
  NEXT_ACTIONS: "Next actions",
};

export type MetricState = "OK" | "NOT_CONNECTED" | "NO_DATA_YET";
export type MetricUnit = "count" | "money" | "percent" | "score" | "position" | "observed";
export type ReportMetric = {
  key: string;
  /** English label key. */
  label: string;
  state: MetricState;
  unit: MetricUnit;
  now: number | null;
  /** Previous period; null when the metric is a current state (no comparison) or not measured. */
  prev: number | null;
  currency?: string | null;
  /** For sampled observations: "observed in {now} of {of}" answers. */
  of?: { now: number; prev: number | null };
  /** English source key. */
  source?: string;
};
/** `label` is an English template rendered with `vars`; `text` is user data shown as is (titles, names). */
export type ReportItem = { label: string; vars?: Record<string, string | number>; text?: string; href?: string };
export type ReportSection = { key: SectionKey; metrics: ReportMetric[]; items: ReportItem[] };
export type ReportScope = { productId: string | null; name: string; slug: string | null; sections: ReportSection[] };
export type Period = { start: string; end: string };
export type ReportPayload = { version: 1; period: Period; previous: Period; generatedAt: string; scopes: ReportScope[] };

/** Every metric label a report can contain (each needs a French entry; the integration test checks generated reports against this list). */
export const REPORT_METRIC_LABELS = [
  "Organic clicks",
  "Organic impressions",
  "Click-through rate",
  "Average position",
  "Branded impressions",
  "AI referrals (Beacon tracker)",
  "AI referral sessions (GA4)",
  "Beacon Score",
  "Indexable pages",
  "Covered queries",
  "Open critical SEO issues",
  "Published in period",
  "Drafts awaiting approval",
  "Drafts blocked by checks",
  "Visitors",
  "Signups",
  "Trials",
  "Activations",
  "Conversion rate",
  "New subscriptions",
  "Revenue in period",
  "New MRR via Beacon channels",
  "MRR",
  "Sampled answers mentioning the product",
  "Sampled answers mentioning a product",
  "Sampled answers citing your own domain",
  "Open opportunities",
  "New opportunities",
  "Opportunities done",
  "Running experiments",
  "Ready for review",
  "Concluded in period",
] as const;

/** Every item template a report can contain (each needs a French entry). */
export const REPORT_ITEM_TEMPLATES = [
  "{title} (priority {priority})",
  "{name}: {status}",
  "{provider} integration is {status}",
  "Open critical SEO issues: {n}",
  "Organic clicks fell {pct}% vs the previous period",
  "Background jobs failed after all retries: {n}",
  "Drafts blocked by fact or SEO checks: {n}",
  "Not measured: connect {source}",
  "No risk detected in measured data",
  "No action pending",
  "No experiment running",
  "Fix the critical SEO issues on {subject} ({n})",
  "Reconnect {subject} ({status})",
  "Resolve the high-severity fact-check blockers in {subject} ({n})",
  "Review {subject}",
  "{subject}",
] as const;

export const metric = (key: string, label: string, unit: MetricUnit, v: { state: MetricState; now: number | null; prev: number | null }, extra: Partial<ReportMetric> = {}): ReportMetric =>
  v.state === "OK" ? { key, label, unit, state: "OK", now: v.now, prev: v.prev, ...extra } : { key, label, unit, state: v.state, now: null, prev: null, ...extra };

/** Relative change; null when not comparable (unmeasured, no previous value, or previous 0). */
export function changePct(now: number | null, prev: number | null): number | null {
  if (now === null || prev === null || prev === 0) return null;
  return (now - prev) / prev;
}

/** Sampled AI observations: "observed in X of Y" with the previous period; NO_DATA_YET without samples. */
export function observedMetric(key: string, label: string, aiState: MetricState, now: { x: number; y: number }, prev: { x: number; y: number }): ReportMetric {
  if (aiState !== "OK") return metric(key, label, "observed", { state: aiState, now: null, prev: null }, { source: "Sampled AI tests (observations, not totals)" });
  if (now.y === 0 && prev.y === 0) return metric(key, label, "observed", { state: "NO_DATA_YET", now: null, prev: null }, { source: "Sampled AI tests (observations, not totals)" });
  return { key, label, unit: "observed", state: "OK", now: now.x, prev: prev.y ? prev.x : null, of: { now: now.y, prev: prev.y || null }, source: "Sampled AI tests (observations, not totals)" };
}

/** Money KPI per currency (never summed across currencies) to one metric per currency. */
export function moneyMetrics(key: string, label: string, v: { state: MetricState; byCurrency?: { currency: string; now: number; prev: number | null }[] }, withPrev = true): ReportMetric[] {
  if (v.state !== "OK") return [metric(key, label, "money", { state: v.state, now: null, prev: null })];
  if (!v.byCurrency?.length) return [metric(key, label, "money", { state: "NO_DATA_YET", now: null, prev: null })];
  return v.byCurrency.map((c) => metric(`${key}:${c.currency}`, label, "money", { state: "OK", now: c.now, prev: withPrev ? c.prev : null }, { currency: c.currency }));
}

/** Risks from measured facts only; unmeasured traffic is reported as such, never as "no drop". */
export function riskItems(input: { integrations: { provider: string; status: string }[]; criticalIssues: number | null; clicks: { state: MetricState; now: number | null; prev: number | null }; failedJobs: number; blockedDrafts: number; dropThreshold?: number }): ReportItem[] {
  const out: ReportItem[] = [];
  for (const i of input.integrations) out.push({ label: "{provider} integration is {status}", vars: { provider: i.provider, status: i.status }, href: "/settings/integrations" });
  if (input.criticalIssues) out.push({ label: "Open critical SEO issues: {n}", vars: { n: input.criticalIssues }, href: "/discovery" });
  const c = changePct(input.clicks.now, input.clicks.prev);
  if (input.clicks.state === "OK" && c !== null && c <= -(input.dropThreshold ?? 0.3)) out.push({ label: "Organic clicks fell {pct}% vs the previous period", vars: { pct: Math.round(-c * 100) }, href: "/queries/search" });
  if (input.clicks.state === "NOT_CONNECTED") out.push({ label: "Not measured: connect {source}", vars: { source: "Search Console / Bing" }, href: "/settings/integrations" });
  if (input.failedJobs) out.push({ label: "Background jobs failed after all retries: {n}", vars: { n: input.failedJobs }, href: "/settings/health" });
  if (input.blockedDrafts) out.push({ label: "Drafts blocked by fact or SEO checks: {n}", vars: { n: input.blockedDrafts }, href: "/content" });
  if (!out.length) out.push({ label: "No risk detected in measured data" });
  return out;
}

// ─── Export ─────────────────────────────────────────────────────────────

type Tr = (key: string, vars?: Record<string, string | number>) => string;

/** CSV cells: quoted, doubled quotes, and a leading quote on formula-like values (CSV injection). */
export function csvCell(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return "";
  let s = String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) || s !== String(v) ? `"${s.replace(/"/g, '""')}"` : s;
}

const major = (m: ReportMetric, v: number | null) => (v === null ? null : m.unit === "money" ? v / 100 : m.unit === "percent" ? Math.round(v * 10000) / 100 : Math.round(v * 100) / 100);
const stateLabel = (t: Tr, s: MetricState) => (s === "NOT_CONNECTED" ? t("Not connected") : s === "NO_DATA_YET" ? t("No data yet") : t("Measured"));
/** Item text; a `status` variable is an enum value and is translated like every enum label. */
export const itemText = (t: Tr, i: ReportItem) => i.text ?? t(i.label, i.vars && typeof i.vars.status === "string" && i.vars.status ? { ...i.vars, status: t(i.vars.status.replace(/_/g, " ")) } : i.vars);

/** One row per metric and item: scope, section, label, state, currency, now, previous, change %, observed of. */
export function reportToCsv(r: ReportPayload, t: Tr): string {
  const rows: (string | number | null)[][] = [[t("Scope"), t("Section"), t("Metric"), t("State"), t("Currency"), t("Current period"), t("Previous period"), t("Change %"), t("Sample size")]];
  for (const s of r.scopes)
    for (const sec of s.sections) {
      for (const m of sec.metrics) {
        const c = changePct(m.now, m.prev);
        rows.push([s.name, t(SECTION_TITLES[sec.key]), t(m.label), stateLabel(t, m.state), m.currency ?? "", major(m, m.now), major(m, m.prev), c === null ? null : Math.round(c * 1000) / 10, m.of ? m.of.now : null]);
      }
      for (const i of sec.items) rows.push([s.name, t(SECTION_TITLES[sec.key]), itemText(t, i), "", "", null, null, null, null]);
    }
  return `${rows.map((r) => r.map(csvCell).join(",")).join("\r\n")}\r\n`;
}

const mdEscape = (s: string) => s.replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Value formatting shared by the Markdown export and the HTML view. */
export function formatMetric(m: ReportMetric, v: number | null, intl: string, t: Tr): string {
  if (m.state !== "OK") return stateLabel(t, m.state);
  if (v === null) return t("n/a");
  switch (m.unit) {
    case "money":
      return m.currency ? new Intl.NumberFormat(intl, { style: "currency", currency: m.currency, maximumFractionDigits: 0 }).format(v / 100) : new Intl.NumberFormat(intl, { maximumFractionDigits: 2 }).format(v / 100);
    case "percent":
      return new Intl.NumberFormat(intl, { style: "percent", maximumFractionDigits: 2 }).format(v);
    case "position":
    case "score":
      return new Intl.NumberFormat(intl, { maximumFractionDigits: 1 }).format(v);
    default:
      return new Intl.NumberFormat(intl, { maximumFractionDigits: 1 }).format(v);
  }
}

export function formatChange(m: ReportMetric, intl: string, t: Tr): string {
  if (m.state !== "OK" || m.prev === null) return t("n/a");
  const c = changePct(m.now, m.prev);
  if (c === null) return m.now === m.prev ? t("no change") : t("new");
  return new Intl.NumberFormat(intl, { style: "percent", signDisplay: "exceptZero", maximumFractionDigits: 1 }).format(c);
}

export function metricValue(m: ReportMetric, intl: string, t: Tr): string {
  const v = formatMetric(m, m.now, intl, t);
  return m.unit === "observed" && m.state === "OK" && m.of ? t("observed in {x} of {y} sampled answers", { x: v, y: m.of.now }) : v;
}
export function metricPrev(m: ReportMetric, intl: string, t: Tr): string {
  if (m.state === "OK" && m.prev === null) return t("n/a");
  const v = formatMetric(m, m.prev, intl, t);
  return m.unit === "observed" && m.state === "OK" && m.of?.prev ? t("observed in {x} of {y} sampled answers", { x: v, y: m.of.prev }) : v;
}

export function reportToMarkdown(r: ReportPayload, t: Tr, intl = "en-GB"): string {
  const out: string[] = [`# ${t("Weekly executive report")}`, "", t("Period {start} to {end}, compared with {pstart} to {pend}.", { start: r.period.start, end: r.period.end, pstart: r.previous.start, pend: r.previous.end }), ""];
  for (const s of r.scopes) {
    out.push(`## ${mdEscape(s.productId ? s.name : t("Organisation total"))}`, "");
    for (const sec of s.sections) {
      out.push(`### ${t(SECTION_TITLES[sec.key])}`, "");
      if (sec.metrics.length) {
        out.push(`| ${t("Metric")} | ${t("Current period")} | ${t("Previous period")} | ${t("Change")} |`, "| --- | --- | --- | --- |");
        for (const m of sec.metrics) out.push(`| ${mdEscape(t(m.label))}${m.currency ? ` (${m.currency})` : ""} | ${mdEscape(metricValue(m, intl, t))} | ${mdEscape(metricPrev(m, intl, t))} | ${mdEscape(formatChange(m, intl, t))} |`);
        out.push("");
      }
      for (const i of sec.items) out.push(`- ${mdEscape(itemText(t, i))}`);
      if (sec.items.length) out.push("");
    }
  }
  return `${out.join("\n").trimEnd()}\n`;
}
