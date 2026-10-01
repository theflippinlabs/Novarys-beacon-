"use server";

import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { z } from "zod";
import { apiKeys, productChangelog, productCompetitors, productFacets, productFaqs, productPricing, productProofs, products, productSources } from "@/db/schema";
import { assertOwned } from "@/lib/owned";
import { act, zBoolTri, zCheckbox, zId, zList, zOptText, zOptUrl } from "@/lib/actions";
import { audit } from "@/lib/audit";
import { normalizeDomain, parseCtas, parseNamed, parsePricing, parseSocial, parseSources, splitLines } from "@/core/knowledge/parse";
import { setOnboardingStep } from "@/services/onboarding";
import { INFO_PARTS, isFlowStep, isInfoPart, nextPosition, onboardingHref, parsePosition, partKey, type FlowStepKey, type InfoPartKey } from "@/core/onboarding/steps";
import { createProduct, deleteProduct, getProductBySlug, replacePricing, syncCompetitors, syncFacets, syncSources, updateProduct } from "@/services/products";
import { generateApiKey } from "@/services/tracking";
import { addComparisonFact, addFaq } from "@/services/knowledge";
import { assertCanVerify, editFact, FACT_KINDS, setFactSource, setFactVerification, verifyProductClaims } from "@/services/provenance";
import { enqueue } from "@/jobs/queue";
import { mediaIdFromUrl } from "@/core/media/image";
import { env } from "@/lib/env";
import { saveIntegration } from "@/services/visibility";

export async function createProductAction(fd: FormData) {
  return act(fd, "product:write", z.object({ name: z.string().trim().min(2).max(80), slug: zOptText(80) }), async ({ tx, actor }, input) => {
    const p = await createProduct(tx, actor, input);
    await setOnboardingStep(tx, actor, p.id, "product", "done");
    return { redirect: `/products/${p.slug}/onboarding?step=website`, ok: `${p.name} created. Describe it once, Beacon does the rest.` };
  });
}

/** An https:// logo URL, or this site's own uploaded media URL (which is http:// in local development). */
const zLogoUrl = z
  .string()
  .max(2000)
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : null))
  .refine((v) => v === null || /^https:\/\/[^\s]+$/i.test(v) || mediaIdFromUrl(v, [env().BEACON_BASE_URL]) !== null, "must be an https:// URL");

const STATUS = z.enum(["UNKNOWN", "IN_DEVELOPMENT", "BETA", "LIVE", "DEPRECATED"]);

const StepSchema = z.object({
  productId: zId,
  /** Knowledge form section (1 identity, 2 website, 3..11 and 14 product information, 12 analytics, 13 search console). */
  step: z.coerce.number().int().min(1).max(14),
  /** Position in the onboarding flow (defaults to the step that holds the section). */
  flow: z.string().max(40).optional(),
  part: z.string().max(40).optional(),
  intent: z.enum(["next", "save", "skip"]).default("next"),
  name: z.string().trim().min(2).max(80).optional(),
  logoUrl: zLogoUrl,
  status: STATUS.optional(),
  releaseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).or(z.literal("")).optional(),
  domain: zOptText(200),
  documentationUrl: zOptUrl,
  pricingUrl: zOptUrl,
  languages: zList,
  supportedCountries: zList,
  social: zOptText(4000),
  category: zOptText(120),
  keywords: zList,
  apiAvailable: zBoolTri,
  freeTrial: zBoolTri,
  shortDescription: zOptText(300),
  fullDescription: zOptText(6000),
  howItWorks: zOptText(6000),
  audiences: zOptText(8000),
  industries: zOptText(8000),
  problems: zOptText(8000),
  features: zOptText(12000),
  useCases: zOptText(8000),
  pricing: zOptText(4000),
  competitors: zOptText(4000),
  integrations: zOptText(8000),
  sources: zOptText(8000),
  differentiators: zOptText(8000),
  ctas: zOptText(4000),
  gaPropertyId: zOptText(40),
  gaServiceAccount: zOptText(20000),
  gscSiteUrl: zOptText(300),
  gscServiceAccount: zOptText(20000),
});

