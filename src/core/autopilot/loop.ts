import type { ContentType } from "@/core/content/types";
import { normalizeQuery, tokens } from "@/core/util/text";

/**
 * Autopilot loop (pure parts): OBSERVE → ANALYZE → IDENTIFY → RECOMMEND →
 * APPROVE → EXECUTE → MEASURE → LEARN.
 *
 * - Every recommendation carries a dedupe key (one open copy at a time).
 * - Approval dispatches a SAFE execution (a draft, an experiment draft, a
 *   verified-domain audit, distribution targets, or a manual task). Nothing
 *   is ever published or submitted externally by the autopilot.
 * - Measurement compares the target's metric after execution with the
 *   baseline recorded at approval: correlation, not causation.
 * - Learning keeps a per-type tally of outcomes and nudges that type's
 *   confidence factor by at most one point.
 */

export type ExecutionAction = "CREATE_CONTENT" | "CREATE_EXPERIMENT" | "QUEUE_AUDIT" | "PREPARE_DISTRIBUTION" | "MANUAL";
export type MeasureKind = "SEARCH" | "CONVERSIONS" | "AI_REFERRALS";
export type SnapshotState = "OK" | "NOT_CONNECTED" | "NO_DATA_YET";
export type OutcomeLabel = "IMPROVED" | "NO_CHANGE" | "DECLINED" | "INSUFFICIENT_DATA";
export type LoopStage = "PROPOSED" | "APPROVED" | "EXECUTING" | "MEASURING" | "MEASURED" | "REJECTED" | "DONE";

/** What a recommendation is about: the product, and the queries, pages or paths its metric is scoped to. */
export type RecommendationTarget = { productId?: string | null; opportunityType?: string; queries?: string[]; pages?: string[]; pagePaths?: string[]; clusterId?: string; domain?: string };

export type MetricValue = { key: "clicks" | "impressions" | "conversions" | "ai_referrals"; value: number };
export type DayWindow = { start: string; end: string; days: number };
/** Metric values for a window, with the source they come from and the data state. */
export type MeasurementSnapshot = { kind: MeasureKind; state: SnapshotState; window: DayWindow; metrics: MetricValue[]; source: string; scope: string; takenAt: string };

export type PageStructure = {
  title: string;
  description: string;
  faq: string[];
  schemaTypes: string[];
  internalLinks: { from: string; anchor: string }[];
  cta: { label: string; url: string } | null;
  /** Social drafts made by repurposing, only after a human approved the main asset. */
  supportingDrafts: { type: ContentType; when: "AFTER_MAIN_ASSET_APPROVAL" }[];
};

export type ExecutionPlan = {
  action: ExecutionAction;
  measure: MeasureKind;
  contentType?: ContentType;
  page?: PageStructure;
  experiment?: { name: string; hypothesis: string; primaryMetric: string; metricKey: string | null; signalToMonitor: string };
  /** Human steps (always shown: approval, publication and submission stay human). */
  steps: string[];
};

export type ExecutedRef = { type: "content_asset" | "experiment" | "seo_audit" | "distribution_target" | "task"; id?: string; href: string; label: string; status: "DONE" | "SKIPPED"; reason?: string };

export type RecommendationOutcome = {
  label: OutcomeLabel;
  primary: MetricValue["key"];
  before: number | null;
  after: number | null;
  change: number | null;
  baselineWindow: DayWindow | null;
  measuredWindow: DayWindow | null;
  reason: "MEASURED" | "NOT_CONNECTED" | "NO_DATA_YET" | "LOW_VOLUME";
  source: string;
  note: string;
};

export const MEASURE_AFTER_DAYS = 28;
export const BASELINE_DAYS = 28;
export const CHANGE_THRESHOLD = 0.1;
export const MIN_VOLUME: Record<MetricValue["key"], number> = { clicks: 20, impressions: 100, conversions: 10, ai_referrals: 10 };
export const CORRELATION_NOTE = "Correlation, not causation: other changes in the same window (seasonality, ranking updates, other releases) can explain the difference.";

const ACTION_BY_TYPE: Record<string, ExecutionAction> = {
  CONTENT_GAP: "CREATE_CONTENT",
  AI_VISIBILITY_GAP: "CREATE_CONTENT",
  STRIKING_DISTANCE: "CREATE_CONTENT",
  CONVERSION: "CREATE_EXPERIMENT",
  TECHNICAL: "QUEUE_AUDIT",
  INTERNAL_LINKING: "QUEUE_AUDIT",
  VISIBILITY_DROP: "QUEUE_AUDIT",
  DISTRIBUTION: "PREPARE_DISTRIBUTION",
  CITATION: "PREPARE_DISTRIBUTION",
};

