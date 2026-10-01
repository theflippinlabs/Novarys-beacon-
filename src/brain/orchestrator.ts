import { withOrg } from "@/db";
import { estimateImpact, estimationPower } from "@/core/estimate/impact";
import type { ImpactTarget } from "@/core/estimate/types";
import { log } from "@/lib/logger";
import { loadEstimationContext } from "@/services/estimates";
import { createRun, getRun, markFailed, markRunning, storeRunResult } from "@/services/brain";
import type { Delivery } from "@/services/notifications";
import { applySpecialistOutput, callStructured, frameData, recordBrainUsage, resolveBrainLlm, specialistInput, SpecialistOutputSchema, synthesisInput, SynthesisOutputSchema, validateSynthesis, type BrainLlm } from "./llm";
import { specialistSystem, SYNTHESIS_SYSTEM } from "./prompts";
import { coverageMap, rankFindings } from "./rank";
import { runSpecialist } from "./specialists";
import { SPECIALISTS, type BrainResult, type LlmRunUsage, type LlmUsage, type Narrative, type SpecialistKey, type SpecialistReport } from "./types";

/**
 * Beacon Brain orchestrator (docs/BEACON_BRAIN.md §5), run by the `brain.run`
 * job:
 * 1. read: one tenant transaction per specialist, sequential queries;
 * 2. estimation: one transaction loads the estimators' inputs, then pure
 *    estimates per finding and the estimation power;
 * 3. optional LLM phase with no transaction open: the specialists in
 *    parallel, then one synthesis call over the merged findings; every
 *    output is validated (schema, ids, number guard) or the deterministic
 *    version is kept;
 * 4. merge and rank; 5. store and notify new critical findings.
 * Without an Anthropic key (or budget) the run is fully deterministic.
 */

export type BrainRunOptions = {
  runId?: string | null;
  trigger?: "SCHEDULED" | "MANUAL" | "AGENT";
  now?: Date;
  /** false skips the LLM phase even when a key exists. */
  llm?: boolean;
  emailConfigured?: boolean;
  heartbeat?: () => Promise<void>;
  signal?: AbortSignal;
};

export type BrainRunOutcome = { runId: string; ranked: number; unestimated: number; newCritical: number; summarySource: "LLM" | "DETERMINISTIC"; llm: LlmRunUsage; deliveries: Delivery[] };

/** Deterministic reports of every specialist (one transaction each) with their estimates. */
export async function analyseOrganisation(organizationId: string, opts: { now?: Date; specialists?: readonly SpecialistKey[]; beat?: () => Promise<void> } = {}) {
  const now = opts.now ?? new Date();
  const reports: SpecialistReport[] = [];
  for (const key of opts.specialists ?? SPECIALISTS) {
    await opts.beat?.();
    reports.push(await withOrg(organizationId, (tx) => runSpecialist(tx, organizationId, key, now)));
  }
  await opts.beat?.();
  const ctx = await withOrg(organizationId, (tx) => loadEstimationContext(tx, organizationId));
  const targets: ImpactTarget[] = [];
  for (const r of reports)
    for (const f of r.findings)
      if (f.target) {
        f.estimate = estimateImpact(ctx, f.target);
        targets.push(f.target);
      }
  return { reports, power: estimationPower(ctx, targets) };
}

const addUsage = (acc: LlmRunUsage, u: LlmUsage) => {
  acc.calls++;
  acc.inputTokens += u.inputTokens;
  acc.outputTokens += u.outputTokens;
  acc.model = u.model;
};

/** The LLM phase over deterministic reports. Returns the (possibly) narrated reports and the run's usage. */
export async function llmPhase(organizationId: string, llm: BrainLlm, reports: SpecialistReport[], opts: { signal?: AbortSignal } = {}) {
  const usage: LlmRunUsage = { model: llm.model, calls: 0, inputTokens: 0, outputTokens: 0, rejected: [] };
  // Specialists in parallel (network only; usage is recorded afterwards, sequentially).
  const results = await Promise.all(
    reports.map(async (r) => {
      if (!r.findings.length && r.coverage === "NOT_CONNECTED") return { r, res: null };
      return { r, res: await callStructured(llm, specialistSystem(r.specialist), frameData(`brain_${r.specialist}`, specialistInput(r)), SpecialistOutputSchema, opts) };
    }),
  );
  const out: SpecialistReport[] = [];
  for (const { r, res } of results) {
    if (!res) {
      out.push(r);
      continue;
    }
    addUsage(usage, res.usage);
    await recordBrainUsage(organizationId, res.usage);
    if (res.error) {
      usage.rejected.push({ scope: r.specialist, reason: res.error });
      out.push(r);
      continue;
    }
    const applied = applySpecialistOutput(r, res.parsed, res.usage);
    if (!applied.ok) {
      log.warn("brain.llm_rejected", { organizationId, scope: r.specialist, reason: applied.reason });
      usage.rejected.push({ scope: r.specialist, reason: applied.reason });
      out.push(r);
    } else out.push(applied.value);
  }
  return { reports: out, usage };
}