/** Saves one onboarding step. Every field maps to the knowledge graph, the single source of truth. */
export async function saveOnboardingStepAction(fd: FormData) {
  return act(fd, "product:write", StepSchema, async ({ tx, actor }, i) => {
    const product = await tx.query.products.findFirst({ where: and(eq(products.id, i.productId), eq(products.organizationId, actor.organizationId)) });
    if (!product) throw new Error("Product not found");
    if (i.intent !== "skip") {
      switch (i.step) {
        case 1:
          await updateProduct(tx, actor, product.id, { name: i.name ?? product.name, logoUrl: i.logoUrl, status: i.status ?? product.status, releaseDate: i.releaseDate || null });
          break;
        case 2: {
          const domain = i.domain ? normalizeDomain(i.domain) : null;
          if (i.domain && !domain) throw new Error("Enter a valid domain, e.g. example.com");
          await updateProduct(tx, actor, product.id, { domain, documentationUrl: i.documentationUrl, pricingUrl: i.pricingUrl, languages: i.languages.map((l) => l.toLowerCase().slice(0, 10)), supportedCountries: i.supportedCountries.map((c) => c.toUpperCase().slice(0, 10)), socialAccounts: parseSocial(i.social) });
          break;
        }
        case 3:
          await updateProduct(tx, actor, product.id, { category: i.category, keywords: i.keywords.slice(0, 30), apiAvailable: i.apiAvailable, freeTrial: i.freeTrial });
          break;
        case 4:
          await updateProduct(tx, actor, product.id, { shortDescription: i.shortDescription, fullDescription: i.fullDescription, howItWorks: i.howItWorks });
          break;
        case 5:
          await syncFacets(tx, actor, product.id, "AUDIENCE", parseNamed(i.audiences));
          await syncFacets(tx, actor, product.id, "INDUSTRY", parseNamed(i.industries));
          break;
        case 6:
          await syncFacets(tx, actor, product.id, "PROBLEM", parseNamed(i.problems));
          break;
        case 7:
          await syncFacets(tx, actor, product.id, "FEATURE", parseNamed(i.features));
          await syncFacets(tx, actor, product.id, "USE_CASE", parseNamed(i.useCases));
          break;
        case 8:
          await replacePricing(tx, actor, product.id, parsePricing(i.pricing));
          break;
        case 9:
          await syncCompetitors(
            tx,
            actor,
            product.id,
            splitLines(i.competitors, 30).map((l) => {
              const [name, domain] = l.split("|").map((s) => s.trim());
              return { name: name.slice(0, 80), domain: normalizeDomain(domain) };
            }),
          );
          break;
        case 10:
          await syncFacets(tx, actor, product.id, "INTEGRATION", parseNamed(i.integrations));
          break;
        case 11:
          await syncSources(tx, actor, product.id, parseSources(i.sources));
          await syncFacets(tx, actor, product.id, "DIFFERENTIATOR", parseNamed(i.differentiators));
          break;
        case 12:
          if (i.gaPropertyId) {
            const integ = await saveIntegration(tx, actor, { provider: "GOOGLE_ANALYTICS", productId: product.id, config: { propertyId: i.gaPropertyId }, secret: i.gaServiceAccount ? { serviceAccountJson: i.gaServiceAccount } : null });
            // Saving never marks it connected: the first sync tests the credentials (CONNECTED, ERROR or EXPIRED).
            await enqueue("integration.sync", { integrationId: integ.id }, { organizationId: actor.organizationId, idempotencyKey: `sync:onboarding:${integ.id}:${Math.floor(Date.now() / 60_000)}` });
          }
          break;
        case 13:
          if (i.gscSiteUrl) {
            const integ = await saveIntegration(tx, actor, { provider: "GOOGLE_SEARCH_CONSOLE", productId: product.id, config: { siteUrl: i.gscSiteUrl }, secret: i.gscServiceAccount ? { serviceAccountJson: i.gscServiceAccount } : null });
            // The first successful sync marks it CONNECTED and queues the 16-month backfill.
            await enqueue("integration.sync", { integrationId: integ.id }, { organizationId: actor.organizationId, idempotencyKey: `sync:onboarding:${integ.id}:${Math.floor(Date.now() / 60_000)}` });
          }
          break;
        case 14:
          await updateProduct(tx, actor, product.id, { conversionUrls: parseCtas(i.ctas) });
          break;
      }
    }
    const pos = isFlowStep(i.flow) ? { step: i.flow as FlowStepKey, part: isInfoPart(i.part) ? (i.part as InfoPartKey) : null } : parsePosition(String(i.step), undefined);
    if (pos && i.intent !== "save") {
      const key = pos.step === "info" ? partKey(pos.part ?? INFO_PARTS[0].key) : pos.step;
      await setOnboardingStep(tx, actor, product.id, key, i.intent === "skip" ? "skipped" : "done");
    }
    if (i.intent === "save") return { ok: "Saved." };
    const next = pos ? nextPosition(pos.step, pos.part) : null;
    return { redirect: next ? onboardingHref(product.slug, next) : `/products/${product.slug}` };
  });
}

