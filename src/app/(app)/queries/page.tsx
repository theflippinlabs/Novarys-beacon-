import type { Metadata } from "next";
import { and, asc, count, desc, eq, ilike, sql } from "drizzle-orm";
import { Pager } from "@/components/shell/pager";
import { decodeCursor, PAGE_SIZE, pageOf } from "@/core/util/cursor";
import { addQueryAction, bulkQueryAction, generateQueriesAction } from "@/app/actions/discovery";
import { refreshQueryIntelAction } from "@/app/actions/intel";
import { contentGapsForProduct } from "@/services/content-gaps";
import { TOPIC_TYPES } from "@/core/queries/classify";
import { ContentGaps } from "./content-gaps";
import { Badge, Button, EmptyState, Field, Flash, HiddenBack, PageHeader, Panel, ResponsiveTable, StatusBadge, Tabs, Td, Th } from "@/components/ui";
import { FilterBar, SelectFilter } from "@/components/shell/filters";
import { products, queries, queryClusters } from "@/db/schema";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";
import { pageData, sp1, type SP } from "@/lib/page";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Queries") };
}

const INTENTS = ["INFORMATIONAL", "COMMERCIAL", "TRANSACTIONAL", "NAVIGATIONAL", "COMPARISON", "PROBLEM", "ALTERNATIVE"];

