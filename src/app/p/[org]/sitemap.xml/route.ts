import { asSystem } from "@/db";
import { canonicalUrl } from "@/core/discovery/urls";
import { buildSitemap } from "@/core/seo/sitemap";
import { env } from "@/lib/env";
import { orgBySlug, publishedPages } from "@/services/public";

export const dynamic = "force-dynamic";

/** XML sitemap of published discovery pages (canonical URLs on product domains when known). */
export async function GET(_req: Request, { params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const body = await asSystem(async (tx) => {
    const org = await orgBySlug(tx, slug);
    if (!org) return null;
    const rows = await publishedPages(tx, org.id);
    return buildSitemap(rows.map((r) => ({ loc: canonicalUrl(r.product.domain, r.page.path) ?? `${env().BEACON_BASE_URL}/p/${slug}${r.page.path}`, lastmod: (r.page.publishedAt ?? r.page.updatedAt).toISOString().slice(0, 10) })));
  });
  if (!body) return new Response("Not found", { status: 404 });
  return new Response(body, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=600" } });
}
