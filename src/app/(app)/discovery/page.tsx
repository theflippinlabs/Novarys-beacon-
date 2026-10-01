import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, count, desc, eq, sql } from "drizzle-orm";
import { Pager } from "@/components/shell/pager";
import { decodeCursor, PAGE_SIZE, pageOf } from "@/core/util/cursor";
import { afterCursor } from "@/lib/paginate";
import { createPageContentAction, runAuditAction, syncPlanAction } from "@/app/actions/discovery";
import { Badge, Button, EmptyState, Field, Flash, HiddenBack, PageHeader, Panel, StatusBadge, Table, Td, Th } from "@/components/ui";
import { FilterBar, SelectFilter } from "@/components/shell/filters";
import { pages, products, seoAudits } from "@/db/schema";
import { canonicalUrl } from "@/core/discovery/urls";
import { QUALITY_THRESHOLDS } from "@/core/discovery/quality";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";
import { pageData, sp1, type SP } from "@/lib/page";
import { verifiedDomainNames } from "@/services/seo";
import { sitemapOverview } from "@/services/sitemaps";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Discovery") };
}

export default async function DiscoveryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { t, intl, locale } = await getI18n();
  const num = (n: number) => new Intl.NumberFormat(intl).format(n);
  /** Enum label: translated in French, raw value in English (unchanged output). */
  const lbl = (v: string) => (locale === "fr" ? enumLabel(t, v) : v);
  const slug = sp1(sp, "product");
  const type = sp1(sp, "type");
  const status = sp1(sp, "status");
  const cursor = decodeCursor(sp1(sp, "cursor"));
  const { data, can, ctx } = await pageData(async (tx, ctx) => {
    const prods = await tx.select().from(products).where(eq(products.organizationId, ctx.org.id)).orderBy(products.name);
    const product = slug ? prods.find((p) => p.slug === slug) ?? null : prods[0] ?? null;
    if (!product) return { prods, product: null, list: [], listTotal: 0, listNext: null, audits: [], sitemapCount: 0, sitemaps: null, domains: [] as string[] };
    const where = and(eq(pages.organizationId, ctx.org.id), eq(pages.productId, product.id), type ? eq(pages.type, type as never) : undefined, status ? eq(pages.status, status as never) : undefined);
    const [{ listTotal }] = await tx.select({ listTotal: count() }).from(pages).where(where);
    // Paginated by path (cursor, 50 per page): paths group pages by type under the product.
    const listPage = pageOf(
      await tx.select().from(pages).where(and(where, afterCursor(pages.path, pages.id, cursor, "asc"))).orderBy(asc(pages.path), asc(pages.id)).limit(PAGE_SIZE + 1),
      PAGE_SIZE,
      (r) => ({ v: r.path, id: r.id }),
    );
    const list = listPage.items;
    const audits = await tx.select().from(seoAudits).where(eq(seoAudits.productId, product.id)).orderBy(desc(seoAudits.createdAt)).limit(8);
    const sm = await tx.execute<{ n: number }>(sql`select count(*)::int as n from pages where product_id = ${product.id} and status = 'PUBLISHED'`);
    const sitemaps = await sitemapOverview(tx, ctx.org.id, ctx.org.slug, product.id);
    const domains = await verifiedDomainNames(tx, ctx.org.id);
    return { prods, product, list, listTotal, listNext: listPage.next, audits, sitemapCount: Number(sm.rows[0]?.n ?? 0), sitemaps, domains };
  });
  const { product } = data;
  const back = `/discovery?product=${product?.slug ?? ""}`;

  return (
    <>
      <PageHeader eyebrow={t("03 / Discovery")} title={t("Discovery engine")} description={t("Planned discovery pages per product, gated by information completeness, uniqueness, factual confidence, intent match, duplicate similarity and usefulness. Low-quality pages stay drafts.")} />
      <Flash searchParams={sp} />
      {!product ? (
        <EmptyState variant="not_generated" what={t("No products")} why={t("Discovery plans pages and audits sites per product.")} action={{ label: t("Add a product first."), href: "/products" }} />
      ) : (
        <>
          <FilterBar action="/discovery">
            <SelectFilter name="product" label={t("Product")} value={product.slug} all={t("Default")} options={data.prods.map((p) => ({ value: p.slug, label: p.name }))} />
            <SelectFilter name="type" label={t("Page type")} value={type} all={t("All")} options={["PRODUCT", "FEATURE", "USE_CASE", "INDUSTRY", "AUDIENCE", "INTEGRATION", "COMPARISON", "ALTERNATIVE", "GUIDE", "ANSWER", "DOCS", "CHANGELOG"].map((v) => ({ value: v, label: lbl(v) }))} />
            <SelectFilter name="status" label={t("Status")} value={status} all={t("All")} options={["PLANNED", "DRAFT", "IN_REVIEW", "APPROVED", "PUBLISHED", "ARCHIVED"].map((v) => ({ value: v, label: lbl(v) }))} />
          </FilterBar>

          <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
            <Panel
              title={t("{n} page(s) · {name}", { n: data.list.length, name: product.name })}
              eyebrow={t("Page inventory")}
              pad={false}
              actions={
                can("query:write") && (
                  <form action={syncPlanAction}>
                    <HiddenBack path={back} />
                    <input type="hidden" name="productId" value={product.id} />
                    <Button>{t("Re-plan pages")}</Button>
                  </form>
                )
              }
            >
              {data.list.length ? (
                <Table>
                  <thead>
                    <tr>
                      <Th>{t("Page")}</Th>
                      <Th>{t("Type")}</Th>
                      <Th>{t("Status")}</Th>
                      <Th>{t("Quality gate")}</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.list.map((pg) => {
                      const q = pg.quality as Record<string, number | string | boolean>;
                      const blockers = String(q.blockers ?? "").split(" | ");
                      return (
                        <tr key={pg.id}>
                          <Td>
                            <div className="text-platinum">{pg.title}</div>
                            <div className="num text-[11px] text-muted">{canonicalUrl(product.domain, pg.path) ?? pg.path}</div>
                          </Td>
                          <Td>
                            <Badge>{lbl(pg.type)}</Badge>
                          </Td>
                          <Td>
                            <StatusBadge status={pg.status} />
                          </Td>
                          <Td className="min-w-56 text-[11px]">
                            <div className="flex flex-wrap gap-x-3 gap-y-0.5 num">
                              <span title={t("Information completeness")}>{t("IC")} {String(q.informationCompleteness ?? t("n/a"))}</span>
                              <span title={t("Factual confidence")}>{t("FC")} {String(q.factualConfidence ?? t("n/a"))}</span>
                              <span title={t("Uniqueness")}>{t("UQ")} {String(q.uniqueness ?? t("n/a"))}</span>
                              <span title={t("Intent match")}>{t("IM")} {String(q.intentMatch ?? t("n/a"))}</span>
                              <span title={t("Usefulness")}>{t("US")} {String(q.usefulness ?? t("n/a"))}</span>
                            </div>
                            {q.publishable === true ? <span className="text-ok">{t("✓ passes gate")}</span> : <span className="text-warn" title={blockers.map((b) => t(b)).join(" | ")}>◐ {t(blockers[0])}</span>}
                          </Td>
                          <Td className="text-right">
                            {pg.contentAssetId ? (
                              <Link className="eyebrow text-blue-bright hover:text-cyan" href={`/content/${pg.contentAssetId}`}>
                                {t("Content →")}
                              </Link>
                            ) : (
                              can("content:write") && (
                                <form action={createPageContentAction}>
                                  <HiddenBack path={back} />
                                  <input type="hidden" name="pageId" value={pg.id} />
                                  <Button name="generate" value="1">
                                    {t("Draft")}
                                  </Button>
                                </form>
                              )
                            )}
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
              ) : (
                <div className="p-4">
                  {type || status ? (
                    <EmptyState variant="filtered" what={t("No pages match these filters.")} why={t("Other pages of this product have a different type or status.")} action={{ label: t("Clear filters"), href: `/discovery?product=${product.slug}` }} />
                  ) : (
                    <EmptyState
                      variant="not_generated"
                      what={t("No pages planned")}
                      why={t("Run product analysis (or “Re-plan pages”). Pages are only planned when the knowledge graph holds enough facts.")}
                      action={can("query:write") ? { label: t("Re-plan pages"), form: { action: syncPlanAction, fields: { productId: product.id }, back } } : { label: t("Open the knowledge graph"), href: `/products/${product.slug}/knowledge` }}
                    />
                  )}
                </div>
              )}
              <div className="px-4 pb-3">
                <Pager path="/discovery" params={{ product: product.slug, type, status }} shown={data.list.length} total={data.listTotal} next={data.listNext} current={sp1(sp, "cursor")} />
              </div>
            </Panel>

            <div className="flex flex-col gap-6">
              <Panel title={t("Technical SEO audit")} eyebrow={t("Crawler")}>
                {can("job:run") ? (
                  <form action={runAuditAction} className="flex flex-col gap-3">
                    <HiddenBack path={back} />
                    <input type="hidden" name="productId" value={product.id} />
                    <Field label={t("Start URL")} hint={t("Defaults to the product domain. Respects robots.txt; SSRF-protected.")}>
                      <input name="startUrl" placeholder={product.domain ? `https://${product.domain}` : "https://…"} />
                    </Field>
                    <Field label={t("Max pages")}>
                      <input name="maxPages" type="number" min={1} max={500} defaultValue={50} />
                    </Field>
                    <div>
                      <Button variant="gold">{t("Run audit")}</Button>
                    </div>
                    <p className="text-[11px] text-muted">
                      {data.domains.length ? t("Verified domains: {list}", { list: data.domains.join(", ") }) : t("No verified domain yet: audits of public sites need one.")}{" "}
                      <Link className="text-blue-bright underline underline-offset-4" href="/discovery/domains">
                        {t("Manage domains")}
                      </Link>
                    </p>
                  </form>
                ) : (
                  <p className="text-sm text-muted">{t("Analyst role required to run audits.")}</p>
                )}
                <ul className="mt-4 flex flex-col gap-2 border-t border-line pt-3">
                  {data.audits.map((a) => (
                    <li key={a.id}>
                      <Link href={`/discovery/audits/${a.id}`} className="flex items-center justify-between gap-2 text-xs hover:text-platinum">
                        <span className="num text-chrome">{a.createdAt.toISOString().slice(0, 16).replace("T", " ")}</span>
                        <span className="num text-muted">{t("{n} pages", { n: a.pagesCrawled })}</span>
                        <StatusBadge status={a.status} />
                      </Link>
                    </li>
                  ))}
                  {!data.audits.length && <li className="text-xs text-muted">{t("No audits yet.")}</li>}
                </ul>
                {data.audits.length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-3 text-xs">
                    <Link className="text-blue-bright underline underline-offset-4" href={`/discovery/history?product=${product.slug}`}>
                      {t("Crawl history")}
                    </Link>
                    <Link className="text-blue-bright underline underline-offset-4" href={`/discovery/links?product=${product.slug}`}>
                      {t("Internal links")}
                    </Link>
                  </div>
                )}
              </Panel>
              <Panel title={t("Publication gate")} eyebrow={t("Thresholds")}>
                <ul className="flex flex-col gap-1 text-xs text-chrome">
                  <li>{t("Information completeness ≥ {value}", { value: num(QUALITY_THRESHOLDS.informationCompleteness) })}</li>
                  <li>{t("Factual confidence ≥ {value}", { value: num(QUALITY_THRESHOLDS.factualConfidence) })}</li>
                  <li>{t("Duplicate similarity ≤ {value}", { value: num(QUALITY_THRESHOLDS.maxDuplicateSimilarity) })}</li>
                  <li>{t("Usefulness ≥ {value}", { value: num(QUALITY_THRESHOLDS.usefulness) })}</li>
                </ul>
              </Panel>
              <Panel title={t("Sitemaps & machine-readable")} eyebrow={t("Published output")}>
                <p className="text-xs text-chrome">{t("{n} published page(s) are included in the Beacon-hosted sitemap and llms.txt index.", { n: data.sitemapCount })}</p>
                {data.sitemaps && (
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-xs">
                    <div>
                      <dt className="eyebrow">{t("Last generated")}</dt>
                      <dd className="num text-chrome">{data.sitemaps.hosted.generatedAt ? data.sitemaps.hosted.generatedAt.slice(0, 10) : t("n/a")}</dd>
                    </div>
                    <div>
                      <dt className="eyebrow">{t("Last verified")}</dt>
                      <dd className="num text-chrome">
                        {data.sitemaps.lastVerifiedAt && data.sitemaps.latestAuditId ? (
                          <Link className="text-blue-bright" href={`/discovery/audits/${data.sitemaps.latestAuditId}?category=SITEMAP`}>
                            {data.sitemaps.lastVerifiedAt.slice(0, 10)}
                          </Link>
                        ) : (
                          t("Not crawled yet")
                        )}
                      </dd>
                    </div>
                  </dl>
                )}
                {data.sitemaps && data.sitemaps.snapshots.length > 0 && (
                  <ul className="mt-3 flex flex-col gap-1 border-t border-line pt-2 text-[11px]">
                    {data.sitemaps.snapshots.slice(0, 8).map((s) => (
                      <li key={s.id} className="flex items-baseline justify-between gap-2">
                        <span className="min-w-0 truncate text-chrome" title={s.sitemapUrl}>
                          {s.sitemapUrl}
                        </span>
                        <span className={`num shrink-0 ${s.errors.length ? "text-warn" : "text-muted"}`}>{s.errors.length ? t("error") : t("{n} URLs", { n: s.urlCount })}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {data.sitemaps && data.sitemaps.issueCounts.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-0.5 text-[11px]">
                    {data.sitemaps.issueCounts.map((c) => (
                      <li key={c.rule} className="flex justify-between gap-2">
                        <span className="num text-muted">{c.rule}</span>
                        <span className="num text-warn">{c.count}</span>
                      </li>
                    ))}
                  </ul>
                )}
                <ul className="mt-2 flex flex-col gap-1 text-xs">
                  <li>
                    <a className="text-blue-bright underline underline-offset-4" href={`/p/${ctx.org.slug}/sitemap.xml`}>
                      sitemap.xml
                    </a>
                  </li>
                  <li>
                    <a className="text-blue-bright underline underline-offset-4" href={`/p/${ctx.org.slug}/llms.txt`}>
                      llms.txt
                    </a>
                  </li>
                </ul>
              </Panel>
            </div>
          </div>
        </>
      )}
    </>
  );
}