export default async function QueriesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { t, locale } = await getI18n();
  /** Enum label: translated in French, raw value in English (unchanged output). */
  const lbl = (v: string) => (locale === "fr" ? enumLabel(t, v) : v);
  const f = { product: sp1(sp, "product"), intent: sp1(sp, "intent"), status: sp1(sp, "status") ?? "ACTIVE", coverage: sp1(sp, "coverage"), branded: sp1(sp, "branded"), topic: sp1(sp, "topic"), q: sp1(sp, "q") };
  const cursor = decodeCursor(sp1(sp, "cursor"));
  const { data, can } = await pageData(async (tx, ctx) => {
    const prods = await tx.select().from(products).where(eq(products.organizationId, ctx.org.id)).orderBy(products.name);
    const product = f.product ? prods.find((p) => p.slug === f.product) : undefined;
    const filters = and(
          eq(queries.organizationId, ctx.org.id),
          product ? eq(queries.productId, product.id) : undefined,
          f.intent ? eq(queries.intent, f.intent as never) : undefined,
          f.status && f.status !== "ALL" ? eq(queries.status, f.status as never) : undefined,
          f.coverage ? eq(queries.coverage, f.coverage as never) : undefined,
          f.branded === "BRANDED" ? eq(queries.branded, true) : f.branded === "NON_BRANDED" ? eq(queries.branded, false) : undefined,
          f.topic ? eq(queries.topicType, f.topic as never) : undefined,
          f.q ? ilike(queries.normalized, `%${f.q.toLowerCase().replace(/[%_]/g, "")}%`) : undefined,
        );
    // Every match is reachable: cursor pagination (50 per page) instead of a silent 500 cap.
    const [{ total }] = await tx.select({ total: count() }).from(queries).where(filters);
    const sep = cursor ? String(cursor.v).indexOf(":") : -1;
    const after =
      cursor && sep > 0
        ? sql`(${queries.importance} < ${Number(String(cursor.v).slice(0, sep))} or (${queries.importance} = ${Number(String(cursor.v).slice(0, sep))} and (${queries.normalized}, ${queries.id}) > (${String(cursor.v).slice(sep + 1)}, ${cursor.id}::uuid)))`
        : undefined;
    const page = pageOf(
      await tx
        .select({ q: queries, cluster: queryClusters.name, productName: products.name })
        .from(queries)
        .leftJoin(queryClusters, eq(queryClusters.id, queries.clusterId))
        .leftJoin(products, eq(products.id, queries.productId))
        .where(and(filters, after))
        .orderBy(desc(queries.importance), asc(queries.normalized), asc(queries.id))
        .limit(PAGE_SIZE + 1),
      PAGE_SIZE,
      (r) => ({ v: `${r.q.importance}:${r.q.normalized}`, id: r.q.id }),
    );
    const rows = page.items;
    const stats = await tx.execute<{ status: string; n: number }>(sql`select status, count(*)::int as n from queries where organization_id = ${ctx.org.id} group by status`);
    const clusters = await tx.execute<{ id: string; name: string; n: number; covered: number; coverage: string; intent: string | null; recommended_asset: string | null; branded: boolean }>(sql`
      select c.id, c.name, c.coverage, c.intent, c.recommended_asset, c.branded, count(q.id)::int as n, count(q.id) filter (where q.coverage = 'COVERED')::int as covered
      from query_clusters c join queries q on q.cluster_id = c.id
      where c.organization_id = ${ctx.org.id} and q.status <> 'ARCHIVED' ${product ? sql`and c.product_id = ${product.id}` : sql``}
      group by c.id order by n desc, c.name limit 30`);
    // Content gaps per product (the selected one, otherwise every product, at most 10).
    const gapProducts = product ? [product] : prods.slice(0, 10);
    const gaps: { product: (typeof prods)[number]; gaps: Awaited<ReturnType<typeof contentGapsForProduct>> }[] = [];
    for (const gp of gapProducts) gaps.push({ product: gp, gaps: await contentGapsForProduct(tx, ctx.org.id, gp.id) });
    return { prods, product, rows, total, next: page.next, stats: Object.fromEntries(stats.rows.map((r) => [r.status, Number(r.n)])), clusters: clusters.rows, gaps };
  });
  const back = `/queries?${new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString()}`;
  return (
    <>
      <PageHeader eyebrow={t("04 / Queries")} title={t("Query intelligence")} description={t("The discovery query universe: intent, funnel stage, importance and coverage per market and language. Generated queries arrive as candidates; long-tail variations are tracked, never mass-produced into pages.")} />
      <Tabs
        active="universe"
        items={[
          { key: "universe", label: t("Query universe"), href: "/queries" },
          { key: "search", label: t("Search performance"), href: "/queries/search" },
        ]}
      />
      <Flash searchParams={sp} />
      <div className="mb-6 grid grid-cols-3 gap-3 md:max-w-xl">
        {["ACTIVE", "CANDIDATE", "ARCHIVED"].map((s) => (
          <a key={s} href={`/queries?status=${s}${f.product ? `&product=${f.product}` : ""}`} className={`border p-3 ${f.status === s ? "border-gold" : "border-line"} bg-panel`}>
            <div className="eyebrow">{lbl(s)}</div>
            <div className="num mt-1 text-xl text-platinum">{data.stats[s] ?? 0}</div>
          </a>
        ))}
      </div>
      <FilterBar action="/queries">
        <SelectFilter name="product" label={t("Product")} value={f.product} all={t("All")} options={data.prods.map((p) => ({ value: p.slug, label: p.name }))} />
        <SelectFilter name="intent" label={t("Intent")} value={f.intent} all={t("All")} options={INTENTS.map((i) => ({ value: i, label: lbl(i) }))} />
        <SelectFilter name="coverage" label={t("Coverage")} value={f.coverage} all={t("All")} options={["NONE", "PARTIAL", "COVERED"].map((i) => ({ value: i, label: lbl(i) }))} />
        <SelectFilter name="branded" label={t("Brand")} value={f.branded} all={t("All")} options={[{ value: "BRANDED", label: t("Branded") }, { value: "NON_BRANDED", label: t("Non-branded") }]} />
        <SelectFilter name="topic" label={t("Topic type")} value={f.topic} all={t("All")} options={TOPIC_TYPES.map((i) => ({ value: i, label: enumLabel(t, i) }))} />
        <SelectFilter name="status" label={t("Status")} value={f.status} all={lbl("ACTIVE")} options={["CANDIDATE", "ARCHIVED", "ALL"].map((i) => ({ value: i, label: lbl(i) }))} />
        <label className="flex flex-col gap-1">
          <span className="eyebrow">{t("Search")}</span>
          <input name="q" defaultValue={f.q} placeholder={t("contains…")} />
        </label>
      </FilterBar>
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel title={data.total === 1 ? t("{n} query", { n: data.total }) : t("{n} queries", { n: data.total })} eyebrow={t("Universe")} pad={false}>
          {data.rows.length ? (
            <form action={bulkQueryAction}>
              <HiddenBack path={back} />
              {can("query:write") && (
                <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
                  <span className="eyebrow">{t("Selected →")}</span>
                  <Button name="op" value="ACTIVE">{t("Activate")}</Button>
                  <Button name="op" value="ARCHIVED">{t("Archive")}</Button>
                  <Button name="op" value="imp5">{t("Importance {n}", { n: 5 })}</Button>
                  <Button name="op" value="imp3">{t("Importance {n}", { n: 3 })}</Button>
                  <Button name="op" value="imp1">{t("Importance {n}", { n: 1 })}</Button>
                </div>
              )}
              <ResponsiveTable>
                <thead>
                  <tr>
                    <Th />
                    <Th>{t("Query")}</Th>
                    <Th>{t("Classification")}</Th>
                    <Th>{t("Funnel")}</Th>
                    <Th>{t("Imp.")}</Th>
                    <Th>{t("Coverage")}</Th>
                    <Th>{t("Product / cluster")}</Th>
                    <Th>{t("Market")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(({ q, cluster, productName }) => (
                    <tr key={q.id}>
                      <Td label={can("query:write") ? t("Select") : undefined}>{can("query:write") && <input type="checkbox" name="ids[]" value={q.id} aria-label={t("Select {query}", { query: q.query })} className="h-5 w-5" />}</Td>
                      <Td primary>
                        <div className="text-platinum">{q.query}</div>
                        {q.notes && <div className="text-[11px] text-muted">{t(q.notes)}</div>}
                      </Td>
                      <Td label={t("Classification")}>
                        <div className="flex flex-wrap justify-end gap-1 md:justify-start">
                          <Badge tone={q.branded ? "gold" : "muted"}>{q.branded ? t("Branded") : t("Non-branded")}</Badge>
                          <Badge title={t("confidence {pct}%", { pct: Math.round(q.intentConfidence * 100) })}>{lbl(q.intent)}</Badge>
                          {q.topicType && <Badge tone="muted">{enumLabel(t, q.topicType)}</Badge>}
                        </div>
                        {q.intentConfidence < 0.5 && <div className="mt-1 text-[11px] text-warn">{t("Low confidence: please review")}</div>}
                      </Td>
                      <Td label={t("Funnel")} className="text-xs">{lbl(q.funnelStage)}</Td>
                      <Td label={t("Imp.")} className="num">{q.importance}</Td>
                      <Td label={t("Coverage")}>
                        <StatusBadge status={q.coverage} />
                        {q.coverageReason && <div className="mt-1 max-w-56 text-[11px] text-muted">{t(q.coverageReason)}</div>}
                        {q.coveredByUrl && <div className="num max-w-56 truncate text-[11px] text-muted" title={q.coveredByUrl}>{q.coveredByUrl}</div>}
                        {q.status !== "ACTIVE" && <div className="mt-1"><StatusBadge status={q.status} /></div>}
                      </Td>
                      <Td label={t("Product / cluster")} className="text-xs">
                        {productName ?? t("n/a")}
                        <div className="text-muted">{cluster ? t(cluster) : ""}</div>
                      </Td>
                      <Td label={t("Market")} className="num text-xs">
                        {q.market} · {q.language}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </ResponsiveTable>
            </form>
          ) : (
            <div className="p-4">
              {f.intent || f.coverage || f.branded || f.topic || f.q ? (
                <EmptyState variant="filtered" what={t("No queries match")} why={t("The intent, coverage, brand, topic or search filters hide every query of this list.")} action={{ label: t("Clear filters"), href: `/queries?status=${f.status}${f.product ? `&product=${f.product}` : ""}` }} />
              ) : f.status === "ACTIVE" && (data.stats.CANDIDATE ?? 0) > 0 ? (
                <EmptyState
                  variant="no_data_yet"
                  what={t("No active queries yet.")}
                  why={t("Candidate queries are waiting for review. Only the queries you activate drive coverage, content gaps and opportunities.")}
                  action={{ label: t("Review candidates"), href: `/queries?status=CANDIDATE${f.product ? `&product=${f.product}` : ""}` }}
                />
              ) : (
                <EmptyState
                  variant="not_generated"
                  what={t("No queries yet.")}
                  why={t("Add queries manually or generate the universe from a product’s knowledge graph.")}
                  action={can("query:write") && data.product ? { label: t("Generate candidates"), form: { action: generateQueriesAction, fields: { productId: data.product.id }, back } } : { label: t("Open products"), href: "/products" }}
                />
              )}
            </div>
          )}
          <div className="px-4 pb-3">
            <Pager path="/queries" params={f} shown={data.rows.length} total={data.total} next={data.next} current={sp1(sp, "cursor")} />
          </div>
        </Panel>
        <div className="flex flex-col gap-6">
          {can("query:write") && (
            <Panel title={t("Add query")}>
              <form action={addQueryAction} className="flex flex-col gap-3">
                <HiddenBack path={back} />
                <Field label={t("Query")}>
                  <input name="query" required maxLength={200} placeholder={t("tiktok agency moderation software")} />
                </Field>
                <Field label={t("Product")}>
                  <select name="productId" defaultValue={data.product?.id ?? ""}>
                    <option value="">{t("Ecosystem (no product)")}</option>
                    {data.prods.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label={t("Intent")}>
                    <select name="intent" defaultValue="">
                      <option value="">{t("Auto-classify")}</option>
                      {INTENTS.map((i) => (
                        <option key={i} value={i}>
                          {lbl(i)}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t("Importance")}>
                    <select name="importance" defaultValue="3">
                      {[1, 2, 3, 4, 5].map((i) => (
                        <option key={i}>{i}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label={t("Market")}>
                    <input name="market" defaultValue="global" />
                  </Field>
                  <Field label={t("Language")}>
                    <input name="language" defaultValue="en" />
                  </Field>
                </div>
                <Field label={t("Cluster")}>
                  <input name="cluster" placeholder={t("TikTok live moderation")} />
                </Field>
                <div>
                  <Button variant="gold">{t("Add query")}</Button>
                </div>
              </form>
            </Panel>
          )}
          {can("query:write") && data.prods.length > 0 && (
            <Panel title={t("Generate from knowledge graph")} eyebrow={t("Query universe")}>
              <form action={generateQueriesAction} className="flex flex-col gap-3">
                <HiddenBack path={back} />
                <Field label={t("Product")}>
                  <select name="productId" defaultValue={data.product?.id ?? data.prods[0].id}>
                    {data.prods.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <p className="text-xs text-muted">{t("Derived only from category, keywords, audiences, industries, problems, features, integrations and competitors in the graph.")}</p>
                <div>
                  <Button>{t("Generate candidates")}</Button>
                </div>
              </form>
            </Panel>
          )}
          <Panel title={t("Topic clusters")} eyebrow={t("Semantic clusters · one asset each")}>
            {data.clusters.length ? (
              <ul className="flex flex-col gap-2.5 text-sm">
                {data.clusters.map((c) => (
                  <li key={c.id} className="flex flex-col gap-1">
                    <div className="flex justify-between gap-2">
                      <span className="truncate text-chrome">{t(c.name)}</span>
                      <span className="num shrink-0 text-xs text-muted">{t("{covered}/{n} covered", { covered: c.covered, n: c.n })}</span>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <StatusBadge status={c.coverage} />
                      {c.intent && <Badge tone="muted">{enumLabel(t, c.intent)}</Badge>}
                      {c.recommended_asset && <Badge tone="muted">{enumLabel(t, c.recommended_asset)}</Badge>}
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                variant="not_generated"
                what={t("No clusters yet.")}
                why={data.product ? t("Clusters group the active queries of {product} by topic, one recommended asset each. They are computed from the query universe and refreshed with its coverage.", { product: data.product.name }) : t("Clusters group a product's active queries by topic, one recommended asset each. Select a product in the filters to see or compute them.")}
                action={
                  can("query:write") && data.product
                    ? { label: t("Recompute clusters and coverage"), form: { action: refreshQueryIntelAction, fields: { productId: data.product.id }, back } }
                    : data.product
                      ? { label: t("Review active queries"), href: `/queries?product=${encodeURIComponent(data.product.slug)}&status=ACTIVE` }
                      : data.prods.length
                        ? { label: t("Show clusters for {product}", { product: data.prods[0].name }), href: `/queries?product=${encodeURIComponent(data.prods[0].slug)}` }
                        : { label: t("Add a product"), href: "/products" }
                }
              />
            )}
            {can("query:write") && data.product && data.clusters.length > 0 && (
              <form action={refreshQueryIntelAction} className="mt-4">
                <HiddenBack path={back} />
                <input type="hidden" name="productId" value={data.product.id} />
                <Button>{t("Recompute clusters and coverage")}</Button>
              </form>
            )}
          </Panel>
        </div>
      </div>
      {data.gaps.map((g) => (
        <ContentGaps key={g.product.id} gaps={g.gaps} productId={g.product.id} productSlug={g.product.slug} productName={g.product.name} back={back} canGrowth={can("growth:write")} canContent={can("content:write")} />
      ))}
    </>
  );
}
