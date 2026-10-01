"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { OPPORTUNITY_CONTENT_TYPES } from "@/core/content/types";
import {
  affiliates,
  aiVisibilityPrompts,
  campaigns,
  commissions,
  crossSellRules,
  distributionTargets,
  productRelationships,
  experiments,
  opportunities,
  products,
  recommendations,
  referralCodes,
} from "@/db/schema";
import { act, zCheckbox, zId, zList, zOptText, zOptUrl } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { enqueue } from "@/jobs/queue";
import { createAssetFromOpportunity } from "@/services/content";
import { addDistributionTarget, setDistributionStatus } from "@/services/distribution";
import { setOpportunityStatus } from "@/services/opportunities";
import { randomToken, hmac } from "@/lib/security/crypto";
import { safeReferralDestination } from "@/services/tracking";
import { addRelationship, RELATIONSHIP_TYPES, removeRelationship } from "@/services/ecosystem";
import { assertOwned } from "@/lib/owned";

// ── Opportunities ───────────────────────────────────────────────────────
export async function setOpportunityStatusAction(fd: FormData) {
  return act(fd, "growth:write", z.object({ id: zId, status: z.enum(["OPEN", "ACCEPTED", "IN_PROGRESS", "DONE", "DISMISSED"]) }), async ({ tx, actor }, i) => {
    await setOpportunityStatus(tx, actor, i.id, i.status);
    return { ok: `Opportunity ${i.status.toLowerCase().replace("_", " ")}.` };
  });
}

export async function toggleOpportunityActionStep(fd: FormData) {
  return act(fd, "growth:write", z.object({ id: zId, order: z.coerce.number().int() }), async ({ tx, actor }, i) => {
    const o = await tx.query.opportunities.findFirst({ where: and(eq(opportunities.id, i.id), eq(opportunities.organizationId, actor.organizationId)) });
    if (!o) throw new Error("Not found");
    await tx
      .update(opportunities)
      .set({ actions: o.actions.map((a) => (a.order === i.order ? { ...a, done: !a.done } : a)), status: o.status === "OPEN" ? "IN_PROGRESS" : o.status })
      .where(eq(opportunities.id, o.id));
    return {};
  });
}

export async function opportunityToContentAction(fd: FormData) {
  return act(fd, "content:write", z.object({ id: zId, type: z.enum(OPPORTUNITY_CONTENT_TYPES) }), async ({ tx, actor }, i) => {
    const asset = await createAssetFromOpportunity(tx, actor, i.id, i.type);
    await enqueue("content.generate", { assetId: asset.id, userId: actor.userId, baseVersion: 0, baseStatus: "IDEA" }, { organizationId: actor.organizationId, idempotencyKey: `gen:${asset.id}:1` });
    return { redirect: `/content/${asset.id}`, ok: "Draft generation queued from opportunity." };
  });
}

export async function regenerateOpportunitiesAction(fd: FormData) {
  return act(fd, "job:run", z.object({ productId: z.union([zId, z.literal("")]).optional() }), async ({ actor }, i) => {
    await enqueue("opportunities.generate", i.productId ? { productId: i.productId } : {}, { organizationId: actor.organizationId, idempotencyKey: `opps:manual:${actor.organizationId}:${Math.floor(Date.now() / 30_000)}` });
    return { ok: "Opportunity generation queued." };
  });
}

// ── AI visibility ───────────────────────────────────────────────────────
export async function addPromptAction(fd: FormData) {
  return act(fd, "query:write", z.object({ prompt: z.string().trim().min(5).max(500), productId: z.union([zId, z.literal("")]).optional(), category: zOptText(80) }), async ({ tx, actor }, i) => {
    await assertOwned(tx, products, i.productId, actor.organizationId, "Product not found");
    await tx.insert(aiVisibilityPrompts).values({ organizationId: actor.organizationId, prompt: i.prompt, productId: i.productId || null, category: i.category });
    return { ok: "Prompt added." };
  });
}

export async function togglePromptAction(fd: FormData) {
  return act(fd, "query:write", z.object({ id: zId, active: z.enum(["true", "false"]) }), async ({ tx, actor }, i) => {
    await tx.update(aiVisibilityPrompts).set({ active: i.active === "true" }).where(and(eq(aiVisibilityPrompts.id, i.id), eq(aiVisibilityPrompts.organizationId, actor.organizationId)));
    return { ok: "Updated." };
  });
}

export async function runAiTestsAction(fd: FormData) {
  return act(fd, "job:run", z.object({ promptId: z.union([zId, z.literal("")]).optional() }), async ({ actor }, i) => {
    await enqueue("ai_visibility.run", i.promptId ? { promptId: i.promptId } : {}, { organizationId: actor.organizationId, idempotencyKey: `aivis:manual:${i.promptId ?? "all"}:${Math.floor(Date.now() / 60_000)}` });
    return { ok: "Sampled AI-visibility tests queued." };
  });
}

