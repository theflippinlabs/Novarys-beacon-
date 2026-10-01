import type { Metadata } from "next";
import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import { addQueryAction, bulkQueryAction, generateQueriesAction } from "@/app/actions/discovery";
import { Badge, Button, EmptyState, Field, Flash, HiddenBack, PageHeader, Panel, StatusBadge, Table, Td, Th } from "@/components/ui";
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
  const f = { product: sp1(sp, "product"), intent: sp1(sp, "intent"), status: sp1(sp, "status") ?? "ACTIVE", coverage: sp1(sp, "coverage"), q: sp1(sp, "q") };
  const { data, can } = await pageData(async (tx, ctx) => {
    const prods = await tx.select().from(products).where(eq(products.organizationId, ctx.org.id)).orderBy(products.name);
    const product = f.product ? prods.find((p) => p.slug === f.product) : undefined;
    const rows = await tx
      .select({ q: queries, cluster: queryClusters.name, productName: products.name })
      .from(queries)
      .leftJoin(queryClusters, eq(queryClusters.id, queries.clusterId))
      .leftJoin(products, eq(products.id, queries.productId))
      .where(
        and(
          eq(queries.organizationId, ctx.org.id),
          product ? eq(queries.productId, product.id) : undefined,
          f.intent ? eq(queries.intent, f.intent as never) : undefined,
          f.status && f.status !== "ALL" ? eq(queries.status, f.status as never) : undefined,
          f.coverage ? eq(queries.coverage, f.coverage as never) : undefined,
          f.q ? ilike(queries.normalized, `%${f.q.toLowerCase().replace(/[%_]/g, "")}%`) : undefined,
        ),
      )
      .orderBy(desc(queries.importance), asc(queries.normalized))
      .limit(500);
    const stats = await tx.execute<{ status: string; n: number }>(sql`select status, count(*)::int as n from queries where organization_id = ${ctx.org.id} group by status`);
    const clusters = await tx.execute<{ name: string; n: number; covered: number }>(sql`
      select c.name, count(q.id)::int as n, count(q.id) filter (where q.coverage = 'COVERED')::int as covered
      from query_clusters c join queries q on q.cluster_id = c.id
      where c.organization_id = ${ctx.org.id} and q.status = 'ACTIVE' ${product ? sql`and c.product_id = ${product.id}` : sql``}
      group by c.name order by n desc limit 20`);
    return { prods, product, rows, stats: Object.fromEntries(stats.rows.map((r) => [r.status, Number(r.n)])), clusters: clusters.rows };
  });
  const back = `/queries?${new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][]).toString()}`;
  return (
    <>
      <PageHeader eyebrow={t("04 / Queries")} title={t("Query intelligence")} description={t("The discovery query universe: intent, funnel stage, importance and coverage per market and language. Generated queries arrive as candidates; long-tail variations are tracked, never mass-produced into pages.")} />
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
        <SelectFilter name="status" label={t("Status")} value={f.status} all={lbl("ACTIVE")} options={["CANDIDATE", "ARCHIVED", "ALL"].map((i) => ({ value: i, label: lbl(i) }))} />
        <label className="flex flex-col gap-1">
          <span className="eyebrow">{t("Search")}</span>
          <input name="q" defaultValue={f.q} placeholder={t("contains…")} />
        </label>
      </FilterBar>
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel title={data.rows.length === 1 ? t("{n} query", { n: data.rows.length }) : t("{n} queries", { n: data.rows.length })} eyebrow={t("Universe")} pad={false}>
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
              <Table>
                <thead>
                  <tr>
                    <Th />
                    <Th>{t("Query")}</Th>
                    <Th>{t("Intent")}</Th>
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
                      <Td>{can("query:write") && <input type="checkbox" name="ids[]" value={q.id} aria-label={t("Select {query}", { query: q.query })} />}</Td>
                      <Td>
                        <div className="text-platinum">{q.query}</div>
                        {q.notes && <div className="text-[11px] text-muted">{t(q.notes)}</div>}
                      </Td>
                      <Td>
                        <Badge title={t("confidence {pct}%", { pct: Math.round(q.intentConfidence * 100) })}>{lbl(q.intent)}</Badge>
                      </Td>
                      <Td className="text-xs">{lbl(q.funnelStage)}</Td>
                      <Td className="num">{q.importance}</Td>
                      <Td>
                        <StatusBadge status={q.coverage} />
                        {q.status !== "ACTIVE" && <div className="mt-1"><StatusBadge status={q.status} /></div>}
                      </Td>
                      <Td className="text-xs">
                        {productName ?? t("n/a")}
                        <div className="text-muted">{cluster ? t(cluster) : ""}</div>
                      </Td>
                      <Td className="num text-xs">
                        {q.market} · {q.language}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </form>
          ) : (
            <div className="p-4">
              <EmptyState title={t("No queries match")}>{t("Add queries manually or generate the universe from a product’s knowledge graph.")}</EmptyState>
            </div>
          )}
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
          <Panel title={t("Topic clusters")} eyebrow={t("Active queries")}>
            {data.clusters.length ? (
              <ul className="flex flex-col gap-1.5 text-sm">
                {data.clusters.map((c) => (
                  <li key={c.name} className="flex justify-between gap-2">
                    <span className="truncate text-chrome">{t(c.name)}</span>
                    <span className="num text-xs text-muted">
                      {t("{covered}/{n} covered", { covered: c.covered, n: c.n })}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">{t("No clusters yet.")}</p>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
