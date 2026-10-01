import { SEVERITY_PENALTY, type Severity } from "@/core/seo/analyze";
import { round } from "@/core/util/text";

export type ScoreInput = {
  completeness: number;
  audit: { openIssues: Record<Severity, number>; pagesCrawled: number; ageDays: number } | null;
  pages: { planned: number; published: number; productPagePublished: boolean; answerPagesPublished: number; comparisonPlanned: number; comparisonPublished: number };
  authority: { verifiedProofs: number; sources: number; referringDomains: number | null; aiMentions90d: number; aiTests90d: number };
  queries: { active: number; weightedCovered: number; weightedTotal: number };
  conversion: { conversionUrls: number; ctaEvents30d: number; pricingPlans: number; hasTrialOrDemo: boolean };
  measurement: { searchConsole: boolean; analytics: boolean; eventsReceived30d: boolean; revenueSource: boolean };
};

export type ScoreLine = { label: string; earned: number; max: number; reason: string; fix?: string; effort: 1 | 2 | 3 };
export type ScoreComponent = { key: string; label: string; earned: number; max: number; lines: ScoreLine[] };
export type BeaconScore = { total: number; components: ScoreComponent[]; pathTo: { target: number; tasks: { task: string; points: number; component: string; effort: number }[] } };

const line = (label: string, earned: number, max: number, reason: string, fix?: string, effort: 1 | 2 | 3 = 2): ScoreLine => ({
  label,
  earned: round(Math.max(0, Math.min(max, earned)), 1),
  max,
  reason,
  fix: earned < max ? fix : undefined,
  effort,
});

function component(key: string, label: string, lines: ScoreLine[]): ScoreComponent {
  return { key, label, lines, earned: round(lines.reduce((s, l) => s + l.earned, 0), 1), max: lines.reduce((s, l) => s + l.max, 0) };
}

/**
 * Beacon Score: a transparent 0 to 100 operational readiness score. Every point
 * gained or lost is attributed to a concrete, inspectable reason. It measures
 * what Beacon can observe; it is NOT a prediction of rankings or traffic.
 */