// ── Distribution ────────────────────────────────────────────────────────
const KINDS = z.enum(["DIRECTORY", "LAUNCH_PLATFORM", "COMMUNITY", "SOCIAL_CHANNEL", "NEWSLETTER", "PARTNER", "AFFILIATE", "INFLUENCER", "AGENCY", "MEDIA", "BACKLINK"]);
const DSTATUS = z.enum(["DISCOVERED", "QUALIFIED", "PREPARED", "SUBMITTED", "PUBLISHED", "REJECTED", "FOLLOW_UP", "PERFORMING"]);

export async function addDistributionTargetAction(fd: FormData) {
  return act(fd, "distribution:write", z.object({ name: z.string().trim().min(2).max(120), kind: KINDS, url: zOptUrl, productId: z.union([zId, z.literal("")]).optional(), relevance: z.coerce.number().int().min(1).max(5).optional(), notes: zOptText(1000) }), async ({ tx, actor }, i) => {
    await addDistributionTarget(tx, actor, { name: i.name, kind: i.kind, url: i.url, productId: i.productId || null, relevance: i.relevance, notes: i.notes });
    return { ok: "Target added." };
  });
}

/**
 * Status transitions. SUBMITTED/PUBLISHED/PERFORMING require a recorded
 * approval from a user with `distribution:approve`; Beacon never submits to
 * third-party platforms on its own.
 */
