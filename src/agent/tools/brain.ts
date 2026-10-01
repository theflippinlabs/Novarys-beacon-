import { z } from "zod";
import { estimateImpact } from "@/core/estimate/impact";
import type { Estimate, ImpactEstimate } from "@/core/estimate/types";
import { runSpecialist } from "@/brain/specialists";
import { SPECIALIST_LABELS, SPECIALISTS, type Evidence, type FindingAction } from "@/brain/types";
import type { T } from "@/i18n/core";
import { loadEstimationContext } from "@/services/estimates";
import { activeRun, latestDoneRun, queueBrainRun, runFindings } from "@/services/brain";
import { defineTool } from "../types";
import { agentActor, iso } from "./util";

/**
 * Beacon Brain tools. The Brain only analyses, estimates and ranks; it never
 * approves, publishes, verifies facts, submits externally or deletes. Its
 * findings link to the page where a person acts.
 */

const brief = (e: Estimate) =>
  e.state === "ESTIMATED"
    ? { state: e.state, label: e.label, unit: e.unit, ...(e.currency ? { currency: e.currency } : {}), p10: e.p10, p50: e.p50, p90: e.p90, horizonDays: e.horizonDays, confidence: e.confidence, method: e.method }
    : { state: e.state, label: e.label, reason: e.reason, missing: e.missing };

const impactBrief = (e: ImpactEstimate | null | undefined) => (e ? { expectedSignups: brief(e.signups), expectedRevenue: e.revenue.map(brief), reached: e.reached, missing: e.missing } : null);

type FindingLike = { title: string; summary: string; vars?: Record<string, string | number> | null; severity: string; specialist: string; evidence: Evidence[]; action: FindingAction; opportunityId?: string | null; estimate?: ImpactEstimate | null };

function findingOut(t: T, f: FindingLike, rank?: number) {
  return {
    ...(rank ? { rank } : {}),
    title: t(f.title, f.vars ?? undefined),
    summary: t(f.summary, f.vars ?? undefined),
    severity: f.severity,
    area: SPECIALIST_LABELS[f.specialist as keyof typeof SPECIALIST_LABELS] ?? f.specialist,
    evidence: f.evidence.slice(0, 6).map((e) => ({ label: e.label, value: e.value })),
    impact: impactBrief(f.estimate),
    action: f.action.label,
    link: f.action.href,
    ...(f.opportunityId ? { opportunityId: f.opportunityId } : {}),
  };
}

export const getBrainReport = defineTool({
  name: "get_brain_report",
  label: "Reading the Brain report",
  description:
    "Read the latest Beacon Brain report: coverage of the six areas (technical SEO, content and knowledge, AI visibility, competitors, conversion and revenue, distribution and growth), the executive summary, the ranked plan (actions whose expected extra signups could be estimated, with 80% intervals and how they were estimated), the findings that cannot be estimated yet with what to connect, and the connection that would unlock the most estimates. Every number comes from measured data.",
  permission: "read",
  kind: "read",
  input: z.object({ limit: z.number().int().min(1).max(25).optional().describe("Findings per list (default 10).") }),
  run: async ({ tx, ctx, t, locale }, i) => {
    const latest = await latestDoneRun(tx, ctx.org.id);
    const active = await activeRun(tx, ctx.org.id);
    const running = active ? { status: active.status, queuedAt: iso(active.createdAt) } : null;
    if (!latest) return { status: "no run yet", running, detail: "The Brain has not finished a run yet. Use run_brain to queue one (it runs in the background).", link: "/brain" };
    const { ranked, unestimated } = await runFindings(tx, ctx.org.id, latest.id);
    const n = i.limit ?? 10;
    const summary = latest.executiveSummary;
    return {
      run: { finishedAt: iso(latest.finishedAt), trigger: latest.trigger, summarySource: summary ? "AI-written (validated: no number outside the evidence)" : "deterministic", llmSkipped: latest.llmUsage?.skipped ?? null },
      running,
      coverage: SPECIALISTS.map((k) => ({ area: SPECIALIST_LABELS[k], coverage: latest.coverage[k]?.coverage ?? "NOT_CONNECTED", missing: latest.coverage[k]?.missing ?? [] })),
      executiveSummary: summary ? (locale === "fr" ? summary.fr : summary.en) : null,
      estimationPower: latest.estimationPower,
      rankedPlan: { items: ranked.slice(0, n).map((f) => findingOut(t, f, f.rank)), total: ranked.length },
      notEstimable: { items: unestimated.slice(0, n).map((f) => findingOut(t, f)), total: unestimated.length },
      note: "Findings link to the page where a person acts. Proposing a finding (on /brain) creates a recommendation that waits for human approval.",
      link: "/brain",
    };
  },
});

export const askSpecialist = defineTool({
  name: "ask_specialist",
  label: "Asking a Brain specialist",
  description:
    "Run one Beacon Brain specialist now on this workspace's current data and return its report: coverage, missing connections, and findings with evidence and expected-impact estimates (or what is missing to estimate). Deterministic and read-only; the specialist's latest validated AI narrative from the last Brain run is included when there is one. Use it for a focused question about one area; use get_brain_report for the whole ranked plan.",
  permission: "read",
  kind: "read",
  input: z.object({ specialist: z.enum(SPECIALISTS).describe("technical_seo, content_knowledge, ai_visibility, competitors, conversion_revenue or distribution_growth.") }),
  run: async ({ tx, ctx, t, locale }, i) => {
    const report = await runSpecialist(tx, ctx.org.id, i.specialist);
    const estimation = await loadEstimationContext(tx, ctx.org.id);
    for (const f of report.findings) if (f.target) f.estimate = estimateImpact(estimation, f.target);
    const latest = await latestDoneRun(tx, ctx.org.id);
    const narrative = latest?.narratives?.[i.specialist];
    return {
      area: SPECIALIST_LABELS[i.specialist],
      coverage: report.coverage,
      missing: report.missing,
      findings: report.findings.slice(0, 25).map((f) => findingOut(t, f)),
      totalFindings: report.findings.length,
      latestNarrative: narrative ? { text: locale === "fr" ? narrative.fr : narrative.en, from: iso(latest?.finishedAt) } : null,
      link: "/brain",
    };
  },
});

export const runBrainTool = defineTool({
  name: "run_brain",
  label: "Queuing a Brain run",
  description:
    "Queue a full Beacon Brain run in the background: the six specialists analyse the workspace, the estimators compute expected impact, and the report appears on /brain (usually within minutes). Refused while another run is queued or running. It only analyses: nothing is published, approved or submitted.",
  permission: "job:run",
  kind: "write",
  input: z.object({}),
  run: async (c) => {
    const r = await queueBrainRun(c.tx, agentActor(c), "AGENT");
    return r.queued ? { status: "queued", runId: r.run.id, detail: "The Brain run is queued. Use get_brain_report once it has finished.", link: "/brain" } : { status: "already running", since: iso(r.run.createdAt), detail: "A Brain run is already queued or running.", link: "/brain" };
  },
});