const MEASURE_BY_TYPE: Record<string, MeasureKind> = {
  CONTENT_GAP: "SEARCH",
  STRIKING_DISTANCE: "SEARCH",
  LOW_CTR: "SEARCH",
  TECHNICAL: "SEARCH",
  INTERNAL_LINKING: "SEARCH",
  VISIBILITY_DROP: "SEARCH",
  AI_VISIBILITY_GAP: "AI_REFERRALS",
  CITATION: "AI_REFERRALS",
  PRODUCT_KNOWLEDGE: "AI_REFERRALS",
  COMPARISON_FACTS: "AI_REFERRALS",
  CONVERSION: "CONVERSIONS",
  DISTRIBUTION: "CONVERSIONS",
  CROSS_SELL: "CONVERSIONS",
  REFERRAL: "CONVERSIONS",
};

export const executionActionFor = (type: string): ExecutionAction => ACTION_BY_TYPE[type] ?? "MANUAL";
export const measureKindFor = (type: string): MeasureKind => MEASURE_BY_TYPE[type] ?? "SEARCH";
export const primaryMetric = (kind: MeasureKind): MetricValue["key"] => (kind === "SEARCH" ? "clicks" : kind === "CONVERSIONS" ? "conversions" : "ai_referrals");

/** The draft format for a content opportunity (parsed from the asset named in its title; default landing page). */
export function contentTypeFor(type: string, title: string): ContentType {
  if (type === "AI_VISIBILITY_GAP") return "FAQ";
  if (type === "STRIKING_DISTANCE") return "ARTICLE";
  const m = /^Create an? (.+?) for the "/.exec(title);
  const asset = m?.[1]?.toLowerCase() ?? "";
  if (asset === "faq") return "FAQ";
  if (asset === "guide") return "ARTICLE";
  if (asset === "comparison page" || asset === "alternatives page") return "COMPARISON";
  return "LANDING_PAGE";
}

/** Dedupe key: one open recommendation per opportunity, or per finding (product, kind, title). */
export const dedupeKeyFor = (r: { opportunityId?: string | null; productId?: string | null; kind: string; title: string }) =>
  r.opportunityId ? `opp:${r.opportunityId}` : `finding:${r.productId ?? "org"}:${r.kind}:${r.title.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200)}`;

const QUESTION = /^(how|what|why|when|where|which|who|can|does|do|is|are|should|will)\b/i;
const SCHEMA_BY_TYPE: Partial<Record<ContentType, string>> = { FAQ: "FAQPage", ARTICLE: "Article", TUTORIAL: "HowTo", COMPARISON: "WebPage", LANDING_PAGE: "SoftwareApplication" };

/**
 * Page structure for a query-cluster content gap: title, meta description,
 * FAQ from the cluster's question-shaped queries, schema types, internal
 * links from crawled pages that already mention the topic, the product's
 * primary CTA, and social drafts to repurpose once the page is approved. A
 * plan only: nothing here is a product claim, and a human edits the draft.
 */
export function pageStructurePlan(input: {
  productName: string;
  topic: string;
  contentType: ContentType;
  queries: string[];
  crawledPages: { url: string; title: string | null; text: string }[];
  cta: { label: string; url: string } | null;
}): PageStructure {
  const topic = input.topic.trim();
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  const faq = [...new Set(input.queries.map((q) => q.trim()).filter((q) => QUESTION.test(q)))].slice(0, 6).map((q) => cap(q.endsWith("?") ? q : `${q}?`));
  const phrases = [...new Set([topic, ...input.queries].map((q) => normalizeQuery(q)).filter((q) => q.length >= 3))];
  const topicTokens = new Set(tokens(topic));
  const internalLinks: PageStructure["internalLinks"] = [];
  for (const p of input.crawledPages) {
    const hay = normalizeQuery(`${p.title ?? ""} ${p.text}`);
    const phrase = phrases.find((ph) => hay.includes(ph));
    const tokenHit = !phrase && topicTokens.size >= 2 && [...topicTokens].every((tk) => hay.includes(tk));
    if (phrase || tokenHit) internalLinks.push({ from: p.url, anchor: phrase ?? topic.toLowerCase() });
    if (internalLinks.length >= 5) break;
  }
  const schema = SCHEMA_BY_TYPE[input.contentType] ?? "WebPage";
  return {
    title: `${cap(topic)} | ${input.productName}`.slice(0, 70),
    description: `${input.productName} and ${topic}: what it does, how it works and answers to common questions.`.slice(0, 160),
    faq,
    schemaTypes: faq.length && schema !== "FAQPage" ? [schema, "FAQPage"] : [schema],
    internalLinks,
    cta: input.cta,
    supportingDrafts: [
      { type: "LINKEDIN_POST", when: "AFTER_MAIN_ASSET_APPROVAL" },
      { type: "X_POST", when: "AFTER_MAIN_ASSET_APPROVAL" },
    ],
  };
}

