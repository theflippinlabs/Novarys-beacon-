import { and, asc, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { knowledgeProposals, productClaims, productFacets, productPricing, products, productSources } from "@/db/schema";
import { withDeadline } from "@/core/seo/crawl";
import { hostCoveredBy } from "@/core/seo/domains";
import { BEACON_ROBOTS_TOKEN, isAllowed, parseRobots, robotsPath, robotsPolicy, type RobotsRules } from "@/core/seo/robots";
import { extractProposals, findKeyPages, MAX_KEY_PAGES, sourceKindFor, type ExtractedProposal, type FetchedPage, type KeyPageRole } from "@/core/onboarding/extract";
import { slugify } from "@/core/util/text";
import { safeFetch } from "@/lib/security/ssrf";
import { audit, type Actor } from "@/lib/audit";
import { domainVerificationBypassed, verifiedDomainNames, VERIFY_DOMAINS_PATH } from "./seo";
import { setFactSource } from "./provenance";
import { updateProduct } from "./products";

/**
 * Onboarding website extraction: crawl the homepage and up to
 * MAX_KEY_PAGES key pages (pricing, docs, features, about) of a verified
 * domain with the SSRF-safe fetcher, outside any database transaction, then
 * store the facts read there as proposals. A human accepts a proposal into
 * the knowledge graph, where it stays UNVERIFIED (with the crawled URL as its
 * source) until someone with `fact:verify` verifies it.
 */
export type PageFetcher = (url: string) => Promise<{ status: number; body: string; headers: Record<string, string>; url: string }>;

const defaultFetcher: PageFetcher = (url) => safeFetch(url, { maxBytes: 2 * 1024 * 1024, timeoutMs: 15_000, maxRedirects: 3, userAgent: "NovarysBeacon/1.0 (+onboarding-extraction)" });

export class ExtractionRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtractionRefusedError";
  }
}

/** The product's domain must be covered by a verified domain (same rule as technical audits). Runs in a transaction. */
export async function assertExtractionAllowed(tx: Tx, organizationId: string, productId: string): Promise<{ startUrl: string }> {
  const p = await tx.query.products.findFirst({ where: and(eq(products.id, productId), eq(products.organizationId, organizationId)) });
  if (!p) throw new Error("Product not found");
  if (!p.domain) throw new ExtractionRefusedError("Enter the product domain first.");
  const host = p.domain.replace(/^https?:\/\//, "").split("/")[0];
  const bypass = domainVerificationBypassed(host.split(":")[0]);
  if (!bypass && !hostCoveredBy(host, await verifiedDomainNames(tx, organizationId)))
    throw new ExtractionRefusedError(`${host} is not a verified domain for this workspace. Verify it first (${VERIFY_DOMAINS_PATH}).`);
  return { startUrl: `${bypass ? "http" : "https"}://${host}/` };
}

export type CrawlForExtraction = { pages: FetchedPage[]; roles: Partial<Record<KeyPageRole, string>>; errors: string[] };

/**
 * Network part (no transaction open): robots.txt for Beacon's token, the
 * homepage, then the key pages it links to. Only HTML 2xx pages are kept.
 */
export async function crawlForExtraction(startUrl: string, opts: { fetcher?: PageFetcher; delayMs?: number; deadlineMs?: number } = {}): Promise<CrawlForExtraction> {
  const fetcher = opts.fetcher ?? defaultFetcher;
  const deadline = opts.deadlineMs ?? 20_000;
  const delay = opts.delayMs ?? 200;
  const errors: string[] = [];
  const origin = new URL(startUrl).origin;
  let robots: RobotsRules | null = null;
  let robotsStatus: number | null = null;
  try {
    const r = await withDeadline(fetcher(`${origin}/robots.txt`), deadline, "robots.txt");
    robotsStatus = r.status;
    if (robotsPolicy(r.status) === "PARSE") robots = parseRobots(r.body);
  } catch (e) {
    errors.push(`robots.txt: ${(e as Error).message}`.slice(0, 300));
  }
  if (robotsPolicy(robotsStatus) === "DISALLOW_ALL") throw new ExtractionRefusedError("robots.txt is unavailable, so the site is treated as disallowed. Try again when it answers normally.");
  const allowed = (u: string) => !robots || isAllowed(robots, robotsPath(u), BEACON_ROBOTS_TOKEN);

  const fetchHtml = async (url: string): Promise<FetchedPage | null> => {
    if (!allowed(url)) {
      errors.push(`${url}: disallowed by robots.txt`);
      return null;
    }
    try {
      const res = await withDeadline(fetcher(url), deadline, url);
      const type = res.headers["content-type"] ?? "";
      if (res.status < 200 || res.status >= 300) {
        errors.push(`${url}: HTTP ${res.status}`);
        return null;
      }
      if (type && !/html/i.test(type)) {
        errors.push(`${url}: not an HTML page`);
        return null;
      }
      return { url: res.url || url, html: res.body };
    } catch (e) {
      errors.push(`${url}: ${(e as Error).message}`.slice(0, 300));
      return null;
    }
  };

  const home = await fetchHtml(startUrl);
  if (!home) throw new ExtractionRefusedError(`The homepage could not be read (${errors.at(-1) ?? "unknown error"}).`);
  const pages: FetchedPage[] = [home];
  const roles: Partial<Record<KeyPageRole, string>> = {};
  for (const k of findKeyPages(home.url, home.html).slice(0, MAX_KEY_PAGES)) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const page = await fetchHtml(k.url);
    if (!page) continue;
    roles[k.role] = page.url;
    pages.push(page);
  }
  return { pages, roles, errors };
}

