import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { eq, inArray } from "drizzle-orm";
import { asSystem } from "@/db";
import { queries, queryClusters } from "@/db/schema";
import { relatedPages } from "@/core/seo/link-suggest";
import { renderMarkdown } from "@/core/content/markdown";
import { canonicalUrl } from "@/core/discovery/urls";
import { serializeJsonLd } from "@/core/seo/schema-org";
import { env } from "@/lib/env";
import { buildMediaUrl, mediaIdFromUrl } from "@/core/media/image";
import { orgBySlug, publishedPages } from "@/services/public";
import { getT } from "@/i18n/server";
import { pageRateLimited } from "@/lib/http";

export const dynamic = "force-dynamic";

async function load(orgSlug: string, path: string[]) {
  const p = `/${path.map((s) => s.toLowerCase()).join("/")}`;
  return asSystem(async (tx) => {
    const org = await orgBySlug(tx, orgSlug);
    if (!org) return null;
    const rows = await publishedPages(tx, org.id);
    const row = rows.find((r) => r.page.path === p);
    if (!row) return null;
    // Topic cluster of each page of the product: its query cluster when known, else its page type.
    const same = rows.filter((r) => r.page.productId === row.page.productId);
    const ids = same.map((r) => r.page.id);
    const qc = ids.length
      ? await tx
          .select({ pageId: queries.pageId, cluster: queryClusters.slug })
          .from(queries)
          .innerJoin(queryClusters, eq(queryClusters.id, queries.clusterId))
          .where(inArray(queries.pageId, ids))
      : [];
    const clusterOf = new Map(qc.map((q) => [q.pageId!, q.cluster]));
    const items = same.map((r) => ({ id: r.page.id, productId: r.page.productId, path: r.page.path, title: r.version?.metaTitle ?? r.asset.title, cluster: clusterOf.get(r.page.id) ?? `type:${r.page.type}` }));
    const related = relatedPages(items.find((i) => i.id === row.page.id)!, items);
    return { org, row, related };
  });
}

export async function generateMetadata({ params }: { params: Promise<{ org: string; path: string[] }> }): Promise<Metadata> {
  const { org, path } = await params;
  const d = await load(org, path);
  if (!d) return {};
  const v = d.row.version!;
  const self = `${env().BEACON_BASE_URL}/p/${org}${d.row.page.path}`;
  const canonical = canonicalUrl(d.row.product.domain, d.row.page.path) ?? self;
  return {
    title: { absolute: v.metaTitle ?? d.row.asset.title },
    description: v.metaDescription ?? undefined,
    alternates: { canonical },
    // A Beacon-hosted copy defers to the product's own domain when one exists (no duplicate indexing).
    robots: { index: canonical === self, follow: true },
    openGraph: { title: v.metaTitle ?? d.row.asset.title, description: v.metaDescription ?? undefined, url: canonical, type: "website", siteName: d.row.product.name },
    twitter: { card: "summary", title: v.metaTitle ?? d.row.asset.title, description: v.metaDescription ?? undefined },
  };
}

/** Beacon-hosted rendering of approved, published discovery pages. */
export default async function PublicPage({ params }: { params: Promise<{ org: string; path: string[] }> }) {
  const { org, path } = await params;
  if (await pageRateLimited("hosted-page", 120, 60)) {
    const t = await getT();
    return <main className="mx-auto max-w-2xl px-4 py-16 text-sm text-chrome">{t("Too many requests. Try again in a minute.")}</main>;
  }
  const d = await load(org, path);
  if (!d) notFound();
  const v = d.row.version!;
  const t = await getT();
  const logoId = d.row.product.logoUrl ? mediaIdFromUrl(d.row.product.logoUrl, [env().BEACON_BASE_URL]) : null;
  const logo = logoId ? buildMediaUrl(logoId) : null;
  return (
    <div className="min-h-screen bg-obsidian">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
          <span className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.3em] text-platinum">
            {logo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={logo} alt="" width={24} height={24} className="h-6 w-6 object-contain" />
            )}
            {d.row.product.name}
          </span>
          <span className="eyebrow flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/beacon-emblem-64.png" alt="" width={20} height={20} />
            {d.org.branding.displayName ?? d.org.name}
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-12">
        <article className="prose-beacon" dangerouslySetInnerHTML={{ __html: renderMarkdown(v.body, { imageOrigins: [env().BEACON_BASE_URL] }) }} />
        {d.related.length > 0 && (
          <nav aria-label={t("Related")} className="mt-12 border-t border-line pt-4">
            <h2 className="eyebrow mb-3">{t("Related")}</h2>
            <ul className="flex flex-col gap-2 text-sm">
              {d.related.map((r) => (
                <li key={r.id}>
                  <Link className="text-blue-bright underline underline-offset-4 hover:text-cyan" href={`/p/${org}${r.path}`}>
                    {r.title}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <p className="mt-12 border-t border-line pt-4 text-xs text-muted">
          {t("Last updated {date}. Facts on this page are sourced from the product’s canonical documentation.", { date: (d.row.page.publishedAt ?? v.createdAt).toISOString().slice(0, 10) })}
        </p>
      </main>
      {v.structuredData.map((s, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: serializeJsonLd(s) }} />
      ))}
    </div>
  );
}