/** The topic named in an opportunity title ("Create a guide for the "x" topic" → x; "Cover "q"" → q). */
export const topicOf = (title: string) => /"([^"]+)"/.exec(title)?.[1] ?? title;

/** Execution plan for an approved recommendation (pure; the service performs it). */
export function planExecution(rec: { kind: string; title: string }, ctx: { productName?: string | null; queries?: string[]; crawledPages?: { url: string; title: string | null; text: string }[]; cta?: { label: string; url: string } | null } = {}): ExecutionPlan {
  const action = executionActionFor(rec.kind);
  const measure = measureKindFor(rec.kind);
  if (action === "CREATE_CONTENT") {
    const contentType = contentTypeFor(rec.kind, rec.title);
    const page =
      rec.kind === "CONTENT_GAP" && ctx.productName
        ? pageStructurePlan({ productName: ctx.productName, topic: topicOf(rec.title), contentType, queries: ctx.queries ?? [], crawledPages: ctx.crawledPages ?? [], cta: ctx.cta ?? null })
        : undefined;
    return {
      action,
      measure,
      contentType,
      page,
      steps: ["Review the generated draft and its fact check.", "Approve the draft (a human decision).", "Publish it, or export it for your own site.", ...(page ? ["Repurpose it into social drafts once approved."] : [])],
    };
  }
  if (action === "CREATE_EXPERIMENT")
    return {
      action,
      measure,
      experiment: {
        name: `CTA test: ${topicOf(rec.title).replace(/^Improve CTA on /, "")}`.slice(0, 160),
        hypothesis: "An above-the-fold CTA that matches the visitor's intent raises the CTA click rate on this page.",
        primaryMetric: "CTA click rate",
        metricKey: "CTA_CLICK",
        signalToMonitor: "CTA_CLICK / PAGE_VIEW per variant",
      },
      steps: ["Describe the control and the variant.", "Compute the minimum sample size.", "Tag events with properties.experiment and properties.variant, then start the experiment."],
    };
  if (action === "QUEUE_AUDIT") return { action, measure, steps: ["Fix the issues on your site.", "Review the new audit (verified domains only)."] };
  if (action === "PREPARE_DISTRIBUTION") return { action, measure, steps: ["Review the suggested venues.", "Prepare a listing draft per venue (human approval).", "Submit it yourself once approved."] };
  return { action, measure, steps: [rec.kind === "LOW_CTR" ? "Rewrite the title and meta description of the ranking page." : "Follow the opportunity's next action."] };
}

/** Today + n days as YYYY-MM-DD (UTC). */
export function dayPlus(d: Date, n: number): string {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
}

export function windowOf(start: string, end: string): DayWindow {
  return { start, end, days: Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1 };
}

/** Baseline window: the BASELINE_DAYS full days before approval. Measured window: from execution to the day before measure_after. */
export const baselineWindow = (approvedAt: Date) => windowOf(dayPlus(approvedAt, -BASELINE_DAYS), dayPlus(approvedAt, -1));
export const measuredWindow = (executedAt: Date, measureAfter: string) => windowOf(dayPlus(executedAt, 0), dayPlus(new Date(`${measureAfter}T00:00:00Z`), -1));

/**
 * Outcome of a measured recommendation. Per-day rates are compared when the
 * windows differ in length. Below the minimum volume, or without connected
 * data, the outcome is INSUFFICIENT_DATA. Always labelled as correlation.
 */
