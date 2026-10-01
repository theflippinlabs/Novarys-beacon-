import { and, eq, isNull } from "drizzle-orm";
import type { Tx } from "@/db";
import { products } from "@/db/schema";
import { computeCompleteness } from "@/core/knowledge/completeness";
import { loadProductGraph } from "@/core/knowledge/load";
import { buildAnswerBlocks } from "@/core/geo/entity";
import { seedDistributionTargets } from "./distribution";
import { generateQueryUniverse } from "./queries";
import { syncPagePlan } from "./discovery";
import { markStep, normalizeSteps, stepIndex, type FlowStepKey, type InfoPartKey, type StepStatus, type StoredOnboardingSteps } from "@/core/onboarding/steps";
import type { Product } from "@/core/knowledge/types";
import { audit, type Actor } from "@/lib/audit";
import { enqueue } from "@/jobs/queue";

/**
 * PRODUCT ANALYSIS: runs after onboarding (as a background job):
 * entity model → query map → content-gap analysis & suggested pages →
 * GEO/AEO questions → distribution suggestions. The technical audit,
 * opportunities and score are enqueued as follow-up jobs by the handler.
 */
export async function analyzeProduct(tx: Tx, organizationId: string, productId: string, opts: { completeOnboarding?: boolean } = {}) {
  const g = await loadProductGraph(tx, organizationId, productId);
  if (!g) throw new Error("Product not found");
  const completeness = computeCompleteness(g);
  const queries = await generateQueryUniverse(tx, organizationId, productId);
  const plan = await syncPagePlan(tx, organizationId, productId);
  const geo = buildAnswerBlocks(g);
  // Distribution: catalogue venues that fit the product (relevance from category, facets, stage and AI citation sources).
  const suggested = await seedDistributionTargets(tx, organizationId, productId, g);
  // Run from the onboarding QUERY UNIVERSE step, the analysis does not complete onboarding (the final step does).
  if (opts.completeOnboarding !== false) await tx.update(products).set({ onboardingCompletedAt: new Date() }).where(and(eq(products.id, productId), isNull(products.onboardingCompletedAt)));
  return { completeness: completeness.score, queries, pages: { planned: plan.planned, skipped: plan.skipped.length }, geo: { answers: geo.answers.length, gaps: geo.gaps.length }, distributionSuggested: suggested };
}

/** Launch checklist (Phase 2): see services/launch.ts. */
export { productLaunchChecklist as launchChecklist } from "./launch";

/** Normalised per-step onboarding status of a product (legacy integer progress is mapped once). */
export function stepsOf(p: Pick<Product, "onboardingSteps" | "onboardingStep" | "onboardingCompletedAt">): StoredOnboardingSteps {
  return normalizeSteps(p.onboardingSteps, { onboardingStep: p.onboardingStep, completedAt: p.onboardingCompletedAt });
}

/** Record a step (or PRODUCT INFORMATION sub-step) as done, skipped or pending; returns the new status map. */
export async function setOnboardingStep(tx: Tx, actor: Actor, productId: string, key: FlowStepKey | `info:${InfoPartKey}`, status: StepStatus) {
  const p = await tx.query.products.findFirst({ where: and(eq(products.id, productId), eq(products.organizationId, actor.organizationId)) });
  if (!p) throw new Error("Product not found");
  const steps = markStep(stepsOf(p), key, status);
  const flowKey = (key.startsWith("info:") ? "info" : key) as FlowStepKey;
  // The legacy integer keeps the furthest flow position reached (shown by older clients).
  await tx
    .update(products)
    .set({ onboardingSteps: steps, onboardingStep: Math.max(p.onboardingStep, stepIndex(flowKey) + 1) })
    .where(and(eq(products.id, productId), eq(products.organizationId, actor.organizationId)));
  if (status !== "pending") await audit(tx, actor, `onboarding.step.${status}`, "product", productId, { step: key });
  return steps;
}

/** Final step: onboarding is complete; the full product analysis (queries, page plan, opportunities, score) is queued. */
export async function finishOnboarding(tx: Tx, actor: Actor, productId: string) {
  const steps = await setOnboardingStep(tx, actor, productId, "score", "done");
  await tx.update(products).set({ onboardingCompletedAt: new Date() }).where(and(eq(products.id, productId), eq(products.organizationId, actor.organizationId), isNull(products.onboardingCompletedAt)));
  await enqueue("product.analyze", { productId }, { organizationId: actor.organizationId, idempotencyKey: `analyze:${productId}:${Date.now()}` });
  await audit(tx, actor, "onboarding.complete", "product", productId, { skipped: Object.entries(steps).filter(([, v]) => v.status === "skipped").map(([k]) => k) });
  return steps;
}
