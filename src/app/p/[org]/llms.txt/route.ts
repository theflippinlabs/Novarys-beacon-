import { asSystem } from "@/db";
import { canonicalUrl } from "@/core/discovery/urls";
import { buildLlmsTxt } from "@/core/geo/entity";
import { env } from "@/lib/env";
import { ipHashOf, limited } from "@/lib/http";
import { orgBySlug, publicGraphs, publishedPages } from "@/services/public";

export const dynamic = "force-dynamic";

/** llms.txt index of verified product summaries and published pages. */
export async function GET(req: Request, { params }: { params: Promise<{ org: string }> }) {
  const rl = await limited(`llms:ip:${ipHashOf(req)}`, 60, 60);
  if (rl) return rl;
  const { org: slug } = await params;
  const body = await asSystem(async (tx) => {
    const org = await orgBySlug(tx, slug);
    if (!org) return null;
    const graphs = await publicGraphs(tx, org.id);
    const rows = await publishedPages(tx, org.id);
    const base = env().BEACON_BASE_URL;
    return buildLlmsTxt(
      { name: org.branding.displayName ?? org.name },
      graphs.map((g) => ({
        name: g.product.name,
        url: g.product.domain ? `https://${g.product.domain}` : null,
        summary: g.product.shortDescription,
        pages: [
          { title: `${g.product.name} entity profile (JSON)`, url: `${base}/api/v1/entity/${slug}/${g.product.slug}` },
          ...rows.filter((r) => r.product.id === g.product.id).map((r) => ({ title: r.version?.metaTitle ?? r.asset.title, url: canonicalUrl(r.product.domain, r.page.path) ?? `${base}/p/${slug}${r.page.path}` })),
        ],
      })),
    );
  });
  if (!body) return new Response("Not found", { status: 404 });
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=600" } });
}