export async function runProductAnalysisAction(fd: FormData) {
  return act(fd, "job:run", z.object({ productId: zId }), async ({ actor }, i) => {
    await enqueue("product.analyze", { productId: i.productId }, { organizationId: actor.organizationId, idempotencyKey: `analyze:${i.productId}:${Math.floor(Date.now() / 60_000)}` });
    return { ok: "Product analysis queued. Results appear as the worker completes each step." };
  });
}

const TABLES = { facet: productFacets, pricing: productPricing, faq: productFaqs, proof: productProofs } as const;
const VERIFICATION = z.enum(["UNVERIFIED", "NEEDS_REVIEW", "VERIFIED", "REJECTED"]);

/** Verification is a human decision reserved to `fact:verify` holders (owners and admins); VERIFIED needs a source. */
export async function setVerificationAction(fd: FormData) {
  return act(fd, "fact:verify", z.object({ kind: z.enum(FACT_KINDS), id: zId, verification: VERIFICATION, sourceId: z.union([zId, z.literal("")]).optional() }), async ({ tx, actor }, i) => {
    await setFactVerification(tx, actor, { kind: i.kind, id: i.id, verification: i.verification, sourceId: i.sourceId || null });
    return { ok: `Marked ${i.verification.toLowerCase().replace("_", " ")}.` };
  });
}

/** Linking a different source to a verified fact sends it back to review. */
export async function setSourceAction(fd: FormData) {
  return act(fd, "product:write", z.object({ kind: z.enum(FACT_KINDS), id: zId, sourceId: z.union([zId, z.literal("")]) }), async ({ tx, actor }, i) => {
    const r = await setFactSource(tx, actor, { kind: i.kind, id: i.id, sourceId: i.sourceId || null });
    return { ok: r.changed && r.verification === "NEEDS_REVIEW" ? "Source linked. The fact needs a new review." : "Source linked." };
  });
}

export async function deleteKnowledgeAction(fd: FormData) {
  return act(fd, "product:write", z.object({ kind: z.enum(["facet", "pricing", "faq", "proof", "changelog"]), id: zId }), async ({ tx, actor }, i) => {
    const t = i.kind === "changelog" ? productChangelog : TABLES[i.kind];
    await tx.delete(t).where(and(eq(t.id, i.id), eq(t.organizationId, actor.organizationId)));
    await audit(tx, actor, "knowledge.delete", i.kind, i.id);
    return { ok: "Removed." };
  });
}

