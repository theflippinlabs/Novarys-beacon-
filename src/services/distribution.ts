import { and, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { distributionTargets, products } from "@/db/schema";
import { REQUIRES_APPROVAL } from "@/core/distribution/catalog";
import { audit, type Actor } from "@/lib/audit";

type Target = typeof distributionTargets.$inferSelect;

export async function addDistributionTarget(
  tx: Tx,
  actor: Actor,
  input: { name: string; kind: Target["kind"]; url: string | null; productId: string | null; relevance?: number | null; notes?: string | null },
) {
  if (input.productId) {
    const p = await tx.query.products.findFirst({ where: and(eq(products.id, input.productId), eq(products.organizationId, actor.organizationId)) });
    if (!p) throw new Error("Product not found");
  }
  const [row] = await tx
    .insert(distributionTargets)
    .values({ organizationId: actor.organizationId, name: input.name, kind: input.kind, url: input.url, productId: input.productId, relevance: input.relevance, notes: input.notes })
    .returning();
  await audit(tx, actor, "distribution.add", "distribution_target", row.id, { kind: row.kind });
  return row;
}

/**
 * Status transitions. SUBMITTED/PUBLISHED/PERFORMING require a recorded
 * approval from a user with `distribution:approve` — Beacon never submits to
 * third-party platforms on its own.
 */
export async function setDistributionStatus(tx: Tx, actor: Actor, id: string, status: Target["status"], extra: { publishedUrl?: string | null; followUpOn?: string | null } = {}) {
  const t = await tx.query.distributionTargets.findFirst({ where: and(eq(distributionTargets.id, id), eq(distributionTargets.organizationId, actor.organizationId)) });
  if (!t) throw new Error("Not found");
  if (REQUIRES_APPROVAL.has(status) && !t.submissionApprovedAt) throw new Error("An approver must approve this external submission first.");
  await tx
    .update(distributionTargets)
    .set({ status, ...(status === "SUBMITTED" ? { submittedAt: new Date() } : {}), ...(extra.publishedUrl ? { publishedUrl: extra.publishedUrl } : {}), ...(extra.followUpOn ? { followUpOn: extra.followUpOn } : {}) })
    .where(eq(distributionTargets.id, t.id));
  await audit(tx, actor, "distribution.status", "distribution_target", t.id, { from: t.status, to: status });
  return { ...t, status };
}