/** Store proposals (idempotent: a value already proposed, accepted or rejected is not proposed again). */
export async function storeProposals(tx: Tx, actor: Actor, productId: string, proposals: ExtractedProposal[], meta: { pages: number; errors: string[] }) {
  const p = await tx.query.products.findFirst({ where: and(eq(products.id, productId), eq(products.organizationId, actor.organizationId)) });
  if (!p) throw new Error("Product not found");
  const rows = proposals.map((x) => ({ organizationId: actor.organizationId, productId, kind: x.kind, field: x.field, value: x.value, details: x.details, origin: x.origin, sourceUrl: x.sourceUrl }));
  const inserted = rows.length ? await tx.insert(knowledgeProposals).values(rows).onConflictDoNothing().returning({ id: knowledgeProposals.id }) : [];
  await audit(tx, actor, "knowledge.extract", "product", productId, { pages: meta.pages, proposed: proposals.length, new: inserted.length, errors: meta.errors.slice(0, 5) });
  return { proposed: proposals.length, inserted: inserted.length };
}

/** Crawl (no transaction) then store. `run` opens a tenant-scoped transaction. */
export async function extractFromWebsite(run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>, actor: Actor, productId: string, opts: { fetcher?: PageFetcher; delayMs?: number } = {}) {
  const { startUrl } = await run((tx) => assertExtractionAllowed(tx, actor.organizationId, productId));
  const crawl = await crawlForExtraction(startUrl, opts);
  const proposals = extractProposals(crawl.pages, crawl.roles);
  const stored = await run((tx) => storeProposals(tx, actor, productId, proposals.map((x) => ({ ...x, details: { ...x.details, sourceKind: sourceKindFor(x.sourceUrl, crawl.roles) } })), { pages: crawl.pages.length, errors: crawl.errors }));
  return { pages: crawl.pages.length, errors: crawl.errors, ...stored };
}

export async function listProposals(tx: Tx, organizationId: string, productId: string, status?: "PROPOSED" | "ACCEPTED" | "REJECTED") {
  return tx
    .select()
    .from(knowledgeProposals)
    .where(and(eq(knowledgeProposals.organizationId, organizationId), eq(knowledgeProposals.productId, productId), status ? eq(knowledgeProposals.status, status) : undefined))
    .orderBy(asc(knowledgeProposals.kind), asc(knowledgeProposals.field), asc(knowledgeProposals.createdAt));
}

const CLAIM_PROPERTY = { short_description: "shortDescription", category: "category", documentation_url: "documentationUrl", pricing_url: "pricingUrl" } as const;
type ProposalRow = typeof knowledgeProposals.$inferSelect;

/** Make sure the crawled URL is a source of the product; returns its id. */
async function ensureSource(tx: Tx, actor: Actor, productId: string, row: ProposalRow): Promise<string> {
  const existing = await tx.query.productSources.findFirst({ where: and(eq(productSources.productId, productId), eq(productSources.url, row.sourceUrl)) });
  if (existing) return existing.id;
  const kind = (row.details.sourceKind as "WEBSITE" | "PRICING" | "DOCUMENTATION" | undefined) ?? sourceKindFor(row.sourceUrl);
  let title = row.sourceUrl;
  try {
    const u = new URL(row.sourceUrl);
    title = `${u.hostname}${u.pathname === "/" ? "" : u.pathname}`.slice(0, 120);
  } catch {
    /* keep the URL */
  }
  const [s] = await tx.insert(productSources).values({ organizationId: actor.organizationId, productId, url: row.sourceUrl, title, kind }).onConflictDoNothing().returning();
  return s?.id ?? (await tx.query.productSources.findFirst({ where: and(eq(productSources.productId, productId), eq(productSources.url, row.sourceUrl)) }))!.id;
}