export async function addFaqAction(fd: FormData) {
  return act(fd, "product:write", z.object({ productId: zId, question: z.string().trim().min(5).max(300), answer: z.string().trim().min(10).max(3000), sourceId: z.union([zId, z.literal("")]).optional() }), async ({ tx, actor }, i) => {
    await assertOwned(tx, products, i.productId, actor.organizationId, "Product not found");
    await assertOwned(tx, productSources, i.sourceId, actor.organizationId, "Source not found");
    await addFaq(tx, actor, i.productId, { question: i.question, answer: i.answer, sourceId: i.sourceId || null });
    return { ok: "FAQ added (unverified until reviewed)." };
  });
}

export async function addProofAction(fd: FormData) {
  return act(
    fd,
    "product:write",
    z.object({
      productId: zId,
      kind: z.enum(["TESTIMONIAL", "CASE_STUDY", "METRIC", "AWARD", "REVIEW", "CERTIFICATION"]),
      title: z.string().trim().min(2).max(200),
      content: z.string().trim().min(5).max(4000),
      attribution: zOptText(200),
      sourceId: z.union([zId, z.literal("")]).optional(),
      publishable: zCheckbox,
    }),
    async ({ tx, actor }, i) => {
      await assertOwned(tx, products, i.productId, actor.organizationId, "Product not found");
      await assertOwned(tx, productSources, i.sourceId, actor.organizationId, "Source not found");
      await tx.insert(productProofs).values({ organizationId: actor.organizationId, productId: i.productId, kind: i.kind, title: i.title, content: i.content, attribution: i.attribution, sourceId: i.sourceId || null, publishable: i.publishable });
      return { ok: "Proof added. It is only used publicly once verified and marked publishable." };
    },
  );
}

export async function addChangelogAction(fd: FormData) {
  return act(fd, "product:write", z.object({ productId: zId, version: zOptText(40), releasedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), title: z.string().trim().min(2).max(200), body: zOptText(6000), sourceId: z.union([zId, z.literal("")]).optional() }), async ({ tx, actor }, i) => {
    await assertOwned(tx, products, i.productId, actor.organizationId, "Product not found");
    await assertOwned(tx, productSources, i.sourceId, actor.organizationId, "Source not found");
    await tx.insert(productChangelog).values({ organizationId: actor.organizationId, productId: i.productId, version: i.version, releasedOn: i.releasedOn, title: i.title, body: i.body, sourceId: i.sourceId || null });
    return { ok: "Changelog entry added." };
  });
}

export async function addComparisonFactAction(fd: FormData) {
  return act(
    fd,
    "product:write",
    z.object({ productId: zId, competitorId: zId, dimension: z.string().trim().min(2).max(120), product: z.string().trim().min(1).max(300), competitor: z.string().trim().min(1).max(300), sourceUrl: z.string().url().refine((u) => u.startsWith("https://"), "must be https"), verified: zCheckbox }),
    async ({ tx, actor }, i) => {
      // Recording a comparison fact as verified is a verification: it needs `fact:verify`.
      if (i.verified) await assertCanVerify(tx, actor);
      await addComparisonFact(tx, actor, i);
      return { ok: "Comparison fact added." };
    },
  );
}

export async function removeComparisonFactAction(fd: FormData) {
  return act(fd, "product:write", z.object({ productId: zId, competitorId: zId, index: z.coerce.number().int().min(0) }), async ({ tx, actor }, i) => {
    const link = await tx.query.productCompetitors.findFirst({ where: and(eq(productCompetitors.productId, i.productId), eq(productCompetitors.competitorId, i.competitorId), eq(productCompetitors.organizationId, actor.organizationId)) });
    if (!link) throw new Error("Not found");
    await tx
      .update(productCompetitors)
      .set({ comparisonFacts: link.comparisonFacts.filter((_, idx) => idx !== i.index) })
      .where(and(eq(productCompetitors.productId, i.productId), eq(productCompetitors.competitorId, i.competitorId)));
    return { ok: "Comparison fact removed." };
  });
}

