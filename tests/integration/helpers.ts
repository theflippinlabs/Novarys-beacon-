import { randomUUID } from "node:crypto";
import { withOrg } from "@/db";
import {
  apiKeys,
  competitors,
  productChangelog,
  productCompetitors,
  productFacets,
  productFaqs,
  productPricing,
  productProofs,
  products,
  productSources,
} from "@/db/schema";
import { createOrganizationWithOwner } from "@/lib/auth/service";
import type { Actor } from "@/lib/audit";
import { slugify } from "@/core/util/text";
import { generateApiKey, type ApiKeyKind } from "@/services/tracking";

export const PASSWORD = "correct horse battery 42";

export const uid = () => randomUUID().slice(0, 8);

/** Fresh organisation + owner for a test file (unique slug and email). */
export async function newOrg(label = "it") {
  const id = uid();
  const email = `${label}-${id}@example.test`;
  const { org, user } = await createOrganizationWithOwner({ orgName: `Org ${label} ${id}`, orgSlug: `${label}-${id}`, email, name: `Owner ${id}`, password: PASSWORD });
  const actor: Actor = { organizationId: org.id, userId: user.id, actorType: "USER" };
  return { org, user, actor, email };
}

/**
 * Seed a complete, verified knowledge graph (mirrors tests/unit/fixtures/graph.ts
 * `completeGraph`) so content generation passes the fact and SEO checks.
 */
export async function seedCompleteProduct(
  organizationId: string,
  opts: { name?: string; slug?: string; domain?: string; onboarded?: boolean; competitorName?: string } = {},
) {
  const name = opts.name ?? "Beacon Live";
  const slug = opts.slug ?? slugify(name);
  const domain = opts.domain ?? `${slug}.example`;
  const competitorName = opts.competitorName ?? `Rival ${uid()}`;
  return withOrg(organizationId, async (tx) => {
    const [p] = await tx
      .insert(products)
      .values({
        organizationId,
        slug,
        name,
        domain,
        shortDescription: "Real-time moderation for TikTok live streams run by creators and agencies.",
        fullDescription: `${name} filters spam and abusive comments in TikTok live chats so creators and agencies can keep streams safe.`,
        howItWorks: `1. Connect your TikTok account.\n2. Choose keyword filters.\n3. Go live and let ${name} hide spam.`,
        category: "Live moderation",
        status: "LIVE",
        languages: ["en"],
        apiAvailable: false,
        freeTrial: true,
        pricingUrl: `https://${domain}/pricing`,
        documentationUrl: `https://${domain}/docs`,
        conversionUrls: [{ label: "Start free trial", url: `https://${domain}/signup`, kind: "TRY_FREE" }],
        socialAccounts: [{ network: "x", url: `https://x.com/${slug}` }],
        keywords: ["tiktok live moderation"],
        lastVerifiedAt: new Date(),
        onboardingCompletedAt: opts.onboarded ? new Date() : null,
      })
      .returning();
    const [site, docs, pricingSrc] = await tx
      .insert(productSources)
      .values([
        { organizationId, productId: p.id, url: `https://${domain}/`, title: name, kind: "WEBSITE" },
        { organizationId, productId: p.id, url: `https://${domain}/docs`, title: "Docs", kind: "DOCUMENTATION" },
        { organizationId, productId: p.id, url: `https://${domain}/pricing`, title: "Pricing", kind: "PRICING" },
      ])
      .returning();
    const facet = (kind: (typeof productFacets.$inferInsert)["kind"], fname: string, description: string, sourceId: string, i: number) => ({
      organizationId,
      productId: p.id,
      kind,
      slug: slugify(fname),
      name: fname,
      description,
      sourceId,
      verification: "VERIFIED" as const,
      sortOrder: i,
    });
    await tx.insert(productFacets).values([
      facet("FEATURE", "Keyword filters", "Hide live comments that contain blocked keywords or phrases.", docs.id, 0),
      facet("FEATURE", "Spam detection", "Detect repeated spam messages in live chat automatically.", docs.id, 1),
      facet("FEATURE", "Moderator dashboard", "Review hidden comments and moderator actions in one dashboard.", docs.id, 2),
      facet("FEATURE", "Team roles", "Invite moderators to a shared workspace and assign each of them a role per stream.", docs.id, 3),
      facet("FEATURE", "Stream reports", "Download a report after every stream listing hidden comments, blocked users and peak chat activity.", docs.id, 4),
      facet("USE_CASE", "Moderating large live events", "Keep chat readable during big live events where thousands of viewers comment at the same time.", site.id, 0),
      facet("AUDIENCE", "TikTok agencies", "Agencies that manage many TikTok live creators.", site.id, 0),
      facet("PROBLEM", "Spam in TikTok live chat", "Spam and abusive comments disrupt TikTok live streams.", site.id, 0),
      facet("INTEGRATION", "TikTok", "Connects to TikTok live via the official account login.", docs.id, 0),
    ]);
    await tx.insert(productPricing).values({ organizationId, productId: p.id, planName: "Pro", priceCents: 2900, currency: "EUR", interval: "MONTH", trialDays: 14, sourceId: pricingSrc.id, verification: "VERIFIED" });
    await tx.insert(productFaqs).values([
      { organizationId, productId: p.id, question: `Does ${name} work with TikTok live?`, answer: `Yes, ${name} moderates TikTok live chats in real time.`, sourceId: site.id, verification: "VERIFIED", sortOrder: 0 },
      { organizationId, productId: p.id, question: `Can several moderators share one ${name} workspace?`, answer: "Yes, you can invite moderators to a shared workspace and assign each of them a role per stream.", sourceId: docs.id, verification: "VERIFIED", sortOrder: 1 },
      { organizationId, productId: p.id, question: `Is there a free trial of ${name}?`, answer: "Yes, the Pro plan includes a 14-day free trial before the monthly subscription starts.", sourceId: pricingSrc.id, verification: "VERIFIED", sortOrder: 2 },
    ]);
    await tx.insert(productProofs).values({ organizationId, productId: p.id, kind: "TESTIMONIAL", title: "Customer quote", content: "It saved our moderators hours every week.", attribution: "Jane, Agency lead", verification: "VERIFIED", publishable: true });
    await tx.insert(productChangelog).values({ organizationId, productId: p.id, version: "1.2.0", releasedOn: "2026-01-10", title: "Keyword filters", body: "Added keyword filters for live chat." });
    const [comp] = await tx.insert(competitors).values({ organizationId, name: competitorName, slug: slugify(competitorName) }).returning();
    await tx.insert(productCompetitors).values({
      organizationId,
      productId: p.id,
      competitorId: comp.id,
      comparisonFacts: [1, 2, 3].map((i) => ({ dimension: `Dimension ${i}`, product: `${name} value ${i}`, competitor: `Rival value ${i}`, sourceUrl: `https://rival.example/pricing#${i}`, verifiedAt: "2026-01-01" })),
    });
    return { product: p, competitor: comp, sources: { site, docs, pricingSrc } };
  });
}

