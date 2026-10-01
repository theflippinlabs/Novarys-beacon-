import { and, desc, eq, like, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { seoAudits, seoIssues, sitemapSnapshots } from "@/db/schema";
import { canonicalUrl } from "@/core/discovery/urls";
import type { SitemapEntry } from "@/core/seo/sitemap";
import { env } from "@/lib/env";
import { publishedPages } from "./public";

/**
 * Entries of the Beacon-hosted sitemap of an organisation: published pages of
 * products that are not deprecated. `generatedAt` is the most recent lastmod
 * (null when there are no entries).
 */
export async function hostedSitemapEntries(tx: Tx, organizationId: string, orgSlug: string, productId?: string): Promise<{ entries: SitemapEntry[]; generatedAt: string | null }> {
  const rows = (await publishedPages(tx, organizationId, productId)).filter((r) => r.product.status !== "DEPRECATED");
  const entries = rows.map((r) => ({
    loc: canonicalUrl(r.product.domain, r.page.path) ?? `${env().BEACON_BASE_URL}/p/${orgSlug}${r.page.path}`,
    lastmod: (r.page.publishedAt ?? r.page.updatedAt).toISOString().slice(0, 10),
  }));
  const generatedAt = rows.reduce<Date | null>((m, r) => {
    const d = r.page.publishedAt ?? r.page.updatedAt;
    return !m || d > m ? d : m;
  }, null);
  return { entries, generatedAt: generatedAt?.toISOString() ?? null };
}

/** Sitemap control center data for one product: hosted sitemap status and the crawled sitemaps of the latest audit. */
export async function sitemapOverview(tx: Tx, organizationId: string, orgSlug: string, productId: string) {
  const hosted = await hostedSitemapEntries(tx, organizationId, orgSlug, productId);
  const latest = await tx.query.seoAudits.findFirst({
    where: and(eq(seoAudits.organizationId, organizationId), eq(seoAudits.productId, productId), eq(seoAudits.status, "SUCCEEDED")),
    orderBy: desc(seoAudits.createdAt),
  });
  const snapshots = latest ? await tx.select().from(sitemapSnapshots).where(eq(sitemapSnapshots.auditId, latest.id)).orderBy(sitemapSnapshots.sitemapUrl).limit(100) : [];
  const issueCounts = latest
    ? (
        await tx
          .select({ rule: seoIssues.rule, n: sql<number>`count(*)::int` })
          .from(seoIssues)
          .where(and(eq(seoIssues.auditId, latest.id), like(seoIssues.rule, "sitemap.%")))
          .groupBy(seoIssues.rule)
      ).map((r) => ({ rule: r.rule, count: Number(r.n) }))
    : [];
  return {
    hosted: { url: `/p/${orgSlug}/sitemap.xml`, urlCount: hosted.entries.length, generatedAt: hosted.generatedAt },
    lastVerifiedAt: latest?.finishedAt?.toISOString() ?? null,
    latestAuditId: latest?.id ?? null,
    snapshots,
    issueCounts,
  };
}
