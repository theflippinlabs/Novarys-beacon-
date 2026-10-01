import { SEVERITY_PENALTY, type Severity } from "@/core/seo/analyze";
import { round } from "@/core/util/text";

export type ScoreInput = {
  /** Verification-weighted entity completeness 0..1 (computeCompleteness: verified facts count fully, unverified half). */
  completeness: number;
  audit: { openIssues: Record<Severity, number>; pagesCrawled: number; ageDays: number } | null;
  pages: { planned: number; published: number; productPagePublished: boolean; answerPagesPublished: number; comparisonPlanned: number; comparisonPublished: number };
  authority: {
    verifiedProofs: number;
    sources: number;
    /** null = no backlink measurement (Bing not connected, or connected without link data yet): not measurable. */
    referringDomains: number | null;
    /** Where and when `referringDomains` was measured (shown in the line's explanation). */
    backlinks?: { source: string; asOf: string; inboundLinks: number | null } | null;
    /** AI visibility, scoped to this product's own prompts. */
    ai: { providerConfigured: boolean; tests90d: number; testsMentioning90d: number };
  };
  queries: { active: number; weightedCovered: number; weightedTotal: number };
  conversion: { conversionUrls: number; ctaEvents30d: number; pricingPlans: number; hasTrialOrDemo: boolean };
  measurement: { searchConsole: boolean; bingWebmaster?: boolean; analytics: boolean; eventsReceived30d: boolean; revenueSource: boolean };
};

export type ScoreLine = {
  label: string;
  earned: number;
  max: number;
  /** false = excluded from the denominator (provider not connected, or not applicable). */
  measurable: boolean;
  reason: string;
  fix?: string;
  /** Why the line is excluded, e.g. "Not measured: connect Bing Webmaster Tools." */
  notMeasured?: string;
  effort: 1 | 2 | 3;
};
export type ScoreComponent = {
  key: string;
  label: string;
  /** Points earned on measurable lines. */
  earned: number;
  /** Measurable maximum (excluded lines removed). */
  max: number;
  /** Maximum when every line is measurable. */
  fullMax: number;
  lines: ScoreLine[];
  /** Points missing on measurable lines. */
  missing: number;
  nextActions: string[];
};
export type BeaconScore = {
  version: 2;
  /** 0..100, rescaled over the measurable maximum. */
  total: number;
  /** Sum of the measurable line maxima (out of 100). */
  measuredMax: number;
  /** Share of the full score that could be measured (0..1). */
  coverage: number;
  notMeasured: { component: string; label: string; reason: string }[];
  components: ScoreComponent[];
  pathTo: { target: number; tasks: { task: string; points: number; component: string; effort: number }[] };
};

const line = (label: string, earned: number, max: number, reason: string, fix?: string, effort: 1 | 2 | 3 = 2): ScoreLine => ({
  label,
  earned: round(Math.max(0, Math.min(max, earned)), 1),
  max,
  measurable: true,
  reason,
  fix: earned < max ? fix : undefined,
  effort,
});

/** A line that cannot be measured: it earns nothing and is removed from the denominator. */
const unmeasured = (label: string, max: number, notMeasured: string, fix?: string, effort: 1 | 2 | 3 = 1): ScoreLine => ({ label, earned: 0, max, measurable: false, reason: notMeasured, notMeasured, fix, effort });

function component(key: string, label: string, lines: ScoreLine[]): ScoreComponent {
  const measured = lines.filter((l) => l.measurable);
  const earned = round(measured.reduce((s, l) => s + l.earned, 0), 1);
  const max = measured.reduce((s, l) => s + l.max, 0);
  return { key, label, lines, earned, max, fullMax: lines.reduce((s, l) => s + l.max, 0), missing: round(max - earned, 1), nextActions: lines.filter((l) => l.fix).map((l) => l.fix!) };
}

/**
 * Referring domains (max 4): 2 x log10(1 + domains), capped. Measured only
 * from stored backlink data (Bing Webmaster Tools). Bing connected without
 * link data yet is reported as such, never as 0 domains.
 */