/**
 * Accept a proposal into the knowledge graph. The fact keeps the crawled URL
 * as its source and stays UNVERIFIED (an existing verified value that changes
 * goes back to review through the normal edit rules).
 */
export async function acceptProposal(tx: Tx, actor: Actor, id: string) {
  const row = await tx.query.knowledgeProposals.findFirst({ where: and(eq(knowledgeProposals.id, id), eq(knowledgeProposals.organizationId, actor.organizationId)) });
  if (!row) throw new Error("Proposal not found");
  if (row.status !== "PROPOSED") throw new Error("This proposal was already decided.");
  const productId = row.productId;
  const product = (await tx.query.products.findFirst({ where: and(eq(products.id, productId), eq(products.organizationId, actor.organizationId)) }))!;
  const sourceId = await ensureSource(tx, actor, productId, row);
  switch (row.kind) {
    case "CLAIM": {
      const prop = CLAIM_PROPERTY[row.field as keyof typeof CLAIM_PROPERTY];
      if (!prop) throw new Error("Unsupported field");
      await updateProduct(tx, actor, productId, { [prop]: row.value });
      const claim = await tx.query.productClaims.findFirst({ where: and(eq(productClaims.productId, productId), eq(productClaims.field, row.field), eq(productClaims.value, row.value)) });
      if (claim && !claim.sourceId) await setFactSource(tx, actor, { kind: "claim", id: claim.id, sourceId });
      break;
    }
    case "FACET": {
      const slug = slugify(row.value);
      const existing = await tx.query.productFacets.findFirst({ where: and(eq(productFacets.productId, productId), eq(productFacets.kind, "FEATURE"), eq(productFacets.slug, slug)) });
      if (existing) {
        if (!existing.sourceId) await setFactSource(tx, actor, { kind: "facet", id: existing.id, sourceId });
      } else {
        const count = (await tx.select({ id: productFacets.id }).from(productFacets).where(and(eq(productFacets.productId, productId), eq(productFacets.kind, "FEATURE")))).length;
        const description = typeof row.details.description === "string" ? row.details.description : null;
        await tx.insert(productFacets).values({ organizationId: actor.organizationId, productId, kind: "FEATURE", slug, name: row.value, description, sourceId, sortOrder: count });
      }
      break;
    }
    case "PRICING": {
      const plans = await tx.select().from(productPricing).where(eq(productPricing.productId, productId));
      const same = plans.find((p) => p.planName.toLowerCase() === row.value.toLowerCase());
      if (same) {
        if (!same.sourceId) await setFactSource(tx, actor, { kind: "pricing", id: same.id, sourceId });
      } else {
        const priceCents = typeof row.details.priceCents === "number" ? row.details.priceCents : null;
        const currency = typeof row.details.currency === "string" ? row.details.currency : null;
        await tx.insert(productPricing).values({ organizationId: actor.organizationId, productId, planName: row.value.slice(0, 100), priceCents, currency, interval: null, sourceId, sortOrder: plans.length });
      }
      break;
    }
    case "SOCIAL": {
      if (!product.socialAccounts.some((s) => s.url === row.value)) await updateProduct(tx, actor, productId, { socialAccounts: [...product.socialAccounts, { network: row.field, url: row.value }] });
      break;
    }
    case "LOGO": {
      await updateProduct(tx, actor, productId, { logoUrl: row.value });
      break;
    }
  }
  await tx.update(knowledgeProposals).set({ status: "ACCEPTED", decidedAt: new Date(), decidedBy: actor.userId ?? null }).where(eq(knowledgeProposals.id, row.id));
  await audit(tx, actor, "knowledge.proposal.accept", "knowledge_proposal", row.id, { kind: row.kind, field: row.field, sourceUrl: row.sourceUrl });
  return row;
}

export async function rejectProposals(tx: Tx, actor: Actor, ids: string[]) {
  if (!ids.length) return 0;
  const rows = await tx
    .update(knowledgeProposals)
    .set({ status: "REJECTED", decidedAt: new Date(), decidedBy: actor.userId ?? null })
    .where(and(eq(knowledgeProposals.organizationId, actor.organizationId), inArray(knowledgeProposals.id, ids), eq(knowledgeProposals.status, "PROPOSED")))
    .returning({ id: knowledgeProposals.id });
  await audit(tx, actor, "knowledge.proposal.reject", "knowledge_proposal", null, { count: rows.length });
  return rows.length;
}
