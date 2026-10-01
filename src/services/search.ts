import { and, desc, eq, ilike, or, type SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import type { Tx } from "@/db";
import { contentAssets, opportunities, products, queries, queryClusters, reports, seoAudits } from "@/db/schema";
import { likeEscape, normalizeText, rankItems } from "@/core/command/fuzzy";
import { productsWithVerifiedDomain } from "./seo";

export type SearchKind = "product" | "opportunity" | "content" | "query" | "cluster" | "audit" | "report";
export type SearchHit = { kind: SearchKind; id: string; label: string; detail: string | null; href: string };

/** Results per entity type and in total (the palette is not a report). */
export const SEARCH_PER_KIND = 5;
export const SEARCH_MAX = 25;
const CANDIDATES = 40;

/** Up to four query words, each matched as a literal substring (OR), then ranked fuzzily in memory. */
function tokens(q: string) {
  return [...new Set(normalizeText(q).split(" ").filter((w) => w.length >= 2))].slice(0, 4);
}

function anyToken(cols: AnyPgColumn[], toks: string[]): SQL | undefined {
  const parts = toks.flatMap((tk) => cols.map((c) => ilike(c, `%${likeEscape(tk)}%`)));
  return parts.length ? or(...parts) : undefined;
}

/**
 * Read-only workspace search for the command palette. Runs in the caller's
 * tenant transaction (RLS) and also filters by organisation explicitly.
 * Sequential queries: one transaction is one connection.
 */
export async function searchWorkspace(tx: Tx, organizationId: string, q: string): Promise<SearchHit[]> {
  const toks = tokens(q);
  if (!toks.length) return [];
  const org = (col: AnyPgColumn) => eq(col, organizationId);
  const hits: SearchHit[] = [];
  const take = (items: SearchHit[]) => hits.push(...rankItems(q, items, SEARCH_PER_KIND));

  const prods = await tx
    .select({ id: products.id, name: products.name, slug: products.slug, domain: products.domain })
    .from(products)
    .where(and(org(products.organizationId), anyToken([products.name, products.slug, products.domain], toks)))
    .limit(CANDIDATES);
  take(prods.map((p) => ({ kind: "product", id: p.id, label: p.name, detail: p.domain, href: `/products/${p.slug}`, keywords: [p.slug, p.domain ?? ""] })));

  const slugOf = new Map((await tx.select({ id: products.id, slug: products.slug }).from(products).where(org(products.organizationId))).map((p) => [p.id, p.slug]));

  const opps = await tx
    .select({ id: opportunities.id, title: opportunities.title, potential: opportunities.potential, status: opportunities.status })
    .from(opportunities)
    .where(and(org(opportunities.organizationId), anyToken([opportunities.title], toks)))
    .orderBy(desc(opportunities.impact))
    .limit(CANDIDATES);
  take(opps.map((o) => ({ kind: "opportunity", id: o.id, label: o.title, detail: `${o.potential} · ${o.status}`, href: `/opportunities/${o.id}` })));

  const assets = await tx
    .select({ id: contentAssets.id, title: contentAssets.title, status: contentAssets.status, type: contentAssets.type })
    .from(contentAssets)
    .where(and(org(contentAssets.organizationId), anyToken([contentAssets.title], toks)))
    .orderBy(desc(contentAssets.updatedAt))
    .limit(CANDIDATES);
  take(assets.map((a) => ({ kind: "content", id: a.id, label: a.title, detail: `${a.type} · ${a.status}`, href: `/content/${a.id}` })));

  const clusters = await tx
    .select({ id: queryClusters.id, name: queryClusters.name, productId: queryClusters.productId })
    .from(queryClusters)
    .where(and(org(queryClusters.organizationId), anyToken([queryClusters.name], toks)))
    .limit(CANDIDATES);
  take(
    clusters.map((c) => {
      const slug = c.productId ? slugOf.get(c.productId) : undefined;
      return { kind: "cluster", id: c.id, label: c.name, detail: slug ?? null, href: `/queries?${new URLSearchParams({ ...(slug ? { product: slug } : {}), q: c.name })}#gaps` };
    }),
  );

  const qs = await tx
    .select({ id: queries.id, query: queries.query, productId: queries.productId, status: queries.status })
    .from(queries)
    .where(and(org(queries.organizationId), anyToken([queries.query], toks)))
    .limit(CANDIDATES);
  take(
    qs.map((x) => {
      const slug = x.productId ? slugOf.get(x.productId) : undefined;
      return { kind: "query", id: x.id, label: x.query, detail: slug ?? null, href: `/queries?${new URLSearchParams({ ...(slug ? { product: slug } : {}), q: x.query, status: x.status })}` };
    }),
  );

  const audits = await tx
    .select({ id: seoAudits.id, startUrl: seoAudits.startUrl, status: seoAudits.status, createdAt: seoAudits.createdAt })
    .from(seoAudits)
    .where(and(org(seoAudits.organizationId), anyToken([seoAudits.startUrl], toks)))
    .orderBy(desc(seoAudits.createdAt))
    .limit(CANDIDATES);
  take(audits.map((a) => ({ kind: "audit", id: a.id, label: a.startUrl, detail: `${a.status} · ${a.createdAt.toISOString().slice(0, 10)}`, href: `/discovery/audits/${a.id}` })));

  // Reports have no free text: rank the latest ones by their period label.
  const reps = await tx.select({ id: reports.id, kind: reports.kind, periodStart: reports.periodStart, periodEnd: reports.periodEnd }).from(reports).where(org(reports.organizationId)).orderBy(desc(reports.createdAt)).limit(20);
  take(reps.map((r) => ({ kind: "report", id: r.id, label: `${r.kind} report ${r.periodStart} to ${r.periodEnd}`, detail: null, href: `/reports/${r.id}`, keywords: ["report", "weekly report"] })));

  return hits.slice(0, SEARCH_MAX).map(({ kind, id, label, detail, href }) => ({ kind, id, label, detail, href }));
}

/** What the palette needs to offer commands: products (with crawlable verified domain), the latest audit, reports availability. */
export async function paletteContext(tx: Tx, organizationId: string) {
  const prods = await tx.select({ id: products.id, name: products.name, slug: products.slug }).from(products).where(eq(products.organizationId, organizationId)).orderBy(products.name).limit(50);
  const crawlable = new Set(await productsWithVerifiedDomain(tx, organizationId));
  const [latestAudit] = await tx.select({ id: seoAudits.id }).from(seoAudits).where(and(eq(seoAudits.organizationId, organizationId), eq(seoAudits.status, "SUCCEEDED"))).orderBy(desc(seoAudits.createdAt)).limit(1);
  const clusters = await tx
    .select({ id: queryClusters.id, name: queryClusters.name, productId: queryClusters.productId })
    .from(queryClusters)
    .where(eq(queryClusters.organizationId, organizationId))
    .orderBy(desc(queryClusters.createdAt))
    .limit(30);
  return {
    products: prods.map((p) => ({ ...p, crawlable: crawlable.has(p.id) })),
    latestAuditId: latestAudit?.id ?? null,
    clusters: clusters.filter((c) => c.productId).map((c) => ({ id: c.id, name: c.name, productId: c.productId! })),
  };
}