/** Verify the product's current scalar claims (each needs a source: its own or the one chosen here). */
export async function markProductVerifiedAction(fd: FormData) {
  return act(fd, "fact:verify", z.object({ productId: zId, sourceId: z.union([zId, z.literal("")]).optional() }), async ({ tx, actor }, i) => {
    const r = await verifyProductClaims(tx, actor, i.productId, i.sourceId || null);
    if (!r.verified && r.skipped) throw new Error("Choose the source these facts were checked against: every verified fact must trace back to a source.");
    if (r.skipped) return { ok: `${r.verified} core fact(s) verified; ${r.skipped} still need a source.` };
    return { ok: "Core product description marked as human-verified." };
  });
}

export async function createApiKeyAction(fd: FormData) {
  return act(fd, "apikey:manage", z.object({ productSlug: z.string().max(80), kind: z.enum(["PUBLISHABLE", "SECRET"]), name: z.string().trim().min(2).max(80), allowedOrigins: zList }), async ({ tx, actor }, i) => {
    const product = await getProductBySlug(tx, actor.organizationId, i.productSlug);
    const { key, prefix, keyHash } = generateApiKey(i.kind);
    const [row] = await tx
      .insert(apiKeys)
      .values({
        organizationId: actor.organizationId,
        productId: product.id,
        name: i.name,
        kind: i.kind,
        prefix,
        keyHash,
        allowedOrigins: i.allowedOrigins.map((o) => o.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase()),
        scopes: i.kind === "SECRET" ? ["events:write", "revenue:write", "identity:write", "crosssell:read"] : ["events:write"],
        createdBy: actor.userId ?? null,
      })
      .returning();
    await audit(tx, actor, "apikey.create", "api_key", row.id, { kind: i.kind, prefix });
    // The raw key is shown once via a short-lived, path-scoped httpOnly cookie (never in a URL or log); only its HMAC is stored.
    (await cookies()).set("beacon_new_key", key, { httpOnly: true, sameSite: "strict", secure: process.env.NODE_ENV === "production", maxAge: 120, path: `/products/${product.slug}/tracking` });
    return { redirect: `/products/${product.slug}/tracking`, ok: "Key created. Copy it now: it will not be shown again." };
  });
}

export async function revokeApiKeyAction(fd: FormData) {
  return act(fd, "apikey:manage", z.object({ id: zId }), async ({ tx, actor }, i) => {
    await tx.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.id, i.id), eq(apiKeys.organizationId, actor.organizationId)));
    await audit(tx, actor, "apikey.revoke", "api_key", i.id);
    return { ok: "Key revoked." };
  });
}

export async function updateFacetAction(fd: FormData) {
  return act(fd, "product:write", z.object({ id: zId, description: zOptText(2000) }), async ({ tx, actor }, i) => {
    const r = await editFact(tx, actor, "facet", i.id, { description: i.description });
    return { ok: r.changed && r.verification === "NEEDS_REVIEW" ? "Updated and marked for review." : "Updated." };
  });
}

/** Owners and admins delete a product after typing its name to confirm. */
export async function deleteProductAction(fd: FormData) {
  return act(fd, "product:delete", z.object({ productId: zId, confirm: z.string().max(200) }), async ({ tx, actor }, i) => {
    const p = await tx.query.products.findFirst({ where: and(eq(products.id, i.productId), eq(products.organizationId, actor.organizationId)) });
    if (!p) throw new Error("Product not found");
    if (i.confirm.trim().toLocaleLowerCase() !== p.name.trim().toLocaleLowerCase()) throw new Error("Type the product name exactly to confirm the deletion.");
    await deleteProduct(tx, actor, p.id);
    return { ok: `Product “${p.name}” deleted.`, redirect: "/products" };
  });
}