function referringDomainsLine(i: ScoreInput): ScoreLine {
  const n = i.authority.referringDomains;
  if (n === null)
    return i.measurement.bingWebmaster
      ? unmeasured("Referring domains", 4, "Not measured yet: Bing Webmaster Tools has returned no link data for this site.")
      : unmeasured("Referring domains", 4, "Not measured: connect Bing Webmaster Tools (backlink data).", "Connect Bing Webmaster Tools for backlink data.");
  const b = i.authority.backlinks;
  const reason = !b
    ? `${n} referring domains observed.`
    : b.inboundLinks === null
      ? `${b.source}: ${n} referring domains as of ${b.asOf} (sampled from the most-linked pages).`
      : `${b.source}: ${n} referring domains as of ${b.asOf} (sampled from the most-linked pages), ${b.inboundLinks} inbound links.`;
  return line("Referring domains", Math.min(4, Math.log10(1 + n) * 2), 4, reason, "Earn links through directories, partners and useful content.", 3);
}

/**
 * Beacon Score v2: a transparent 0 to 100 operational readiness score. Every
 * point gained or lost is attributed to a concrete, inspectable reason. Lines
 * that cannot be measured (provider not connected) or do not apply are
 * excluded from the denominator and the score is rescaled:
 *
 *   total = 100 x (sum of earned points on measurable lines) / (sum of their maxima)
 *
 * `coverage` reports how much of the full 100 points could be measured. It is
 * NOT a prediction of rankings or traffic.
 */