/** One synthesis call over the merged findings; null when rejected or failed. */
export async function synthesise(organizationId: string, llm: BrainLlm, input: ReturnType<typeof synthesisInput>, usage: LlmRunUsage, opts: { signal?: AbortSignal } = {}): Promise<Narrative | null> {
  const res = await callStructured(llm, SYNTHESIS_SYSTEM, frameData("brain_plan", input), SynthesisOutputSchema, opts);
  addUsage(usage, res.usage);
  await recordBrainUsage(organizationId, res.usage);
  if (res.error) {
    usage.rejected.push({ scope: "synthesis", reason: res.error });
    return null;
  }
  const v = validateSynthesis(res.parsed, input);
  if (!v.ok) {
    log.warn("brain.llm_rejected", { organizationId, scope: "synthesis", reason: v.reason });
    usage.rejected.push({ scope: "synthesis", reason: v.reason });
    return null;
  }
  return v.value;
}

export async function runBrain(organizationId: string, opts: BrainRunOptions = {}): Promise<BrainRunOutcome> {
  const now = opts.now ?? new Date();
  const beat = async () => {
    await opts.heartbeat?.().catch(() => undefined);
  };
  let runId = opts.runId ?? null;
  if (runId) {
    // A run queued by "Run now"; if its transaction has not committed yet the job retries.
    const existing = await withOrg(organizationId, (tx) => getRun(tx, organizationId, runId!));
    if (!existing) throw new Error("Brain run not found yet");
    if (existing.status === "DONE") return { runId, ranked: existing.rankedCount, unestimated: existing.unestimatedCount, newCritical: 0, summarySource: existing.summarySource, llm: existing.llmUsage ?? { model: null, calls: 0, inputTokens: 0, outputTokens: 0, rejected: [] }, deliveries: [] };
  } else runId = (await withOrg(organizationId, (tx) => createRun(tx, organizationId, opts.trigger ?? "SCHEDULED"))).id;
  await withOrg(organizationId, (tx) => markRunning(tx, organizationId, runId!, now));

  try {
    const { reports: base, power } = await analyseOrganisation(organizationId, { now, beat });
    let reports = base;
    let summary: Narrative | null = null;
    let usage: LlmRunUsage = { model: null, calls: 0, inputTokens: 0, outputTokens: 0, rejected: [] };
    const resolved = opts.llm === false ? { skipped: "Disabled for this run" } : await resolveBrainLlm(organizationId);
    if ("llm" in resolved) {
      await beat();
      const phase = await llmPhase(organizationId, resolved.llm, base, { signal: opts.signal });
      reports = phase.reports;
      usage = phase.usage;
      await beat();
      const merged = rankFindings(reports);
      summary = await synthesise(organizationId, resolved.llm, synthesisInput({ coverage: coverageMap(reports), ...merged, estimationPower: power }), usage, { signal: opts.signal });
    } else usage.skipped = resolved.skipped;

    const { ranked, unestimated } = rankFindings(reports);
    const narratives: Partial<Record<SpecialistKey, Narrative>> = {};
    for (const r of reports) if (r.narrative) narratives[r.specialist] = r.narrative;
    const result: BrainResult = { coverage: coverageMap(reports), ranked, unestimated, estimationPower: power, narratives, summary, llm: usage };
    await beat();
    const stored = await withOrg(organizationId, (tx) => storeRunResult(tx, organizationId, runId!, result, { now, emailConfigured: opts.emailConfigured }));
    log.info("brain.run_done", { organizationId, runId, ranked: ranked.length, unestimated: unestimated.length, llmCalls: usage.calls, rejected: usage.rejected.length });
    return { runId: runId!, ranked: ranked.length, unestimated: unestimated.length, newCritical: stored.newCritical, summarySource: summary ? "LLM" : "DETERMINISTIC", llm: usage, deliveries: stored.deliveries };
  } catch (e) {
    await withOrg(organizationId, (tx) => markFailed(tx, organizationId, runId!, (e as Error).message || "Brain run failed")).catch(() => undefined);
    throw e;
  }
}
