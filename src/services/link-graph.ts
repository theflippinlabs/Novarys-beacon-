import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { crawledPages, crawlLinks, seoAudits } from "@/db/schema";
import { pathCluster, suggestLinks, type LinkPage, type LinkSuggestion } from "@/core/seo/link-suggest";

export type GraphRow = {
  url: string;
  title: string | null;
  status: number | null;
  cluster: string;
  clusterSource: "QUERY_CLUSTER" | "PAGE_PLAN" | "URL_PATH";
  plannedPage: string | null;
  depth: number | null;
  inlinks: number;
  outlinks: number;
  orphan: boolean;
  indexable: boolean;
};

/**
 * Internal link graph of an audit: per-page inlinks/outlinks (from
 * crawl_links), click depth, orphan flag and topic cluster (query cluster of
 * the matching Beacon page, else its page type, else the first URL path
 * segment), plus linking suggestions.
 */
export async function linkGraph(tx: Tx, organizationId: string, auditId: string): Promise<{ rows: GraphRow[]; suggestions: LinkSuggestion[]; edges: number } | null> {
  const a = await tx.query.seoAudits.findFirst({ where: and(eq(seoAudits.id, auditId), eq(seoAudits.organizationId, organizationId)) });
  if (!a) return null;
  const pages = await tx
    .select({ url: crawledPages.url, title: crawledPages.title, status: crawledPages.status, h1: crawledPages.h1, indexable: crawledPages.indexable, indexability: crawledPages.indexability, depth: crawledPages.depth, text: crawledPages.textSample, openGraph: crawledPages.openGraph })
    .from(crawledPages)
    .where(eq(crawledPages.auditId, auditId))
    .limit(1000);
  const edgeRows = await tx.select({ from: crawlLinks.fromUrl, to: crawlLinks.toUrl }).from(crawlLinks).where(and(eq(crawlLinks.auditId, auditId), eq(crawlLinks.isInternal, true)));
  const plan = await tx.execute<{ path: string; type: string; cluster: string | null; query: string | null }>(sql`
    select p.path, p.type::text as type, c.name as cluster, q.query
    from pages p
    left join queries q on (q.page_id = p.id or q.id = p.target_query_id) and q.status <> 'ARCHIVED'
    left join query_clusters c on c.id = q.cluster_id
    where p.organization_id = ${organizationId} and p.product_id = ${a.productId}`);
  const byPath = new Map<string, { type: string; cluster: string | null; queries: string[] }>();
  for (const r of plan.rows) {
    const cur = byPath.get(r.path) ?? { type: r.type, cluster: null, queries: [] };
    cur.cluster ??= r.cluster;
    if (r.query && !cur.queries.includes(r.query)) cur.queries.push(r.query);
    byPath.set(r.path, cur);
  }
  // Queries Search Console attributes to each URL (top 3), when that data exists.
  const searchQueries = new Map<string, string[]>();
  {
    const sq = await tx.execute<{ page: string; query: string }>(sql`
      select page, query from (
        select page, query, row_number() over (partition by page order by sum(impressions) desc) as rn
        from search_daily where organization_id = ${organizationId} and product_id = ${a.productId} and page is not null and query is not null and day >= current_date - 90
        group by page, query) x where rn <= 3`);
    for (const r of sq.rows) searchQueries.set(r.page, [...(searchQueries.get(r.page) ?? []), r.query]);
  }

  const out = new Map<string, Set<string>>();
  const inn = new Map<string, Set<string>>();
  const existing = new Set<string>();
  for (const e of edgeRows) {
    if (e.from === e.to) continue;
    existing.add(`${e.from}\u0000${e.to}`);
    (out.get(e.from) ?? out.set(e.from, new Set()).get(e.from)!).add(e.to);
    (inn.get(e.to) ?? inn.set(e.to, new Set()).get(e.to)!).add(e.from);
  }
  const start = a.startUrl.replace(/\/$/, "");
  const rows: GraphRow[] = pages.map((p) => {
    const path = new URL(p.url).pathname;
    const planned = byPath.get(path);
    const cluster = planned?.cluster ? { cluster: planned.cluster, src: "QUERY_CLUSTER" as const } : planned ? { cluster: planned.type, src: "PAGE_PLAN" as const } : { cluster: pathCluster(p.url), src: "URL_PATH" as const };
    const ok = (p.status ?? 0) >= 200 && (p.status ?? 0) < 300 && p.indexability !== "REDIRECT";
    const inlinks = inn.get(p.url)?.size ?? 0;
    return {
      url: p.url,
      title: p.title,
      status: p.status,
      cluster: cluster.cluster,
      clusterSource: cluster.src,
      plannedPage: planned ? path : null,
      depth: p.depth,
      inlinks,
      outlinks: out.get(p.url)?.size ?? 0,
      orphan: ok && inlinks === 0 && p.url.replace(/\/$/, "") !== start,
      indexable: Boolean(p.indexable),
    };
  });
  const rowByUrl = new Map(rows.map((r) => [r.url, r]));
  const home = pages.find((p) => p.url.replace(/\/$/, "") === start);
  const linkPages: LinkPage[] = pages
    .filter((p) => rowByUrl.get(p.url)?.indexable)
    .map((p) => {
      const r = rowByUrl.get(p.url)!;
      return { url: p.url, title: p.title, h1: p.h1[0] ?? null, text: p.text ?? "", cluster: r.cluster, inlinks: r.inlinks, indexable: true, queries: [...(byPath.get(new URL(p.url).pathname)?.queries ?? []), ...(searchQueries.get(p.url) ?? [])] };
    });
  const suggestions = suggestLinks({ pages: linkPages, existing, siteName: home?.openGraph["og:site_name"] ?? home?.title ?? null });
  return { rows, suggestions, edges: edgeRows.length };
}