export function labelOutcome(baseline: MeasurementSnapshot | null, measured: MeasurementSnapshot): RecommendationOutcome {
  const key = primaryMetric(measured.kind);
  const common = { primary: key, baselineWindow: baseline?.window ?? null, measuredWindow: measured.window, source: measured.source, note: CORRELATION_NOTE };
  const bad = [baseline?.state, measured.state].find((s) => s && s !== "OK") as SnapshotState | undefined;
  if (!baseline || bad) return { ...common, label: "INSUFFICIENT_DATA", before: null, after: null, change: null, reason: bad === "NOT_CONNECTED" ? "NOT_CONNECTED" : "NO_DATA_YET" };
  const get = (s: MeasurementSnapshot) => s.metrics.find((m) => m.key === key)?.value ?? 0;
  const before = get(baseline);
  const after = get(measured);
  // Windows of different lengths: the measured value is scaled to the baseline's length (same per-day rate).
  const b = before;
  const a = baseline.window.days !== measured.window.days ? (after / Math.max(1, measured.window.days)) * baseline.window.days : after;
  if (Math.max(before, after) < MIN_VOLUME[key]) return { ...common, label: "INSUFFICIENT_DATA", before, after, change: null, reason: "LOW_VOLUME" };
  if (b === 0) return { ...common, label: "IMPROVED", before, after, change: null, reason: "MEASURED" };
  const change = (a - b) / b;
  const label: OutcomeLabel = change > CHANGE_THRESHOLD ? "IMPROVED" : change < -CHANGE_THRESHOLD ? "DECLINED" : "NO_CHANGE";
  return { ...common, label, before, after, change: Math.round(change * 1000) / 1000, reason: "MEASURED" };
}

// ─── Learning ───────────────────────────────────────────────────────────────

export type LearningTally = { improved: number; noChange: number; declined: number; insufficient?: number };
export const LEARNING_MIN_OUTCOMES = 3;
/** The confidence factor of a type moves by at most this many points (and stays within 1 to 5). */
export const LEARNING_BOUND = 1;

export function addOutcome(t: LearningTally, label: OutcomeLabel): LearningTally {
  return {
    improved: t.improved + (label === "IMPROVED" ? 1 : 0),
    noChange: t.noChange + (label === "NO_CHANGE" ? 1 : 0),
    declined: t.declined + (label === "DECLINED" ? 1 : 0),
    insufficient: (t.insufficient ?? 0) + (label === "INSUFFICIENT_DATA" ? 1 : 0),
  };
}

/**
 * Confidence adjustment for an opportunity type from its measured outcomes
 * (INSUFFICIENT_DATA does not count). Needs LEARNING_MIN_OUTCOMES decisive
 * outcomes; then the balance (improved - declined) / outcomes moves the
 * factor by ±1 when it is at least one half, never more (LEARNING_BOUND).
 */
export function learningAdjustment(t: LearningTally | null | undefined): { delta: number; rationale: string | null } {
  if (!t) return { delta: 0, rationale: null };
  const n = t.improved + t.noChange + t.declined;
  if (n < LEARNING_MIN_OUTCOMES) return { delta: 0, rationale: n ? `Autopilot learning: ${n} measured outcome(s) for this type so far; at least ${LEARNING_MIN_OUTCOMES} are needed before confidence is adjusted.` : null };
  const balance = (t.improved - t.declined) / n;
  const delta = Math.max(-LEARNING_BOUND, Math.min(LEARNING_BOUND, balance >= 0.5 ? 1 : balance <= -0.5 ? -1 : 0));
  const sign = delta > 0 ? "+1" : delta < 0 ? "-1" : "0";
  return {
    delta,
    rationale: `Autopilot learning: ${t.improved} improved, ${t.noChange} unchanged and ${t.declined} declined out of ${n} measured outcomes for this type; confidence adjusted by ${sign} (bounded to ±${LEARNING_BOUND}, correlation only).`,
  };
}

/** Where a recommendation is in the loop. `artefactsPending`: its draft, experiment or audit still awaits a human or the worker. */
export function loopStage(r: { status: string; executedAt: Date | null; outcomeLabel: string | null }, artefactsPending = false): LoopStage {
  if (r.status === "REJECTED") return "REJECTED";
  if (r.outcomeLabel) return "MEASURED";
  if (r.status === "PROPOSED") return "PROPOSED";
  if (!r.executedAt) return r.status === "DONE" ? "DONE" : "APPROVED";
  return artefactsPending ? "EXECUTING" : "MEASURING";
}