export function computeBeaconScore(i: ScoreInput): BeaconScore {
  // Technical discovery: 20
  let technical: ScoreLine[];
  if (!i.audit) technical = [line("Technical audit", 0, 20, "No technical audit has been run.", "Run a technical SEO audit of the product website.", 1)];
  else {
    const minorPenalty = (i.audit.openIssues.MEDIUM ?? 0) * SEVERITY_PENALTY.MEDIUM + (i.audit.openIssues.LOW ?? 0) * SEVERITY_PENALTY.LOW;
    const crit = i.audit.openIssues.CRITICAL ?? 0;
    const high = i.audit.openIssues.HIGH ?? 0;
    technical = [
      line("Critical & high issues", 12 - Math.min(12, crit * 4 + high * 1.5), 12, `${crit} critical and ${high} high-severity open issues.`, "Fix critical and high-severity audit issues first.", 2),
      line("Medium & low issues", 6 - Math.min(6, minorPenalty / 2), 6, `${i.audit.openIssues.MEDIUM ?? 0} medium and ${i.audit.openIssues.LOW ?? 0} low-severity open issues.`, "Resolve medium-severity issues (canonicals, meta descriptions, alt text).", 2),
      line("Audit freshness", i.audit.ageDays <= 14 ? 2 : i.audit.ageDays <= 45 ? 1 : 0, 2, `Last audit ${i.audit.ageDays} day(s) ago.`, "Re-run the audit (schedule weekly).", 1),
    ];
  }

  // Content coverage: 20
  const pagesRatio = i.pages.planned ? i.pages.published / i.pages.planned : 0;
  const content = [
    line("Product page published", i.pages.productPagePublished ? 5 : 0, 5, i.pages.productPagePublished ? "Canonical product page is published." : "No published product page.", "Generate, approve and publish the product page.", 2),
    line("Planned pages published", 9 * pagesRatio, 9, `${i.pages.published}/${i.pages.planned} planned discovery pages published.`, "Publish planned pages that pass the quality gate.", 3),
    line("Answer pages", Math.min(3, i.pages.answerPagesPublished), 3, `${i.pages.answerPagesPublished} answer page(s) published.`, "Publish answer pages for verified FAQs.", 2),
    i.pages.comparisonPlanned
      ? line("Comparisons", (3 * i.pages.comparisonPublished) / i.pages.comparisonPlanned, 3, `${i.pages.comparisonPublished}/${i.pages.comparisonPlanned} sourced comparisons published.`, "Publish sourced comparison pages.", 3)
      : unmeasured("Comparisons", 3, "Not applicable: no sourced comparison pages are planned."),
  ];

  // Entity completeness: 15
  const entity = [
    line(
      "Knowledge graph completeness",
      15 * i.completeness,
      15,
      `${Math.round(i.completeness * 100)}% entity completeness (verified facts count fully, unverified facts half).`,
      "Fill and verify the missing knowledge-graph facts listed on the knowledge page.",
      1,
    ),
  ];

  // Authority / citation signals: 15
  const ai = i.authority.ai;
  const rate = ai.tests90d ? ai.testsMentioning90d / ai.tests90d : 0;
  const authority = [
    line("Verified proof", Math.min(5, i.authority.verifiedProofs * 2.5), 5, `${i.authority.verifiedProofs} verified, publishable proof item(s) (case studies, testimonials, metrics).`, "Add verified case studies or testimonials with publication permission.", 3),
    line("Canonical sources", Math.min(3, i.authority.sources), 3, `${i.authority.sources} canonical source URL(s).`, "Link documentation, pricing and website sources.", 1),
    referringDomainsLine(i),
    !ai.providerConfigured
      ? unmeasured("AI mention rate", 3, "Not measured: connect an AI provider (Settings, Integrations) to sample AI answers.", "Connect an AI provider and track this product's prompts.")
      : ai.tests90d
        ? line("AI mention rate", 3 * rate, 3, `Mentioned in ${ai.testsMentioning90d} of ${ai.tests90d} sampled AI answers to this product's prompts (90 days).`, "Close the gaps revealed by this product's AI visibility tests.", 2)
        : line("AI mention rate", 0, 3, "No AI visibility tests for this product's prompts in 90 days.", "Add prompts for this product and run AI visibility tests.", 1),
  ];

  // Query coverage: 15
  const qc = i.queries.weightedTotal ? i.queries.weightedCovered / i.queries.weightedTotal : 0;
  const queries = [
    line("Query universe defined", i.queries.active >= 20 ? 3 : (3 * i.queries.active) / 20, 3, `${i.queries.active} active queries tracked.`, "Generate and curate the query universe (target ≥ 20).", 1),
    line("Importance-weighted coverage", 12 * qc, 12, `${Math.round(qc * 100)}% of importance-weighted queries covered by published content.`, "Cover high-importance queries with dedicated pages.", 3),
  ];

  // Conversion readiness: 10
  const conversion = [
    line("Conversion URLs", i.conversion.conversionUrls ? 3 : 0, 3, `${i.conversion.conversionUrls} conversion URL(s) declared.`, "Declare trial/demo/signup URLs.", 1),
    line("CTA tracking live", i.conversion.ctaEvents30d > 0 ? 3 : 0, 3, `${i.conversion.ctaEvents30d} CTA click event(s) received in 30 days.`, "Install the Beacon tracker and tag CTAs.", 1),
    line("Pricing clarity", i.conversion.pricingPlans ? 2 : 0, 2, `${i.conversion.pricingPlans} pricing plan(s) recorded.`, "Record pricing plans (mark unknown prices explicitly).", 1),
    line("Low-friction entry", i.conversion.hasTrialOrDemo ? 2 : 0, 2, i.conversion.hasTrialOrDemo ? "Free trial or demo path exists." : "No free trial or demo path recorded.", "Offer and declare a trial or demo path.", 2),
  ];

  // Measurement readiness: 5 (whether each source is connected is itself measured)
  const m = i.measurement;
  const measurement = [
    line("Search Console", m.searchConsole ? 2 : 0, 2, m.searchConsole ? "Connected." : "Not connected.", "Connect Google Search Console.", 1),
    line("Analytics", m.analytics ? 1 : 0, 1, m.analytics ? "Connected." : "Not connected.", "Connect analytics (GA4) or rely on Beacon first-party events.", 1),
    line("First-party events", m.eventsReceived30d ? 1 : 0, 1, m.eventsReceived30d ? "Events received in 30 days." : "No events received.", "Install the Beacon tracker.", 1),
    line("Revenue source", m.revenueSource ? 1 : 0, 1, m.revenueSource ? "Revenue events flowing." : "No revenue integration.", "Connect Stripe webhooks or the revenue API.", 2),
  ];

  const components = [
    component("technical", "Technical discovery", technical),
    component("content", "Content coverage", content),
    component("entity", "Entity completeness", entity),
    component("authority", "Authority / citation signals", authority),
    component("queries", "Query coverage", queries),
    component("conversion", "Conversion readiness", conversion),
    component("measurement", "Measurement readiness", measurement),
  ];
  const measuredMax = components.reduce((s, c) => s + c.max, 0);
  const earned = components.reduce((s, c) => s + c.earned, 0);
  const scale = measuredMax ? 100 / measuredMax : 0;
  const total = round(earned * scale, 0);

  // Fastest path to the next 10-point milestone (points in rescaled units): highest points-per-effort first.
  const target = Math.min(100, Math.floor(total / 10) * 10 + 10);
  const candidates = components
    .flatMap((c) => c.lines.filter((l) => l.measurable && l.fix && l.max - l.earned >= 0.5).map((l) => ({ task: l.fix!, points: round((l.max - l.earned) * scale, 1), component: c.label, effort: l.effort })))
    .sort((a, b) => b.points / b.effort - a.points / a.effort);
  const tasks: BeaconScore["pathTo"]["tasks"] = [];
  let acc = total;
  for (const c of candidates) {
    if (acc >= target) break;
    tasks.push(c);
    acc += c.points;
  }
  return {
    version: 2,
    total,
    measuredMax,
    coverage: measuredMax / 100,
    notMeasured: components.flatMap((c) => c.lines.filter((l) => !l.measurable).map((l) => ({ component: c.label, label: l.label, reason: l.notMeasured ?? l.reason }))),
    components,
    pathTo: { target, tasks },
  };
}

