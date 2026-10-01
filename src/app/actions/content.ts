"use server";

import { eq } from "drizzle-orm";
import { z } from "zod";
import { organizations } from "@/db/schema";
import { act, zId, zOptText } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { enqueue } from "@/jobs/queue";
import { CONTENT_TYPES, REPURPOSE_TYPES } from "@/core/content/types";
import { approveAsset, createAsset, getAsset, publishAsset, rejectAsset, repurposeAsset, saveEditedVersion } from "@/services/content";

const TYPES = z.enum(CONTENT_TYPES);

export async function createContentAction(fd: FormData) {
  return act(fd, "content:write", z.object({ productId: zId, type: TYPES, title: zOptText(200), targetQueryId: z.union([zId, z.literal("")]).optional(), brief: zOptText(2000), generate: z.string().optional(), useLlm: z.string().optional() }), async ({ tx, actor }, i) => {
    const asset = await createAsset(tx, actor, { productId: i.productId, type: i.type, title: i.title ?? undefined, targetQueryId: i.targetQueryId || null, brief: i.brief });
    if (i.generate) await enqueue("content.generate", { assetId: asset.id, userId: actor.userId, useLlm: Boolean(i.useLlm), baseVersion: 0, baseStatus: "IDEA" }, { organizationId: actor.organizationId, idempotencyKey: `gen:${asset.id}:1` });
    return { redirect: `/content/${asset.id}`, ok: i.generate ? "Draft generation queued." : "Idea saved." };
  });
}

export async function generateContentAction(fd: FormData) {
  return act(fd, "content:write", z.object({ assetId: zId, useLlm: z.string().optional() }), async ({ tx, actor }, i) => {
    const asset = await getAsset(tx, actor.organizationId, i.assetId);
    // The job remembers the asset state it was requested for: it never overwrites a later human decision.
    await enqueue("content.generate", { assetId: asset.id, userId: actor.userId, useLlm: Boolean(i.useLlm), baseVersion: asset.currentVersion, baseStatus: asset.status }, { organizationId: actor.organizationId, idempotencyKey: `gen:${asset.id}:${asset.currentVersion + 1}` });
    return { ok: asset.publishedVersionId ? "Generation queued. The published version stays live until a new version is approved and published." : "Generation queued. The draft appears when the worker completes it." };
  });
}

export async function saveVersionAction(fd: FormData) {
  return act(fd, "content:write", z.object({ assetId: zId, body: z.string().min(1).max(200_000), metaTitle: zOptText(120), metaDescription: zOptText(300) }), async ({ tx, actor }, i) => {
    const r = await saveEditedVersion(tx, actor, i.assetId, { body: i.body, metaTitle: i.metaTitle, metaDescription: i.metaDescription });
    return { ok: `Saved v${r.version.version}. Checks re-run: ${r.status.replace(/_/g, " ").toLowerCase()}.` };
  });
}

export async function approveContentAction(fd: FormData) {
  return act(fd, "content:approve", z.object({ assetId: zId, acknowledge: z.string().optional() }), async ({ tx, actor }, i) => {
    await approveAsset(tx, actor, i.assetId, { acknowledge: i.acknowledge === "on" || i.acknowledge === "1" });
    return { ok: "Approved. Publish when ready." };
  });
}

export async function rejectContentAction(fd: FormData) {
  return act(fd, "content:approve", z.object({ assetId: zId, reason: z.string().trim().min(3).max(1000) }), async ({ tx, actor }, i) => {
    await rejectAsset(tx, actor, i.assetId, i.reason);
    return { ok: "Rejected." };
  });
}

export async function publishContentAction(fd: FormData) {
  return act(fd, "content:approve", z.object({ assetId: zId }), async ({ tx, actor }, i) => {
    await publishAsset(tx, actor, i.assetId);
    return { ok: "Published. Performance is measured from the next events received." };
  });
}

export async function repurposeContentAction(fd: FormData) {
  return act(fd, "content:write", z.object({ assetId: zId, types: z.array(z.enum(REPURPOSE_TYPES)).min(1).max(REPURPOSE_TYPES.length) }), async ({ tx, actor }, i) => {
    const r = await repurposeAsset(tx, actor, i.assetId, i.types);
    return { ok: `${r.derivatives.length} derivative draft(s) created. Each one needs its own approval.` };
  });
}

export async function updateContentPolicyAction(fd: FormData) {
  return act(fd, "settings:manage", z.object({ requireDistinctApprover: z.string().optional() }), async ({ tx, actor }, i) => {
    const org = await tx.query.organizations.findFirst({ where: eq(organizations.id, actor.organizationId) });
    if (!org) throw new Error("Organisation not found");
    const requireDistinctApprover = i.requireDistinctApprover === "on";
    await tx.update(organizations).set({ settings: { ...org.settings, content: { ...org.settings.content, requireDistinctApprover } } }).where(eq(organizations.id, org.id));
    await audit(tx, actor, "org.content_policy", "organization", org.id, { requireDistinctApprover });
    return { ok: "Content approval policy saved." };
  });
}
