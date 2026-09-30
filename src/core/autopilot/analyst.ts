import { pctChange } from "@/core/conversions/funnel";

export type MetricPair = { key: string; label: string; now: number; prev: number; unit?: "count" | "cents" | "ratio"; source: string };
export type PeriodEvent = { kind: "PAGE_PUBLISHED" | "CONTENT_PUBLISHED" | "AUDIT_ISSUES" | "DISTRIBUTION_PUBLISHED" | "CAMPAIGN_STARTED" | "INTEGRATION_ERROR"; label: string; at: string; productId?: string | null };

export type GrowthAnalysis = {
  whatHappened: { metric: string; now: number; prev: number; change: number | null; direction: "up" | "down" | "flat"; unit: string; source: string }[];
  whyItMayHaveHappened: { observation: string; relatedEvents: string[]; evidence: "CORRELATION" | "INSUFFICIENT_DATA" }[];
  opportunities: { title: string; potential: string; priority: number }[];
  recommendedActions: { title: string; body: string; kind: string; requiresApproval: boolean }[];
  contentToCreate: string[];
  technicalIssues: string[];
  experiments: { name: string; hypothesis: string; primaryMetric: string; signalToMonitor: string }[];
  signalsToMonitor: string[];
  dataCoverage: { connected: string[]; missing: string[] };
  disclaimer: string;
};

const SIGNIFICANT = 0.15;
const MIN_VOLUME = 20;

/**
 * Deterministic growth analysis. It reports measured changes, lists events
 * that coincided with them (explicitly labelled as correlation), and turns
 * existing opportunities into proposed actions. Actions that touch production
 * content, external accounts or paid campaigns always require approval.
 */
export function analyzeGrowth(input: {
  metrics: MetricPair[];
  events: PeriodEvent[];
  opportunities: { title: string; potential: string; priorityScore: number; type: string }[];
  openCriticalIssues: { rule: string; count: number }[];
  connected: string[];
  missing: string[];
}): GrowthAnalysis {
  const whatHappened = input.metrics.map((m) => {
    const change = pctChange(m.now, m.prev);
    const direction: "up" | "down" | "flat" = change === null ? (m.now > 0 ? "up" : "flat") : Math.abs(change) < 0.02 ? "flat" : change > 0 ? "up" : "down";
    return { metric: m.label, now: m.now, prev: m.prev, change, direction, unit: m.unit ?? "count", source: m.source };
  });

  const why: GrowthAnalysis["whyItMayHaveHappened"] = [];
  for (const m of input.metrics) {
    const change = pctChange(m.now, m.prev);
    if (Math.max(m.now, m.prev) < MIN_VOLUME) {
      if (m.now || m.prev) why.push({ observation: `${m.label}: volume too low (${m.prev} → ${m.now}) to interpret changes.`, relatedEvents: [], evidence: "INSUFFICIENT_DATA" });
      continue;
    }
    if (change === null || Math.abs(change) < SIGNIFICANT) continue;
    const related = input.events.map((e) => `${e.label} (${e.at.slice(0, 10)})`).slice(0, 6);
    why.push({
      observation: `${m.label} ${change > 0 ? "rose" : "fell"} ${Math.abs(Math.round(change * 100))}% (${m.prev} → ${m.now}).`,
      relatedEvents: related,
      evidence: related.length ? "CORRELATION" : "INSUFFICIENT_DATA",
    });
  }

  const top = [...input.opportunities].sort((a, b) => b.priorityScore - a.priorityScore).slice(0, 8);
  const recommendedActions: GrowthAnalysis["recommendedActions"] = top.map((o) => ({
    title: o.title,
    body: `From opportunity (${o.type}, ${o.potential} potential).`,
    kind: o.type,
    requiresApproval: ["CONTENT_GAP", "AI_VISIBILITY_GAP", "LOW_CTR", "STRIKING_DISTANCE", "CONVERSION", "COMPARISON_FACTS", "INTERNAL_LINKING"].includes(o.type) || o.type === "TECHNICAL",
  }));
  for (const c of input.openCriticalIssues)
    recommendedActions.unshift({ title: `Fix critical issue: ${c.rule}`, body: `${c.count} affected page(s).`, kind: "TECHNICAL", requiresApproval: true });

  const experiments: GrowthAnalysis["experiments"] = [];
  const ctr = top.find((o) => o.type === "LOW_CTR");
  if (ctr) experiments.push({ name: `Title/description rewrite: ${ctr.title}`, hypothesis: "A title that answers the query intent will raise CTR at equal position.", primaryMetric: "Search CTR", signalToMonitor: "CTR and average position for the query over 28 days" });
  const conv = top.find((o) => o.type === "CONVERSION");
  if (conv) experiments.push({ name: `CTA placement: ${conv.title}`, hypothesis: "An above-the-fold, intent-matched CTA raises CTA click rate.", primaryMetric: "CTA click rate", signalToMonitor: "CTA_CLICK / PAGE_VIEW on the page over 28 days" });

  return {
    whatHappened,
    whyItMayHaveHappened: why,
    opportunities: top.map((o) => ({ title: o.title, potential: o.potential, priority: o.priorityScore })),
    recommendedActions,
    contentToCreate: top.filter((o) => o.type === "CONTENT_GAP" || o.type === "AI_VISIBILITY_GAP").map((o) => o.title),
    technicalIssues: input.openCriticalIssues.map((c) => `${c.rule} (${c.count})`),
    experiments,
    signalsToMonitor: [
      ...whatHappened.filter((w) => w.direction !== "flat").map((w) => `${w.metric} (${w.source})`),
      ...experiments.map((e) => e.signalToMonitor),
    ].slice(0, 8),
    dataCoverage: { connected: input.connected, missing: input.missing },
    disclaimer: "Changes are measured; explanations list coinciding events and are correlations, not proven causes. Validate with experiments before drawing conclusions.",
  };
}