export async function setDistributionStatusAction(fd: FormData) {
  return act(fd, "distribution:write", z.object({ id: zId, status: DSTATUS, publishedUrl: zOptUrl, followUpOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")).optional() }), async ({ tx, actor }, i) => {
    await setDistributionStatus(tx, actor, i.id, i.status, { publishedUrl: i.publishedUrl, followUpOn: i.followUpOn });
    return { ok: `Moved to ${i.status.replace("_", " ").toLowerCase()}.` };
  });
}

export async function approveSubmissionAction(fd: FormData) {
  return act(fd, "distribution:approve", z.object({ id: zId }), async ({ tx, actor }, i) => {
    await tx.update(distributionTargets).set({ submissionApprovedBy: actor.userId ?? null, submissionApprovedAt: new Date() }).where(and(eq(distributionTargets.id, i.id), eq(distributionTargets.organizationId, actor.organizationId)));
    await audit(tx, actor, "distribution.approve", "distribution_target", i.id);
    return { ok: "External submission approved." };
  });
}

export async function addCampaignAction(fd: FormData) {
  return act(
    fd,
    "growth:write",
    z.object({
      name: z.string().trim().min(2).max(120),
      channel: z.enum(["ORGANIC_SEARCH", "AI_REFERRAL", "REFERRAL", "AFFILIATE", "SOCIAL", "EMAIL", "PAID", "DIRECT", "CROSS_SELL", "OTHER"]),
      utmSource: z.string().trim().min(1).max(80),
      utmMedium: z.string().trim().min(1).max(80),
      utmCampaign: z.string().trim().min(1).max(120),
      productId: z.union([zId, z.literal("")]).optional(),
    }),
    async ({ tx, actor }, i) => {
      await assertOwned(tx, products, i.productId, actor.organizationId, "Product not found");
      await tx.insert(campaigns).values({ organizationId: actor.organizationId, name: i.name, channel: i.channel, utmSource: i.utmSource.toLowerCase(), utmMedium: i.utmMedium.toLowerCase(), utmCampaign: i.utmCampaign.toLowerCase(), productId: i.productId || null, status: "ACTIVE" });
      return { ok: "Campaign created." };
    },
  );
}

// ── Referrals & affiliates ──────────────────────────────────────────────
export async function addAffiliateAction(fd: FormData) {
  return act(fd, "revenue:write", z.object({ name: z.string().trim().min(2).max(120), email: z.string().email().optional().or(z.literal("")), commissionPct: z.coerce.number().min(0).max(90), commissionMonths: z.coerce.number().int().min(1).max(120), holdDays: z.coerce.number().int().min(0).max(180) }), async ({ tx, actor }, i) => {
    await tx.insert(affiliates).values({
      organizationId: actor.organizationId,
      name: i.name,
      contactEmailHash: i.email ? hmac(i.email.trim().toLowerCase(), "email") : null,
      commissionBps: Math.round(i.commissionPct * 100),
      commissionMonths: i.commissionMonths,
      holdDays: i.holdDays,
      status: "ACTIVE",
    });
    return { ok: "Affiliate added." };
  });
}

export async function createReferralCodeAction(fd: FormData) {
  return act(fd, "growth:write", z.object({ productId: zId, code: z.string().regex(/^[A-Za-z0-9_-]{3,40}$/).optional().or(z.literal("")), affiliateId: z.union([zId, z.literal("")]).optional(), destinationUrl: z.string().url(), campaignId: z.union([zId, z.literal("")]).optional() }), async ({ tx, actor }, i) => {
    const product = await tx.query.products.findFirst({ where: and(eq(products.id, i.productId), eq(products.organizationId, actor.organizationId)) });
    if (!product) throw new Error("Product not found");
    const dest = safeReferralDestination(i.destinationUrl, product.domain);
    if (!dest) throw new Error(`Destination must be an https URL on ${product.domain ?? "the product's domain (set it first)"}.`);
    await assertOwned(tx, affiliates, i.affiliateId, actor.organizationId, "Affiliate not found");
    await assertOwned(tx, campaigns, i.campaignId, actor.organizationId, "Campaign not found");
    const code = (i.code || randomToken(6).replace(/[^A-Za-z0-9]/g, "").slice(0, 8)).toUpperCase();
    await tx.insert(referralCodes).values({ organizationId: actor.organizationId, productId: product.id, code, affiliateId: i.affiliateId || null, campaignId: i.campaignId || null, destinationUrl: dest });
    await audit(tx, actor, "referral.create", "referral_code", code, { productId: product.id });
    return { ok: `Referral link /r/${code} created.` };
  });
}

export async function toggleReferralCodeAction(fd: FormData) {
  return act(fd, "growth:write", z.object({ id: zId, active: z.enum(["true", "false"]) }), async ({ tx, actor }, i) => {
    await tx.update(referralCodes).set({ active: i.active === "true" }).where(and(eq(referralCodes.id, i.id), eq(referralCodes.organizationId, actor.organizationId)));
    return { ok: "Updated." };
  });
}

export async function setCommissionStatusAction(fd: FormData) {
  return act(fd, "revenue:write", z.object({ id: zId, status: z.enum(["PENDING", "APPROVED", "PAID", "VOID", "ON_HOLD"]) }), async ({ tx, actor }, i) => {
    const c = await tx.query.commissions.findFirst({ where: and(eq(commissions.id, i.id), eq(commissions.organizationId, actor.organizationId)) });
    if (!c) throw new Error("Not found");
    if (i.status === "PAID" && c.status !== "APPROVED") throw new Error("Only approved commissions can be marked paid.");
    if (i.status === "APPROVED" && c.payableAfter > new Date()) throw new Error(`Hold period ends ${c.payableAfter.toISOString().slice(0, 10)}.`);
    await tx.update(commissions).set({ status: i.status, ...(i.status === "PAID" ? { paidAt: new Date() } : {}) }).where(eq(commissions.id, c.id));
    await audit(tx, actor, "commission.status", "commission", c.id, { from: c.status, to: i.status });
    return { ok: `Commission ${i.status.toLowerCase()}.` };
  });
}

// ── Autopilot: recommendations, experiments, reports ────────────────────
export async function decideRecommendationAction(fd: FormData) {
  return act(fd, "recommendation:decide", z.object({ id: zId, status: z.enum(["APPROVED", "REJECTED", "DONE"]) }), async ({ tx, actor }, i) => {
    await tx.update(recommendations).set({ status: i.status, decidedBy: actor.userId ?? null, decidedAt: new Date() }).where(and(eq(recommendations.id, i.id), eq(recommendations.organizationId, actor.organizationId)));
    await audit(tx, actor, "recommendation.decide", "recommendation", i.id, { status: i.status });
    return { ok: `Recommendation ${i.status.toLowerCase()}.` };
  });
}

export async function runReportAction(fd: FormData) {
  return act(fd, "job:run", z.object({ days: z.coerce.number().int().min(7).max(90).default(7) }), async ({ actor }, i) => {
    await enqueue("autopilot.report", { days: i.days }, { organizationId: actor.organizationId, idempotencyKey: `autopilot:manual:${actor.organizationId}:${Math.floor(Date.now() / 60_000)}` });
    return { ok: "Growth analysis queued." };
  });
}

export async function addExperimentAction(fd: FormData) {
  return act(fd, "growth:write", z.object({ name: z.string().trim().min(3).max(160), hypothesis: z.string().trim().min(10).max(1000), primaryMetric: z.string().trim().min(2).max(120), signalToMonitor: zOptText(300), productId: z.union([zId, z.literal("")]).optional() }), async ({ tx, actor }, i) => {
    await assertOwned(tx, products, i.productId, actor.organizationId, "Product not found");
    await tx.insert(experiments).values({ organizationId: actor.organizationId, name: i.name, hypothesis: i.hypothesis, primaryMetric: i.primaryMetric, signalToMonitor: i.signalToMonitor, productId: i.productId || null });
    return { ok: "Experiment drafted." };
  });
}

export async function setExperimentStatusAction(fd: FormData) {
  return act(fd, "growth:write", z.object({ id: zId, status: z.enum(["DRAFT", "RUNNING", "READY_FOR_REVIEW", "CONCLUDED", "ABANDONED"]), result: zOptText(2000) }), async ({ tx, actor }, i) => {
    const today = new Date().toISOString().slice(0, 10);
    await tx
      .update(experiments)
      .set({ status: i.status, ...(i.status === "RUNNING" ? { startsOn: today } : {}), ...(i.status === "CONCLUDED" || i.status === "ABANDONED" ? { endsOn: today, result: i.result } : {}) })
      .where(and(eq(experiments.id, i.id), eq(experiments.organizationId, actor.organizationId)));
    return { ok: `Experiment ${i.status.toLowerCase().replace(/_/g, " ")}.` };
  });
}

export async function addCrossSellRuleAction(fd: FormData) {
  return act(
    fd,
    "growth:write",
    z.object({
      name: z.string().trim().min(3).max(120),
      sourceProductId: zId,
      destinationProductId: zId,
      requiredTraits: zList,
      minDaysOnSource: z.coerce.number().int().min(0).max(365).default(0),
      message: z.string().trim().min(10).max(280),
      ctaLabel: z.string().trim().min(2).max(40),
      ctaUrl: z.string().url(),
      frequencyCapDays: z.coerce.number().int().min(1).max(365).default(14),
      maxImpressions: z.coerce.number().int().min(1).max(20).default(3),
      relationshipId: z.union([zId, z.literal("")]).optional(),
    }),
    async ({ tx, actor }, i) => {
      if (i.sourceProductId === i.destinationProductId) throw new Error("Source and destination must differ.");
      await assertOwned(tx, products, i.sourceProductId, actor.organizationId, "Product not found");
      const dest = await tx.query.products.findFirst({ where: and(eq(products.id, i.destinationProductId), eq(products.organizationId, actor.organizationId)) });
      if (!dest || !safeReferralDestination(i.ctaUrl, dest.domain)) throw new Error("CTA URL must be https on the destination product's domain.");
      if (i.relationshipId) {
        const rel = await tx.query.productRelationships.findFirst({ where: and(eq(productRelationships.id, i.relationshipId), eq(productRelationships.organizationId, actor.organizationId)) });
        if (!rel || rel.fromProductId !== i.sourceProductId || rel.toProductId !== i.destinationProductId) throw new Error("The relationship must link the same source and destination products.");
      }
      await tx.insert(crossSellRules).values({
        relationshipId: i.relationshipId || null,
        organizationId: actor.organizationId,
        name: i.name,
        sourceProductId: i.sourceProductId,
        destinationProductId: i.destinationProductId,
        conditions: { requiredTraits: i.requiredTraits, minDaysOnSource: i.minDaysOnSource || undefined, sourceStatuses: ["TRIALING", "ACTIVE"] },
        message: i.message,
        ctaLabel: i.ctaLabel,
        ctaUrl: i.ctaUrl,
        frequencyCapDays: i.frequencyCapDays,
        maxImpressions: i.maxImpressions,
      });
      return { ok: "Cross-sell rule created." };
    },
  );
}

export async function toggleCrossSellRuleAction(fd: FormData) {
  return act(fd, "growth:write", z.object({ id: zId, active: zCheckbox }), async ({ tx, actor }, i) => {
    await tx.update(crossSellRules).set({ active: i.active }).where(and(eq(crossSellRules.id, i.id), eq(crossSellRules.organizationId, actor.organizationId)));
    return { ok: i.active ? "Rule activated." : "Rule paused." };
  });
}

// ── Ecosystem graph ─────────────────────────────────────────────────────
export async function addRelationshipAction(fd: FormData) {
  return act(
    fd,
    "growth:write",
    z.object({ fromProductId: zId, toProductId: zId, type: z.enum(RELATIONSHIP_TYPES), rationale: z.string().trim().min(10).max(500), sourceId: z.union([zId, z.literal("")]).optional() }),
    async ({ tx, actor }, i) => {
      await addRelationship(tx, actor, { fromProductId: i.fromProductId, toProductId: i.toProductId, type: i.type, rationale: i.rationale, sourceId: i.sourceId || null });
      return { ok: "Relationship saved." };
    },
  );
}

export async function removeRelationshipAction(fd: FormData) {
  return act(fd, "growth:write", z.object({ id: zId }), async ({ tx, actor }, i) => {
    await removeRelationship(tx, actor, i.id);
    return { ok: "Relationship removed." };
  });
}