export type ScoreLineDiff = { component: string; label: string; before: number | null; after: number; delta: number; measurableBefore: boolean | null; measurableAfter: boolean };

/**
 * Per-line difference between the previous stored score and this one ("since
 * last computation"). Lines that did not exist before have `before: null`.
 * Older stored scores (v1) have no `measurable` flag and count as measurable.
 */
export function diffScores(prev: Pick<BeaconScore, "total" | "components"> | null, next: Pick<BeaconScore, "total" | "components">): { totalDelta: number | null; lines: ScoreLineDiff[] } {
  const before = new Map<string, { earned: number; measurable: boolean }>();
  for (const c of prev?.components ?? []) for (const l of c.lines) before.set(`${c.key}:${l.label}`, { earned: l.earned, measurable: (l as Partial<ScoreLine>).measurable ?? true });
  const lines: ScoreLineDiff[] = [];
  for (const c of next.components)
    for (const l of c.lines) {
      const b = before.get(`${c.key}:${l.label}`);
      const delta = round(l.earned - (b?.earned ?? 0), 1);
      if (!prev || (b && delta === 0 && b.measurable === l.measurable)) continue;
      lines.push({ component: c.label, label: l.label, before: b ? b.earned : null, after: l.earned, delta, measurableBefore: b ? b.measurable : null, measurableAfter: l.measurable });
    }
  return { totalDelta: prev ? round(next.total - prev.total, 0) : null, lines };
}

/** Read a stored score of any version (v1 rows have no measurable flags or coverage) as a v2 score. */
export function normalizeScore(raw: unknown): BeaconScore {
  const s = raw as Partial<BeaconScore> & { components?: (Partial<ScoreComponent> & { lines?: Partial<ScoreLine>[] })[] };
  const components: ScoreComponent[] = (s.components ?? []).map((c) => {
    const lines = (c.lines ?? []).map((l) => ({ label: l.label ?? "", earned: l.earned ?? 0, max: l.max ?? 0, measurable: l.measurable ?? true, reason: l.reason ?? "", fix: l.fix, notMeasured: l.notMeasured, effort: l.effort ?? 2 }) as ScoreLine);
    return { ...component(c.key ?? "", c.label ?? "", lines), earned: c.earned ?? lines.filter((l) => l.measurable).reduce((a, l) => a + l.earned, 0) };
  });
  const measuredMax = s.measuredMax ?? components.reduce((a, c) => a + c.max, 0);
  return {
    version: 2,
    total: s.total ?? 0,
    measuredMax,
    coverage: s.coverage ?? measuredMax / 100,
    notMeasured: s.notMeasured ?? [],
    components,
    pathTo: s.pathTo ?? { target: 0, tasks: [] },
  };
}
