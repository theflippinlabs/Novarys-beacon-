import { and, eq } from "drizzle-orm";
import { asSystem } from "@/db";
import { products } from "@/db/schema";
import { canonicalUrl } from "@/core/discovery/urls";
import { renderMarkdown } from "@/core/content/markdown";
import { env } from "@/lib/env";
import { err, ipHashOf, limited } from "@/lib/http";
import { orgBySlug, publishedPages } from "@/services/public";

export const dynamic = "force-dynamic";

/** Export of approved, published pages so a product website can render them on its own domain. */
export async function GET(req: Request, { params }: { params: Promise<{ org: string; product: string }> }) {
  const rl = await limited(`published:ip:${ipHashOf(req)}`, 60, 60);
  if (rl) return rl;
  const { org: orgSlug, product: slug } = await params;
  return asSystem(async (tx) => {
    const org = await orgBySlug(tx, orgSlug);
    if (!org) return err(404, "Not found");
    const p = await tx.query.products.findFirst({ where: and(eq(products.organizationId, org.id), eq(products.slug, slug)) });
    if (!p) return err(404, "Not found");
    const rows = await publishedPages(tx, org.id, p.id);
    const body = {
      product: p.slug,
      pages: rows.map((r) => ({
        path: r.page.path,
        canonical: canonicalUrl(p.domain, r.page.path),
        type: r.page.type,
        title: r.version!.metaTitle ?? r.asset.title,
        description: r.version!.metaDescription,
        markdown: r.version!.body,
        html: renderMarkdown(r.version!.body, { imageOrigins: [env().BEACON_BASE_URL] }),
        jsonLd: r.version!.structuredData,
        publishedAt: r.page.publishedAt,
        version: r.version!.version,
      })),
    };
    return new Response(JSON.stringify(body), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });
  });
}
