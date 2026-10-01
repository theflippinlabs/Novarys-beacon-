import { asSystem } from "@/db";
import { buildSitemap } from "@/core/seo/sitemap";
import { ipHashOf } from "@/lib/http";
import { rateLimit } from "@/lib/security/rate-limit";
import { orgBySlug } from "@/services/public";
import { hostedSitemapEntries } from "@/services/sitemaps";

export const dynamic = "force-dynamic";

/**
 * XML sitemap of published discovery pages (canonical URLs on product domains
 * when known). Deprecated products are excluded. The generation date (most
 * recent lastmod) is exposed in Last-Modified and X-Beacon-Generated-At.
 */
export async function GET(req: Request, { params }: { params: Promise<{ org: string }> }) {
  const { org: slug } = await params;
  const rl = await rateLimit(`sitemap:${ipHashOf(req)}`, 120, 60);
  if (!rl.allowed) return new Response("Too many requests", { status: 429, headers: { "retry-after": String(Math.max(1, Math.ceil((rl.resetAt.getTime() - Date.now()) / 1000))) } });
  const out = await asSystem(async (tx) => {
    const org = await orgBySlug(tx, slug);
    if (!org) return null;
    return hostedSitemapEntries(tx, org.id, slug);
  });
  if (!out) return new Response("Not found", { status: 404 });
  const headers: Record<string, string> = { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=600" };
  if (out.generatedAt) {
    headers["last-modified"] = new Date(out.generatedAt).toUTCString();
    headers["x-beacon-generated-at"] = out.generatedAt;
  }
  return new Response(buildSitemap(out.entries), { headers });
}
