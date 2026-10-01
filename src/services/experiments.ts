import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { experiments, products } from "@/db/schema";
import { evaluateExperiment, minSampleSizePerArm, type ExperimentArm } from "@/core/experiments/stats";
import { assertExperimentTransition, startBlockers, type ExperimentStatus } from "@/core/experiments/workflow";
import { canonicalEvent, LEGACY_ALIASES } from "@/core/conversions/events";
import { audit, type Actor } from "@/lib/audit";

type Experiment = typeof experiments.$inferSelect;

async function getExperiment(tx: Tx, organizationId: string, id: string) {
  const e = await tx.query.experiments.findFirst({ where: and(eq(experiments.id, id), eq(experiments.organizationId, organizationId)) });
  if (!e) throw new Error("Experiment not found");
  return e;
}

export async function createExperiment(
  tx: Tx,
  actor: Actor,
  input: { name: string; hypothesis: string; primaryMetric: string; signalToMonitor?: string | null; productId?: string | null; metricKey?: string | null; control?: ExperimentArm; variant?: ExperimentArm; recommendationId?: string | null },
) {
  if (input.productId) {
    const p = await tx.query.products.findFirst({ where: and(eq(products.id, input.productId), eq(products.organizationId, actor.organizationId)) });
    if (!p) throw new Error("Product not found");
  }
  const [e] = await tx
    .insert(experiments)
    .values({
      organizationId: actor.organizationId,
      name: input.name,
      hypothesis: input.hypothesis,
      primaryMetric: input.primaryMetric,
      signalToMonitor: input.signalToMonitor ?? null,
      productId: input.productId || null,
      metricKey: input.metricKey ? canonicalEvent(input.metricKey as never) : null,
      control: input.control ?? {},
      variant: input.variant ?? {},
      recommendationId: input.recommendationId ?? null,
    })
    .returning();
  await audit(tx, actor, "experiment.create", "experiment", e.id, { productId: e.productId });
  return e;
}

/** Design: arms, counted event, and the minimum sample size per arm from a baseline rate and a minimum detectable effect. */
export async function designExperiment(
  tx: Tx,
  actor: Actor,
  id: string,
  input: { control?: ExperimentArm; variant?: ExperimentArm; metricKey?: string | null; baselineRate?: number | null; minDetectableEffect?: number | null },
) {
  const e = await getExperiment(tx, actor.organizationId, id);
  if (e.status !== "DRAFT") throw new Error("The design is fixed once the experiment has started.");
  const baselineRate = input.baselineRate ?? e.baselineRate;
  const mde = input.minDetectableEffect ?? e.minDetectableEffect;
  const minSampleSize = baselineRate && mde ? minSampleSizePerArm(baselineRate, mde) : e.minSampleSize;
  await tx
    .update(experiments)
    .set({
      control: input.control ?? e.control,
      variant: input.variant ?? e.variant,
      metricKey: input.metricKey !== undefined ? (input.metricKey ? canonicalEvent(input.metricKey as never) : null) : e.metricKey,
      baselineRate: baselineRate ?? null,
      minDetectableEffect: mde ?? null,
      minSampleSize: minSampleSize ?? null,
    })
    .where(eq(experiments.id, e.id));
  await audit(tx, actor, "experiment.design", "experiment", e.id, { baselineRate, mde, minSampleSize });
  return { ...e, minSampleSize };
}

/**
 * Counts per arm from tracked events: units are distinct visitors (or event
 * rows without a visitor) with any event tagged properties.experiment = the
 * experiment id and properties.variant = control | variant; conversions are
 * those units with the counted event type.
 */
export async function trackedCounts(tx: Tx, organizationId: string, e: Pick<Experiment, "id" | "productId" | "metricKey" | "startsOn">) {
  const pf = e.productId ? sql`and product_id = ${e.productId}` : sql``;
  const since = e.startsOn ? sql`and occurred_at >= ${e.startsOn}::date` : sql``;
  const names = [e.metricKey ?? "", ...Object.entries(LEGACY_ALIASES).filter(([, v]) => v === e.metricKey).map(([k]) => k)];
  const metric = sql.join(names.map((x) => sql`${x}`), sql`, `);
  const r = await tx.execute<{ arm: string; n: number; c: number }>(sql`
    select lower(properties->>'variant') as arm,
      count(distinct coalesce(visitor_id, id::text))::int as n,
      count(distinct coalesce(visitor_id, id::text)) filter (where type::text in (${metric}))::int as c
    from conversion_events
    where organization_id = ${organizationId} ${pf} ${since} and properties->>'experiment' = ${e.id} and lower(properties->>'variant') in ('control', 'variant')
    group by 1`);
  const arm = (k: string) => r.rows.find((x) => x.arm === k);
  return { controlN: Number(arm("control")?.n ?? 0), controlConversions: Number(arm("control")?.c ?? 0), variantN: Number(arm("variant")?.n ?? 0), variantConversions: Number(arm("variant")?.c ?? 0) };
}

