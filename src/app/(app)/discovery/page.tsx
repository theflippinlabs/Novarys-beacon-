import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { createPageContentAction, runAuditAction, syncPlanAction } from "@/app/actions/discovery";
import { Badge, Button, EmptyState, Field, Flash, HiddenBack, PageHeader, Panel, StatusBadge, Table, Td, Th } from "@/components/ui";
import { FilterBar, SelectFilter } from "@/components/shell/filters";
import { pages, products, seoAudits } from "@/db/schema";
import { canonicalUrl } from "@/core/discovery/urls";
import { QUALITY_THRESHOLDS } from "@/core/discovery/quality";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";
import { pageData, sp1, type SP } from "@/lib/page";

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
  const { data, can, ctx } = await pageData(async (tx, ctx) => {
    const prods = await tx.select().from(products).where(eq(products.organizationId, ctx.org.id)).orderBy(products.name);
    const product = slug ? prods.find((p) => p.slug === slug) ?? null : prods[0] ?? null;
    if (!product) return { prods, product: null, list: [], audits: [], sitemapCount: 0 };
    const list = await tx
      .select()
      .from(pages)
      .where(and(eq(pages.organizationId, ctx.org.id), eq(pages.productId, product.id), type ? eq(pages.type, type as never) : undefined, status ? eq(pages.status, status as never) : undefined))
      .orderBy(pages.type, pages.path);
    const audits = await tx.select().from(seoAudits).where(eq(seoAudits.productId, product.id)).orderBy(desc(seoAudits.createdAt)).limit(8);
    const sm = await tx.execute<{ n: number }>(sql`select count(*)::int as n from pages where product_id = ${product.id} and status = 'PUBLISHED'`);
    return { prods, product, list, audits, sitemapCount: Number(sm.rows[0]?.n ?? 0) };
  });
  const { product } = data;
  const back = `/discovery?product=${product?.slug ?? ""}`;

  return (
    <>
      <PageHeader eyebrow={t("03 / Discovery")} title={t("Discovery engine")} description={t("Planned discovery pages per product, gated by information completeness, uniqueness, factual confidence, intent match, duplicate similarity and usefulness. Low-quality pages stay drafts.")} />
      <Flash searchParams={sp} />
      {!product ? (
        <EmptyState title={t("No products")}>{t("Add a product first.")}</EmptyState>
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
                  <EmptyState title={t("No pages planned")}>{t("Run product analysis (or “Re-plan pages”). Pages are only planned when the knowledge graph holds enough facts.")}</EmptyState>
                </div>
              )}
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