export function computeBeaconScore(i: ScoreInput): BeaconScore {
  // Technical Discovery: 20
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

  // Content Coverage: 20
  const pagesRatio = i.pages.planned ? i.pages.published / i.pages.planned : 0;
  const content = [
    line("Product page published", i.pages.productPagePublished ? 5 : 0, 5, i.pages.productPagePublished ? "Canonical product page is published." : "No published product page.", "Generate, approve and publish the product page.", 2),
    line("Planned pages published", 9 * pagesRatio, 9, `${i.pages.published}/${i.pages.planned} planned discovery pages published.`, "Publish planned pages that pass the quality gate.", 3),
    line("Answer pages", Math.min(3, i.pages.answerPagesPublished), 3, `${i.pages.answerPagesPublished} answer page(s) published.`, "Publish answer pages for verified FAQs.", 2),
    line(
      "Comparisons",
      i.pages.comparisonPlanned ? (3 * i.pages.comparisonPublished) / i.pages.comparisonPlanned : 3,
      3,
      i.pages.comparisonPlanned ? `${i.pages.comparisonPublished}/${i.pages.comparisonPlanned} sourced comparisons published.` : "No comparison pages required (no sourced competitor facts).",
      "Publish sourced comparison pages.",
      3,
    ),
  ];

  // Entity Completeness: 15 (components: 20+20+15+15+15+10+5 = 100)
  const entity = [line("Knowledge graph completeness", 15 * i.completeness, 15, `${Math.round(i.completeness * 100)}% of weighted entity facts present.`, "Fill the missing knowledge-graph fields listed on the product page.", 1)];

  // Authority Signals: 15
  const authority = [
    line("Verified proof", Math.min(5, i.authority.verifiedProofs * 2.5), 5, `${i.authority.verifiedProofs} verified, publishable proof item(s) (case studies, testimonials, metrics).`, "Add verified case studies or testimonials with publication permission.", 3),
    line("Canonical sources", Math.min(3, i.authority.sources), 3, `${i.authority.sources} canonical source URL(s).`, "Link documentation, pricing and website sources.", 1),
    line(
      "Referring domains",
      i.authority.referringDomains === null ? 0 : Math.min(4, Math.log10(1 + i.authority.referringDomains) * 2),
      4,
      i.authority.referringDomains === null ? "Backlink data not connected: cannot be scored." : `${i.authority.referringDomains} referring domains observed.`,
      i.authority.referringDomains === null ? "Connect a source of backlink data (e.g. Bing Webmaster)." : "Earn links through directories, partners and useful content.",
      3,
    ),
    line(
      "Observed AI mentions",
      i.authority.aiTests90d ? Math.min(3, i.authority.aiMentions90d) : 0,
      3,
      i.authority.aiTests90d ? `${i.authority.aiMentions90d} mention(s) across ${i.authority.aiTests90d} sampled AI tests (90 days).` : "No AI visibility tests run.",
      "Run AI visibility tests and close the gaps they reveal.",
      2,
    ),
  ];

  // Query Coverage: 15
  const qc = i.queries.weightedTotal ? i.queries.weightedCovered / i.queries.weightedTotal : 0;
  const queries = [
    line("Query universe defined", i.queries.active >= 20 ? 3 : (3 * i.queries.active) / 20, 3, `${i.queries.active} active queries tracked.`, "Generate and curate the query universe (target ≥ 20).", 1),
    line("Importance-weighted coverage", 12 * qc, 12, `${Math.round(qc * 100)}% of importance-weighted queries covered by published content.`, "Cover high-importance queries with dedicated pages.", 3),
  ];

  // Conversion Readiness: 10
  const conversion = [
    line("Conversion URLs", i.conversion.conversionUrls ? 3 : 0, 3, `${i.conversion.conversionUrls} conversion URL(s) declared.`, "Declare trial/demo/signup URLs.", 1),
    line("CTA tracking live", i.conversion.ctaEvents30d > 0 ? 3 : 0, 3, `${i.conversion.ctaEvents30d} CTA click event(s) received in 30 days.`, "Install the Beacon tracker and tag CTAs.", 1),
    line("Pricing clarity", i.conversion.pricingPlans ? 2 : 0, 2, `${i.conversion.pricingPlans} pricing plan(s) recorded.`, "Record pricing plans (mark unknown prices explicitly).", 1),
    line("Low-friction entry", i.conversion.hasTrialOrDemo ? 2 : 0, 2, i.conversion.hasTrialOrDemo ? "Free trial or demo path exists." : "No free trial or demo path recorded.", "Offer and declare a trial or demo path.", 2),
  ];

  // Measurement Coverage: 5
  const m = i.measurement;
  const measurement = [
    line("Search Console", m.searchConsole ? 2 : 0, 2, m.searchConsole ? "Connected." : "Not connected.", "Connect Google Search Console.", 1),
    line("Analytics", m.analytics ? 1 : 0, 1, m.analytics ? "Connected." : "Not connected.", "Connect analytics (GA4) or rely on Beacon first-party events.", 1),
    line("First-party events", m.eventsReceived30d ? 1 : 0, 1, m.eventsReceived30d ? "Events received in 30 days." : "No events received.", "Install the Beacon tracker.", 1),
    line("Revenue source", m.revenueSource ? 1 : 0, 1, m.revenueSource ? "Revenue events flowing." : "No revenue integration.", "Connect Stripe webhooks or the revenue API.", 2),
  ];

  const components = [
    component("technical", "Technical Discovery", technical),
    component("content", "Content Coverage", content),
    component("entity", "Entity Completeness", entity),
    component("authority", "Authority Signals", authority),
    component("queries", "Query Coverage", queries),
    component("conversion", "Conversion Readiness", conversion),
    component("measurement", "Measurement Coverage", measurement),
  ];
  const total = round(components.reduce((s, c) => s + c.earned, 0), 0);

  // Fastest path to the next 10-point milestone: highest points-per-effort first.
  const target = Math.min(100, Math.floor(total / 10) * 10 + 10);
  const candidates = components
    .flatMap((c) => c.lines.filter((l) => l.fix && l.max - l.earned >= 0.5).map((l) => ({ task: l.fix!, points: round(l.max - l.earned, 1), component: c.label, effort: l.effort })))
    .sort((a, b) => b.points / b.effort - a.points / a.effort);
  const tasks: BeaconScore["pathTo"]["tasks"] = [];
  let acc = total;
  for (const c of candidates) {
    if (acc >= target) break;
    tasks.push(c);
    acc += c.points;
  }
  return { total, components, pathTo: { target, tasks } };
}