function resultFields(e: Pick<Experiment, "controlN" | "controlConversions" | "variantN" | "variantConversions" | "minSampleSize">, now: Date) {
  const r = evaluateExperiment({ controlN: e.controlN ?? undefined, controlConversions: e.controlConversions ?? undefined, variantN: e.variantN ?? undefined, variantConversions: e.variantConversions ?? undefined, minSampleSize: e.minSampleSize });
  return { winner: r.winner, pValue: r.pValue, confidence: r.confidence, testMethod: r.method, resultExplanation: r.explanation, resultComputedAt: now };
}

/** Refresh the counts from the tracker (running or in review) and recompute the statistical result. */
export async function refreshExperimentCounts(tx: Tx, actor: Actor, id: string, now = new Date()) {
  const e = await getExperiment(tx, actor.organizationId, id);
  if (e.countsSource === "MANUAL") throw new Error("These counts were entered manually; enter the new counts by hand or clear them first.");
  if (!e.metricKey) throw new Error("Choose the conversion event the experiment counts.");
  const counts = await trackedCounts(tx, actor.organizationId, e);
  const next = { ...e, ...counts, countsSource: "TRACKER" as const, countsUpdatedAt: now };
  await tx
    .update(experiments)
    .set({ ...counts, countsSource: "TRACKER", countsUpdatedAt: now, ...resultFields(next, now) })
    .where(eq(experiments.id, e.id));
  return { ...next, ...resultFields(next, now) };
}

/** Counts entered by a person (labelled "entered manually"), then the statistical result. */
export async function enterExperimentCounts(tx: Tx, actor: Actor, id: string, counts: { controlN: number; controlConversions: number; variantN: number; variantConversions: number } | null, now = new Date()) {
  const e = await getExperiment(tx, actor.organizationId, id);
  if (e.status === "CONCLUDED" || e.status === "ABANDONED") throw new Error("The experiment is closed.");
  if (counts && (counts.controlConversions > counts.controlN || counts.variantConversions > counts.variantN)) throw new Error("Conversions cannot exceed the sample size.");
  const next = { ...e, ...(counts ?? { controlN: null, controlConversions: null, variantN: null, variantConversions: null }) };
  await tx
    .update(experiments)
    .set({ controlN: next.controlN, controlConversions: next.controlConversions, variantN: next.variantN, variantConversions: next.variantConversions, countsSource: counts ? "MANUAL" : null, countsUpdatedAt: now, ...resultFields(next, now) })
    .where(eq(experiments.id, e.id));
  await audit(tx, actor, "experiment.counts", "experiment", e.id, counts ? { ...counts, source: "MANUAL" } : { cleared: true });
}

/**
 * Enforced, audited lifecycle (core/experiments/workflow.ts). Starting needs
 * a counted event and a minimum sample size; concluding stores the
 * statistical result, which declares a winner only above the minimum sample
 * with p < 0.05 (otherwise INCONCLUSIVE). The human note is kept as `result`.
 */
export async function setExperimentStatus(tx: Tx, actor: Actor, id: string, status: ExperimentStatus, note?: string | null, now = new Date()) {
  const e = await getExperiment(tx, actor.organizationId, id);
  assertExperimentTransition(e.status, status);
  if (status === "RUNNING" && e.status === "DRAFT") {
    const blockers = startBlockers(e);
    if (blockers.length) throw new Error(blockers[0]);
  }
  const today = now.toISOString().slice(0, 10);
  const closing = status === "CONCLUDED" || status === "ABANDONED";
  await tx
    .update(experiments)
    .set({
      status,
      ...(status === "RUNNING" && !e.startsOn ? { startsOn: today } : {}),
      ...(closing ? { endsOn: today, result: note ?? e.result } : {}),
      ...(status === "CONCLUDED" || status === "READY_FOR_REVIEW" ? resultFields(e, now) : {}),
    })
    .where(eq(experiments.id, e.id));
  await audit(tx, actor, "experiment.status", "experiment", e.id, { from: e.status, to: status, ...(status === "CONCLUDED" ? { winner: resultFields(e, now).winner } : {}) });
  return { ...e, status };
}
