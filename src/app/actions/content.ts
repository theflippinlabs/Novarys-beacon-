"use server";

import { z } from "zod";
import { act, zId, zOptText } from "@/lib/actions";
import { enqueue } from "@/jobs/queue";
import { approveAsset, createAsset, getAsset, publishAsset, rejectAsset, saveEditedVersion } from "@/services/content";

const TYPES = z.enum(["LANDING_PAGE", "ARTICLE", "FAQ", "TUTORIAL", "COMPARISON", "RELEASE_ANNOUNCEMENT", "X_POST", "LINKEDIN_POST", "TIKTOK_SCRIPT", "SHORT_VIDEO_SCRIPT", "NEWSLETTER", "DIRECTORY_DESCRIPTION", "OUTREACH"]);

export async function createContentAction(fd: FormData) {
  return act(fd, "content:write", z.object({ productId: zId, type: TYPES, title: zOptText(200), targetQueryId: z.union([zId, z.literal("")]).optional(), brief: zOptText(2000), generate: z.string().optional(), useLlm: z.string().optional() }), async ({ tx, actor }, i) => {
    const asset = await createAsset(tx, actor, { productId: i.productId, type: i.type, title: i.title ?? undefined, targetQueryId: i.targetQueryId || null, brief: i.brief });
    if (i.generate) await enqueue("content.generate", { assetId: asset.id, userId: actor.userId, useLlm: Boolean(i.useLlm) }, { organizationId: actor.organizationId, idempotencyKey: `gen:${asset.id}:1` });
    return { redirect: `/content/${asset.id}`, ok: i.generate ? "Draft generation queued." : "Idea saved." };
  });
}

export async function generateContentAction(fd: FormData) {
  return act(fd, "content:write", z.object({ assetId: zId, useLlm: z.string().optional() }), async ({ tx, actor }, i) => {
    const asset = await getAsset(tx, actor.organizationId, i.assetId);
    await enqueue("content.generate", { assetId: asset.id, userId: actor.userId, useLlm: Boolean(i.useLlm) }, { organizationId: actor.organizationId, idempotencyKey: `gen:${asset.id}:${asset.currentVersion + 1}` });
    return { ok: "Generation queued — the draft appears when the worker completes it." };
  });
}

export async function saveVersionAction(fd: FormData) {
  return act(fd, "content:write", z.object({ assetId: zId, body: z.string().min(1).max(200_000), metaTitle: zOptText(120), metaDescription: zOptText(300) }), async ({ tx, actor }, i) => {
    const r = await saveEditedVersion(tx, actor, i.assetId, { body: i.body, metaTitle: i.metaTitle, metaDescription: i.metaDescription });
    return { ok: `Saved v${r.version.version}. Checks re-run: ${r.status.replace(/_/g, " ").toLowerCase()}.` };
  });
}

export async function approveContentAction(fd: FormData) {
  return act(fd, "content:approve", z.object({ assetId: zId }), async ({ tx, actor }, i) => {
    await approveAsset(tx, actor, i.assetId);
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
