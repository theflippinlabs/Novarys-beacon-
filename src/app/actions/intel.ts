"use server";

import { z } from "zod";
import { act, zId } from "@/lib/actions";
import { enqueue } from "@/jobs/queue";
import { draftFromGap, opportunityFromGap } from "@/services/content-gaps";
import { setCompetitorAliases } from "@/services/ai-visibility";
import { importSearchQueries, reclusterProduct } from "@/services/queries";
import { recomputeCoverage } from "@/services/discovery";

// ── Content gaps ────────────────────────────────────────────────────────
export async function gapOpportunityAction(fd: FormData) {
  return act(fd, "growth:write", z.object({ productId: zId, clusterId: zId }), async ({ tx, actor }, i) => {
    const { opportunity } = await opportunityFromGap(tx, actor, i.productId, i.clusterId);
    return { redirect: `/opportunities/${opportunity.id}`, ok: "Opportunity created from the content gap." };
  });
}

export async function gapDraftAction(fd: FormData) {
  return act(fd, "content:write", z.object({ productId: zId, clusterId: zId }), async ({ tx, actor }, i) => {
    const { asset } = await draftFromGap(tx, actor, i.productId, i.clusterId);
    await enqueue("content.generate", { assetId: asset.id, userId: actor.userId, baseVersion: 0, baseStatus: "IDEA" }, { organizationId: actor.organizationId, idempotencyKey: `gen:${asset.id}:1` });
    return { redirect: `/content/${asset.id}`, ok: "Draft generation queued from the content gap." };
  });
}

/** Re-cluster the product's queries, import measured search queries and recompute coverage (crawl, search data, Beacon pages). */
export async function refreshQueryIntelAction(fd: FormData) {
  return act(fd, "query:write", z.object({ productId: zId }), async ({ tx, actor }, i) => {
    const imported = await importSearchQueries(tx, actor.organizationId, i.productId);
    const c = await reclusterProduct(tx, actor.organizationId, i.productId);
    await recomputeCoverage(tx, actor.organizationId, i.productId);
    return { ok: imported.connected ? `${c.clusters} clusters, ${imported.inserted} queries imported from search data.` : `${c.clusters} clusters; search data not connected.` };
  });
}

// ── Competitors ─────────────────────────────────────────────────────────
export async function competitorAliasesAction(fd: FormData) {
  return act(fd, "query:write", z.object({ competitorId: zId, aliases: z.string().max(2000).default("") }), async ({ tx, actor }, i) => {
    const list = await setCompetitorAliases(tx, actor, i.competitorId, i.aliases.split(/[,\n]/));
    return { ok: list.length ? `Aliases saved: ${list.join(", ")}.` : "Aliases cleared." };
  });
}
