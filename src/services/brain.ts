import { and, desc, eq, gte, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { brainFindings, brainRuns } from "@/db/schema";
import type { Signal } from "@/core/notifications/notifications";
import { makeT } from "@/i18n/core";
import { audit, type Actor } from "@/lib/audit";
import { enqueue } from "@/jobs/queue";
import { dedupeKey, newCriticalFindings } from "@/brain/rank";
import type { BrainResult, Finding, SpecialistKey } from "@/brain/types";
import { applySignals } from "./notifications";
import { proposeFromFinding } from "./autopilot";

/**
 * Storage of Beacon Brain runs (tenant-scoped). The orchestrator
 * (src/brain/orchestrator.ts) computes; this module records runs, findings
 * and notifications, and serves the /brain page and the agent tools.
 */

export type BrainRun = typeof brainRuns.$inferSelect;
export type BrainFindingRow = typeof brainFindings.$inferSelect;
export type BrainTrigger = BrainRun["trigger"];

/** A QUEUED or RUNNING run older than this is considered abandoned and no longer blocks "Run now". */
export const ACTIVE_RUN_STALE_MS = 2 * 60 * 60_000;

export async function activeRun(tx: Tx, organizationId: string, now = new Date()) {
  return (
    (await tx.query.brainRuns.findFirst({
      where: and(eq(brainRuns.organizationId, organizationId), inArray(brainRuns.status, ["QUEUED", "RUNNING"]), gte(brainRuns.createdAt, new Date(now.getTime() - ACTIVE_RUN_STALE_MS))),
      orderBy: desc(brainRuns.createdAt),
    })) ?? null
  );
}

export async function createRun(tx: Tx, organizationId: string, trigger: BrainTrigger, requestedBy: string | null = null): Promise<BrainRun> {
  const [run] = await tx.insert(brainRuns).values({ organizationId, trigger, requestedBy, status: "QUEUED" }).returning();
  return run;
}

/**
 * "Run now" (page action or agent tool): records a QUEUED run and enqueues
 * `brain.run` for it. Refused while another run is queued or running. The
 * job starts a few seconds later so this transaction has committed.
 */
export async function queueBrainRun(tx: Tx, actor: Actor, trigger: Exclude<BrainTrigger, "SCHEDULED">, now = new Date()) {
  const active = await activeRun(tx, actor.organizationId, now);
  if (active) return { queued: false as const, run: active };
  const run = await createRun(tx, actor.organizationId, trigger, actor.userId ?? null);
  await enqueue("brain.run", { runId: run.id }, { organizationId: actor.organizationId, idempotencyKey: `brain:run:${run.id}`, runAt: new Date(now.getTime() + 3_000) });
  await audit(tx, actor, "brain.run.queue", "brain_run", run.id, { trigger });
  return { queued: true as const, run };
}

export async function getRun(tx: Tx, organizationId: string, runId: string) {
  return (await tx.query.brainRuns.findFirst({ where: and(eq(brainRuns.organizationId, organizationId), eq(brainRuns.id, runId)) })) ?? null;
}

export async function markRunning(tx: Tx, organizationId: string, runId: string, now = new Date()) {
  const [run] = await tx
    .update(brainRuns)
    .set({ status: "RUNNING", startedAt: now, error: null })
    .where(and(eq(brainRuns.organizationId, organizationId), eq(brainRuns.id, runId)))
    .returning();
  return run ?? null;
}

export async function markFailed(tx: Tx, organizationId: string, runId: string, error: string, now = new Date()) {
  await tx
    .update(brainRuns)
    .set({ status: "FAILED", finishedAt: now, error: error.slice(0, 500) })
    .where(and(eq(brainRuns.organizationId, organizationId), eq(brainRuns.id, runId)));
}

export async function latestDoneRun(tx: Tx, organizationId: string, opts: { before?: string } = {}) {
  const rows = await tx
    .select()
    .from(brainRuns)
    .where(and(eq(brainRuns.organizationId, organizationId), eq(brainRuns.status, "DONE")))
    .orderBy(desc(brainRuns.finishedAt), desc(brainRuns.createdAt))
    .limit(opts.before ? 5 : 1);
  return rows.find((r) => r.id !== opts.before) ?? null;
}

export async function runHistory(tx: Tx, organizationId: string, limit = 10) {
  return tx.select().from(brainRuns).where(eq(brainRuns.organizationId, organizationId)).orderBy(desc(brainRuns.createdAt)).limit(limit);
}

export async function runFindings(tx: Tx, organizationId: string, runId: string) {
  const rows = await tx
    .select()
    .from(brainFindings)
    .where(and(eq(brainFindings.organizationId, organizationId), eq(brainFindings.runId, runId)))
    .orderBy(brainFindings.rank);
  return { ranked: rows.filter((r) => r.estimable), unestimated: rows.filter((r) => !r.estimable) };
}

const en = makeT(null);

function findingRow(organizationId: string, runId: string, f: Finding, rank: number, estimable: boolean): typeof brainFindings.$inferInsert {
  return {
    organizationId,
    runId,
    specialist: f.specialist,
    rank,
    estimable,
    severity: f.severity,
    findingKey: dedupeKey(f),
    title: f.title,
    summary: f.summary,
    vars: f.vars ?? {},
    effort: f.effort,
    evidence: f.evidence,
    estimate: f.estimate ?? null,
    target: f.target ?? null,
    action: f.action,
    alsoFrom: f.alsoFrom ?? [],
    opportunityId: f.opportunityId ?? null,
    productId: f.productId ?? null,
  };
}

/**
 * Store a finished run: findings (ranked and non-estimable lists), the run
 * summary, and a notification for every CRITICAL finding that was not
 * critical in the previous finished run (notification fingerprints also
 * dedupe over 90 days). Returns the email/webhook deliveries to enqueue
 * after commit.
 */
export async function storeRunResult(tx: Tx, organizationId: string, runId: string, r: BrainResult, opts: { now?: Date; emailConfigured?: boolean } = {}) {
  const now = opts.now ?? new Date();
  const previous = await latestDoneRun(tx, organizationId, { before: runId });
  const prevCritical = previous
    ? new Set(
        (await tx.select({ key: brainFindings.findingKey }).from(brainFindings).where(and(eq(brainFindings.organizationId, organizationId), eq(brainFindings.runId, previous.id), eq(brainFindings.severity, "CRITICAL")))).map(
          (x) => x.key,
        ),
      )
    : new Set<string>();
  const rows = [...r.ranked.map((f, i) => findingRow(organizationId, runId, f, i + 1, true)), ...r.unestimated.map((f, i) => findingRow(organizationId, runId, f, i + 1, false))];
  // Batches keep each statement's parameter count bounded.
  for (let i = 0; i < rows.length; i += 100) await tx.insert(brainFindings).values(rows.slice(i, i + 100));
  await tx
    .update(brainRuns)
    .set({
      status: "DONE",
      finishedAt: now,
      coverage: r.coverage,
      executiveSummary: r.summary,
      summarySource: r.summary ? "LLM" : "DETERMINISTIC",
      narratives: r.narratives,
      estimationPower: r.estimationPower,
      llmUsage: r.llm,
      rankedCount: r.ranked.length,
      unestimatedCount: r.unestimated.length,
      error: null,
    })
    .where(and(eq(brainRuns.organizationId, organizationId), eq(brainRuns.id, runId)));

  const fresh = newCriticalFindings([...r.ranked, ...r.unestimated], prevCritical);
  const signals: Signal[] = fresh.map((f) => ({
    kind: "BRAIN_CRITICAL",
    severity: "CRITICAL",
    item: { fp: `brain:${dedupeKey(f)}`, key: f.title, vars: f.vars ?? {}, href: "/brain" },
  }));
  const applied = signals.length ? await applySignals(tx, organizationId, signals, now, { emailConfigured: opts.emailConfigured }) : { fresh: 0, digests: 0, deliveries: [] };
  return { newCritical: fresh.length, notified: applied.fresh, deliveries: applied.deliveries };
}

/** "Propose" on a stored finding: an autopilot recommendation waiting for a human decision. */
export async function proposeFinding(tx: Tx, actor: Actor, findingId: string) {
  const f = await tx.query.brainFindings.findFirst({ where: and(eq(brainFindings.organizationId, actor.organizationId), eq(brainFindings.id, findingId)) });
  if (!f) throw new Error("Finding not found");
  const row = await proposeFromFinding(tx, actor, {
    kind: `BRAIN_${f.specialist.toUpperCase()}`,
    title: en(f.title, f.vars),
    body: `From the Beacon Brain (${f.specialist.replace(/_/g, " ")}): ${en(f.summary, f.vars)}`,
    productId: f.productId,
    opportunityId: f.opportunityId,
  });
  return row;
}

export type SpecialistNarratives = Partial<Record<SpecialistKey, { en: string; fr: string }>>;
