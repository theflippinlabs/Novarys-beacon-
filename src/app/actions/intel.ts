"use server";

import { z } from "zod";
import { act, zId } from "@/lib/actions";
import { enqueue } from "@/jobs/queue";
import { draftFromGap, opportunityFromGap } from "@/services/content-gaps";
import { setCompetitorAliases } from "@/services/ai-visibility";
import { importSearchQueries, reclusterProduct } from "@/services/queries";
import { recomputeCoverage } from "@/services/discovery";
import { addWatch, assertCheckAllowed, removeWatch, setWatchActive } from "@/services/competitor-watch";
import { WATCH_KINDS } from "@/core/competitors/watch";

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

// ── Competitor page watch (changes are only notified for human review) ──
export async function addCompetitorWatchAction(fd: FormData) {
  return act(fd, "query:write", z.object({ competitorId: zId, url: z.string().trim().min(8).max(2000), kind: z.enum(WATCH_KINDS) }), async ({ tx, actor }, i) => {
    const w = await addWatch(tx, actor, i);
    await enqueue("competitor_watch.check", { watchId: w.id }, { organizationId: actor.organizationId, idempotencyKey: `cwatch-first:${w.id}` });
    return { ok: "Page added: its first check (the baseline) is queued." };
  });
}

export async function toggleCompetitorWatchAction(fd: FormData) {
  return act(fd, "query:write", z.object({ id: zId, active: z.enum(["true", "false"]) }), async ({ tx, actor }, i) => {
    await setWatchActive(tx, actor, i.id, i.active === "true");
    return { ok: i.active === "true" ? "Watch resumed." : "Watch paused." };
  });
}

export async function removeCompetitorWatchAction(fd: FormData) {
  return act(fd, "query:write", z.object({ id: zId }), async ({ tx, actor }, i) => {
    await removeWatch(tx, actor, i.id);
    return { ok: "Watched page removed with its history." };
  });
}

export async function checkCompetitorWatchAction(fd: FormData) {
  return act(fd, "job:run", z.object({ id: zId }), async ({ tx, actor }, i) => {
    await assertCheckAllowed(tx, actor.organizationId, i.id);
    await enqueue("competitor_watch.check", { watchId: i.id }, { organizationId: actor.organizationId, idempotencyKey: `cwatch-now:${i.id}:${Math.floor(Date.now() / 600_000)}` });
    return { ok: "Check queued. The result appears here in a moment." };
  });
}