/** Create an API key row and return the raw key. */
export async function createKey(organizationId: string, kind: ApiKeyKind, opts: { productId?: string | null; scopes?: string[]; allowedOrigins?: string[] } = {}) {
  const k = generateApiKey(kind);
  await withOrg(organizationId, (tx) =>
    tx.insert(apiKeys).values({ organizationId, productId: opts.productId ?? null, name: `${kind} ${uid()}`, kind, prefix: k.prefix, keyHash: k.keyHash, scopes: opts.scopes ?? [], allowedOrigins: opts.allowedOrigins ?? [] }),
  );
  return k.key;
}

/** Unique fake client IP per call site so the Postgres-backed rate limiter never interferes. */
export const ipHeader = () => ({ "x-forwarded-for": `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });

export function jsonRequest(url: string, body: unknown, headers: Record<string, string> = {}, method = "POST") {
  return new Request(url, { method, headers: { "content-type": "application/json", ...ipHeader(), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });
}

export const params = <T>(p: T) => ({ params: Promise.resolve(p) });

/** Drizzle wraps pg errors ("Failed query: …"); the pg error with its SQLSTATE is on `cause`. */
export async function pgError(p: Promise<unknown>): Promise<{ code?: string; message: string }> {
  try {
    await p;
  } catch (e) {
    const c = (e as { cause?: { code?: string; message?: string } }).cause;
    return { code: c?.code ?? (e as { code?: string }).code, message: c?.message ?? (e as Error).message };
  }
  throw new Error("Expected the operation to fail");
}
