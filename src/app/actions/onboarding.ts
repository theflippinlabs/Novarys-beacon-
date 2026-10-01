"use server";

import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { products } from "@/db/schema";
import { act, actStaged, zId } from "@/lib/actions";
import { isFlowStep, nextPosition, onboardingHref, type FlowStepKey } from "@/core/onboarding/steps";
import { finishOnboarding, setOnboardingStep } from "@/services/onboarding";
import { acceptProposal, extractFromWebsite, rejectProposals } from "@/services/extraction";
import { addDomain, getDomain, probeDomain, recordVerification } from "@/services/domains";
import { queueAudit } from "@/services/seo";
import { generateQueryUniverse } from "@/services/queries";
import { enqueue } from "@/jobs/queue";
import { audit } from "@/lib/audit";

/**
 * Onboarding v2 actions. Every step decision is stored per step (done or
 * skipped, with a timestamp), so the wizard resumes where it was left and a
 * skipped step is never shown as done.
 */
const zFlow = z.string().refine(isFlowStep, "unknown step");

async function productSlug(tx: Tx, organizationId: string, productId: string) {
  const p = await tx.query.products.findFirst({ where: and(eq(products.id, productId), eq(products.organizationId, organizationId)), columns: { slug: true } });
  if (!p) throw new Error("Product not found");
  return p.slug;
}

/** Continue (done) or skip a step that has no form of its own. The final step finishes onboarding. */
export async function advanceOnboardingAction(fd: FormData) {
  return act(fd, "product:write", z.object({ productId: zId, flow: zFlow, intent: z.enum(["next", "skip"]).default("next") }), async ({ tx, actor }, i) => {
    const slug = await productSlug(tx, actor.organizationId, i.productId);
    const step = i.flow as FlowStepKey;
    if (step === "info") throw new Error("Use the product information forms.");
    if (step === "score") {
      await finishOnboarding(tx, actor, i.productId);
      return { redirect: `/products/${slug}`, ok: "Onboarding complete, product analysis queued." };
    }
    await setOnboardingStep(tx, actor, i.productId, step, i.intent === "skip" ? "skipped" : "done");
    const next = nextPosition(step, null);
    return { redirect: next ? onboardingHref(slug, next) : `/products/${slug}` };
  });
}

/** WEBSITE: register the product's domain for ownership verification (admins). */
export async function onboardingAddDomainAction(fd: FormData) {
  return act(fd, "settings:manage", z.object({ productId: zId }), async ({ tx, actor }, i) => {
    const p = await tx.query.products.findFirst({ where: and(eq(products.id, i.productId), eq(products.organizationId, actor.organizationId)) });
    if (!p) throw new Error("Product not found");
    if (!p.domain) throw new Error("Enter the product domain first.");
    const row = await addDomain(tx, actor, p.domain);
    return { ok: row.verifiedAt ? "Domain already verified." : "Domain added. Publish the token, then choose Verify now." };
  });
}

/** WEBSITE: check ownership over the network (no transaction open), then record the result. */
export async function onboardingVerifyDomainAction(fd: FormData) {
  return actStaged(fd, "settings:manage", z.object({ id: zId }), async ({ actor, run }, i) => {
    const row = await run((tx) => getDomain(tx, actor.organizationId, i.id));
    if (!row) throw new Error("Domain not found");
    const probe = await probeDomain(row.domain, row.token);
    await run((tx) => recordVerification(tx, actor, i.id, probe));
    if (!probe.ok) throw new Error(`Verification failed for ${row.domain}: ${probe.error}`.slice(0, 280));
    return { ok: `${row.domain} is verified.` };
  });
}

/** WEBSITE: "Extract from website": crawl outside transactions and store UNVERIFIED proposals with their source URLs. */
export async function extractWebsiteAction(fd: FormData) {
  return actStaged(fd, "product:write", z.object({ productId: zId }), async ({ actor, run }, i) => {
    const r = await extractFromWebsite(run, actor, i.productId);
    return { ok: r.inserted ? `${r.inserted} new fact(s) proposed from ${r.pages} page(s). Review them below.` : `No new facts found on ${r.pages} page(s).` };
  });
}

export async function acceptProposalAction(fd: FormData) {
  return act(fd, "product:write", z.object({ id: zId }), async ({ tx, actor }, i) => {
    await acceptProposal(tx, actor, i.id);
    return { ok: "Added to the knowledge graph as unverified, with its source." };
  });
}

export async function rejectProposalAction(fd: FormData) {
  return act(fd, "product:write", z.object({ ids: z.array(zId).min(1).max(200) }), async ({ tx, actor }, i) => {
    const n = await rejectProposals(tx, actor, i.ids);
    return { ok: `${n} proposal(s) dismissed.` };
  });
}

/** INITIAL CRAWL: queue a technical audit of the verified domain; the step shows its live status. */
export async function initialCrawlAction(fd: FormData) {
  return act(fd, "job:run", z.object({ productId: zId }), async ({ tx, actor }, i) => {
    await queueAudit(tx, actor, i.productId, { maxPages: 50 });
    return { ok: "Initial crawl queued." };
  });
}

/** QUERY UNIVERSE: generate CANDIDATE queries and clusters from the knowledge graph (human curation follows). */
export async function generateUniverseAction(fd: FormData) {
  return act(fd, "query:write", z.object({ productId: zId }), async ({ tx, actor }, i) => {
    const r = await generateQueryUniverse(tx, actor.organizationId, i.productId);
    await audit(tx, actor, "queries.generate", "product", i.productId, { inserted: r.inserted, clusters: r.clusters });
    // Page plan, opportunities and the score follow in the background (onboarding stays open).
    await enqueue("product.analyze", { productId: i.productId, completeOnboarding: false }, { organizationId: actor.organizationId, idempotencyKey: `analyze:onboarding:${i.productId}:${Math.floor(Date.now() / 60_000)}` });
    return { ok: `${r.inserted} candidate queries in ${r.clusters} clusters. Activate the ones you want to track.` };
  });
}
