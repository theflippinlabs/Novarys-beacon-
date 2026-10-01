import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { asSystem } from "@/db";
import { renderMarkdown } from "@/core/content/markdown";
import { canonicalUrl } from "@/core/discovery/urls";
import { serializeJsonLd } from "@/core/seo/schema-org";
import { env } from "@/lib/env";
import { orgBySlug, publishedPages } from "@/services/public";
import { getT } from "@/i18n/server";

export const dynamic = "force-dynamic";

async function load(orgSlug: string, path: string[]) {
  const p = `/${path.map((s) => s.toLowerCase()).join("/")}`;
  return asSystem(async (tx) => {
    const org = await orgBySlug(tx, orgSlug);
    if (!org) return null;
    const rows = await publishedPages(tx, org.id);
    const row = rows.find((r) => r.page.path === p);
    return row ? { org, row } : null;
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
  const d = await load(org, path);
  if (!d) notFound();
  const v = d.row.version!;
  const t = await getT();
  return (
    <div className="min-h-screen bg-obsidian">
      <header className="border-b border-line">
        <div className="mx-auto flex max-w-3xl items-center justify-between px-4 py-4">
          <span className="flex items-center gap-2 font-mono text-xs uppercase tracking-[0.3em] text-platinum">{d.row.product.name}</span>
          <span className="eyebrow flex items-center gap-2">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/brand/beacon-emblem-64.png" alt="" width={20} height={20} />
            {d.org.branding.displayName ?? d.org.name}
          </span>
        </div>
      </header>
      <main className="mx-auto max-w-3xl px-4 py-12">
        <article className="prose-beacon" dangerouslySetInnerHTML={{ __html: renderMarkdown(v.body) }} />
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
