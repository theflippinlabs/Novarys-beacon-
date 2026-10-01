import { sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { competitorIntel } from "@/services/ai-visibility";
import { recentChanges } from "@/services/competitor-watch";
import { isoDate, loadOpenOpportunities, opportunityFinding, ruleFinding, type OppRow } from "../common";
import type { Coverage, Finding, SpecialistReport } from "../types";
import { AI_WINDOW_DAYS, MIN_AI_SAMPLES } from "./ai-visibility";

/**
 * Competitors specialist: how often each competitor appears in sampled AI
 * answers compared with your products, recent changes on watched competitor
 * pages (for human review), and the comparison-fact opportunities.
 */
export const COMPETITOR_TYPES = ["COMPARISON_FACTS"];
export const CHANGE_WINDOW_DAYS = 14;
const MAX_CHANGES = 5;

export type CompetitorsSignals = {
  competitors: { id: string; name: string; samplesMentioning: number }[];
  samplesTotal: number;
  orgMentioned: number;
  activeWatches: number;
  changes: { id: string; watchId: string; competitorName: string; url: string; fetchedAt: string; linesAdded: number; linesRemoved: number }[];
  opportunities: OppRow[];
};

export async function collectCompetitors(tx: Tx, organizationId: string, now: Date): Promise<CompetitorsSignals> {
  const since = new Date(now.getTime() - AI_WINDOW_DAYS * 86_400_000);
  const intel = await competitorIntel(tx, organizationId, { since });
  const org = (await tx.execute<{ n: number }>(sql`select (count(*) filter (where org_mentioned))::int as n from ai_visibility_tests where organization_id = ${organizationId} and ran_at >= ${since.toISOString()}`)).rows[0];
  const watches = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from competitor_watches where organization_id = ${organizationId} and active`)).rows[0];
  const changes = await recentChanges(tx, organizationId, { days: CHANGE_WINDOW_DAYS, limit: MAX_CHANGES });
  const opps = await loadOpenOpportunities(tx, organizationId, COMPETITOR_TYPES);
  return {
    competitors: intel.map((c) => ({ id: c.competitor.id, name: c.competitor.name, samplesMentioning: c.samplesMentioning })),
    samplesTotal: intel[0]?.samplesTotal ?? 0,
    orgMentioned: Number(org?.n ?? 0),
    activeWatches: Number(watches?.n ?? 0),
    changes: changes.map((c) => ({ id: c.id, watchId: c.watchId, competitorName: c.competitorName, url: c.url, fetchedAt: c.fetchedAt.toISOString(), linesAdded: c.diff?.linesAdded ?? 0, linesRemoved: c.diff?.linesRemoved ?? 0 })),
    opportunities: opps,
  };
}

export function analyzeCompetitors(s: CompetitorsSignals): SpecialistReport {
  const findings: Finding[] = [];
  const missing: string[] = [];
  if (s.samplesTotal >= MIN_AI_SAMPLES)
    for (const c of s.competitors) {
      if (c.samplesMentioning <= s.orgMentioned) continue;
      findings.push(
        ruleFinding("competitors", `competitor:ahead:${c.id}`, {
          title: "{competitor} appears in more sampled AI answers than your products",
          summary: "Over the last {days} days answer engines named {competitor} more often than any of your products for the prompts you track.",
          vars: { competitor: c.name, days: AI_WINDOW_DAYS },
          severity: c.samplesMentioning >= 2 * Math.max(1, s.orgMentioned) ? "HIGH" : "MEDIUM",
          effort: 3,
          evidence: [
            { label: "Answers mentioning the competitor", value: String(c.samplesMentioning), href: "/ai-visibility" },
            { label: "Answers mentioning your products", value: String(s.orgMentioned) },
            { label: "Sampled answers (30 days)", value: String(s.samplesTotal) },
          ],
          action: { label: "Open AI visibility", href: "/ai-visibility", kind: "PROPOSE_RECOMMENDATION" },
          target: { productId: null, opportunityType: "COMPARISON_FACTS" },
        }),
      );
    }
  for (const ch of s.changes)
    findings.push(
      ruleFinding("competitors", `competitor:change:${ch.id}`, {
        title: "Review the change on a watched page of {competitor}",
        summary: "{url} changed. Review it before updating any comparison fact; nothing is changed automatically.",
        vars: { competitor: ch.competitorName, url: ch.url },
        severity: "MEDIUM",
        effort: 1,
        evidence: [
          { label: "Detected on", value: isoDate(ch.fetchedAt)!, href: `/ai-visibility#watch-${ch.watchId}` },
          { label: "Lines added", value: String(ch.linesAdded) },
          { label: "Lines removed", value: String(ch.linesRemoved) },
        ],
        action: { label: "Review the change", href: `/ai-visibility#watch-${ch.watchId}`, kind: "OPEN" },
      }),
    );
  if (s.competitors.length && s.activeWatches === 0)
    findings.push(
      ruleFinding("competitors", "competitor:no_watch", {
        title: "Watch the pricing pages of your competitors",
        summary: "Beacon can check competitor pages weekly (robots.txt respected) and flag changes for review.",
        severity: "LOW",
        effort: 1,
        evidence: [
          { label: "Competitors", value: String(s.competitors.length) },
          { label: "Watched pages", value: "0", href: "/ai-visibility#watched-pages" },
        ],
        action: { label: "Open watched pages", href: "/ai-visibility#watched-pages", kind: "OPEN" },
      }),
    );
  for (const o of s.opportunities) findings.push(opportunityFinding("competitors", o));

  let coverage: Coverage;
  if (!s.competitors.length) {
    coverage = "NOT_CONNECTED";
    missing.push("Competitors in the knowledge graph");
  } else {
    if (s.samplesTotal < MIN_AI_SAMPLES) missing.push("10 sampled AI answers in the last 30 days");
    if (s.activeWatches === 0) missing.push("Watched competitor pages");
    coverage = missing.length ? "PARTIAL" : "MEASURED";
  }
  return { specialist: "competitors", coverage, missing, findings };
}
