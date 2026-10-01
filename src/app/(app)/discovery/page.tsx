import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { createPageContentAction, runAuditAction, syncPlanAction } from "@/app/actions/discovery";
import { Badge, Button, EmptyState, Field, Flash, HiddenBack, PageHeader, Panel, StatusBadge, Table, Td, Th } from "@/components/ui";
import { FilterBar, SelectFilter } from "@/components/shell/filters";
import { pages, products, seoAudits } from "@/db/schema";
import { canonicalUrl } from "@/core/discovery/urls";
import { QUALITY_THRESHOLDS } from "@/core/discovery/quality";
import { pageData, sp1, type SP } from "@/lib/page";

export const metadata = { title: "Discovery" };

export default async function DiscoveryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
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
      <PageHeader eyebrow="03 / Discovery" title="Discovery engine" description="Planned discovery pages per product, gated by information completeness, uniqueness, factual confidence, intent match, duplicate similarity and usefulness. Low-quality pages stay drafts." />
      <Flash searchParams={sp} />
      {!product ? (
        <EmptyState title="No products">Add a product first.</EmptyState>
      ) : (
        <>
          <FilterBar action="/discovery">
            <SelectFilter name="product" label="Product" value={product.slug} all="—" options={data.prods.map((p) => ({ value: p.slug, label: p.name }))} />
            <SelectFilter name="type" label="Page type" value={type} options={["PRODUCT", "FEATURE", "USE_CASE", "INDUSTRY", "AUDIENCE", "INTEGRATION", "COMPARISON", "ALTERNATIVE", "GUIDE", "ANSWER", "DOCS", "CHANGELOG"].map((t) => ({ value: t, label: t }))} />
            <SelectFilter name="status" label="Status" value={status} options={["PLANNED", "DRAFT", "IN_REVIEW", "APPROVED", "PUBLISHED", "ARCHIVED"].map((t) => ({ value: t, label: t }))} />
          </FilterBar>

          <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
            <Panel
              title={`${data.list.length} page(s) · ${product.name}`}
              eyebrow="Page inventory"
              pad={false}
              actions={
                can("query:write") && (
                  <form action={syncPlanAction}>
                    <HiddenBack path={back} />
                    <input type="hidden" name="productId" value={product.id} />
                    <Button>Re-plan pages</Button>
                  </form>
                )
              }
            >
              {data.list.length ? (
                <Table>
                  <thead>
                    <tr>
                      <Th>Page</Th>
                      <Th>Type</Th>
                      <Th>Status</Th>
                      <Th>Quality gate</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.list.map((pg) => {
                      const q = pg.quality as Record<string, number | string | boolean>;
                      return (
                        <tr key={pg.id}>
                          <Td>
                            <div className="text-platinum">{pg.title}</div>
                            <div className="num text-[11px] text-muted">{canonicalUrl(product.domain, pg.path) ?? pg.path}</div>
                          </Td>
                          <Td>
                            <Badge>{pg.type}</Badge>
                          </Td>
                          <Td>
                            <StatusBadge status={pg.status} />
                          </Td>
                          <Td className="min-w-56 text-[11px]">
                            <div className="flex flex-wrap gap-x-3 gap-y-0.5 num">
                              <span title="Information completeness">IC {String(q.informationCompleteness ?? "—")}</span>
                              <span title="Factual confidence">FC {String(q.factualConfidence ?? "—")}</span>
                              <span title="Uniqueness">UQ {String(q.uniqueness ?? "—")}</span>
                              <span title="Intent match">IM {String(q.intentMatch ?? "—")}</span>
                              <span title="Usefulness">US {String(q.usefulness ?? "—")}</span>
                            </div>
                            {q.publishable === true ? <span className="text-ok">✓ passes gate</span> : <span className="text-warn" title={String(q.blockers ?? "")}>◐ {String(q.blockers ?? "").split(" | ")[0]}</span>}
                          </Td>
                          <Td className="text-right">
                            {pg.contentAssetId ? (
                              <Link className="eyebrow text-blue-bright hover:text-cyan" href={`/content/${pg.contentAssetId}`}>
                                Content →
                              </Link>
                            ) : (
                              can("content:write") && (
                                <form action={createPageContentAction}>
                                  <HiddenBack path={back} />
                                  <input type="hidden" name="pageId" value={pg.id} />
                                  <Button name="generate" value="1">
                                    Draft
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
                  <EmptyState title="No pages planned">Run product analysis (or “Re-plan pages”). Pages are only planned when the knowledge graph holds enough facts.</EmptyState>
                </div>
              )}
            </Panel>

            <div className="flex flex-col gap-6">
              <Panel title="Technical SEO audit" eyebrow="Crawler">
                {can("job:run") ? (
                  <form action={runAuditAction} className="flex flex-col gap-3">
                    <HiddenBack path={back} />
                    <input type="hidden" name="productId" value={product.id} />
                    <Field label="Start URL" hint="Defaults to the product domain. Respects robots.txt; SSRF-protected.">
                      <input name="startUrl" placeholder={product.domain ? `https://${product.domain}` : "https://…"} />
                    </Field>
                    <Field label="Max pages">
                      <input name="maxPages" type="number" min={1} max={500} defaultValue={50} />
                    </Field>
                    <div>
                      <Button variant="gold">Run audit</Button>
                    </div>
                  </form>
                ) : (
                  <p className="text-sm text-muted">Analyst role required to run audits.</p>
                )}
                <ul className="mt-4 flex flex-col gap-2 border-t border-line pt-3">
                  {data.audits.map((a) => (
                    <li key={a.id}>
                      <Link href={`/discovery/audits/${a.id}`} className="flex items-center justify-between gap-2 text-xs hover:text-platinum">
                        <span className="num text-chrome">{a.createdAt.toISOString().slice(0, 16).replace("T", " ")}</span>
                        <span className="num text-muted">{a.pagesCrawled} pages</span>
                        <StatusBadge status={a.status} />
                      </Link>
                    </li>
                  ))}
                  {!data.audits.length && <li className="text-xs text-muted">No audits yet.</li>}
                </ul>
              </Panel>
              <Panel title="Publication gate" eyebrow="Thresholds">
                <ul className="flex flex-col gap-1 text-xs text-chrome">
                  <li>Information completeness ≥ {QUALITY_THRESHOLDS.informationCompleteness}</li>
                  <li>Factual confidence ≥ {QUALITY_THRESHOLDS.factualConfidence}</li>
                  <li>Duplicate similarity ≤ {QUALITY_THRESHOLDS.maxDuplicateSimilarity}</li>
                  <li>Usefulness ≥ {QUALITY_THRESHOLDS.usefulness}</li>
                </ul>
              </Panel>
              <Panel title="Sitemaps & machine-readable" eyebrow="Published output">
                <p className="text-xs text-chrome">{data.sitemapCount} published page(s) are included in the Beacon-hosted sitemap and llms.txt index.</p>
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
