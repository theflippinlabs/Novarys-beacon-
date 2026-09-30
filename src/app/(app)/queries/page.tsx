import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import { addQueryAction, bulkQueryAction, generateQueriesAction } from "@/app/actions/discovery";
import { Badge, Button, EmptyState, Field, Flash, HiddenBack, PageHeader, Panel, StatusBadge, Table, Td, Th } from "@/components/ui";
import { FilterBar, SelectFilter } from "@/components/shell/filters";
import { products, queries, queryClusters } from "@/db/schema";
import { pageData, sp1, type SP } from "@/lib/page";

export const metadata = { title: "Queries" };

const INTENTS = ["INFORMATIONAL", "COMMERCIAL", "TRANSACTIONAL", "NAVIGATIONAL", "COMPARISON", "PROBLEM", "ALTERNATIVE"];

export default async function QueriesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
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
      <PageHeader eyebrow="04 / Queries" title="Query intelligence" description="The discovery query universe: intent, funnel stage, importance and coverage per market and language. Generated queries arrive as candidates — long-tail variations are tracked, never mass-produced into pages." />
      <Flash searchParams={sp} />
      <div className="mb-6 grid grid-cols-3 gap-3 md:max-w-xl">
        {["ACTIVE", "CANDIDATE", "ARCHIVED"].map((s) => (
          <a key={s} href={`/queries?status=${s}${f.product ? `&product=${f.product}` : ""}`} className={`border p-3 ${f.status === s ? "border-gold" : "border-line"} bg-panel`}>
            <div className="eyebrow">{s}</div>
            <div className="num mt-1 text-xl text-platinum">{data.stats[s] ?? 0}</div>
          </a>
        ))}
      </div>
      <FilterBar action="/queries">
        <SelectFilter name="product" label="Product" value={f.product} options={data.prods.map((p) => ({ value: p.slug, label: p.name }))} />
        <SelectFilter name="intent" label="Intent" value={f.intent} options={INTENTS.map((i) => ({ value: i, label: i }))} />
        <SelectFilter name="coverage" label="Coverage" value={f.coverage} options={["NONE", "PARTIAL", "COVERED"].map((i) => ({ value: i, label: i }))} />
        <SelectFilter name="status" label="Status" value={f.status} all="ACTIVE" options={["CANDIDATE", "ARCHIVED", "ALL"].map((i) => ({ value: i, label: i }))} />
        <label className="flex flex-col gap-1">
          <span className="eyebrow">Search</span>
          <input name="q" defaultValue={f.q} placeholder="contains…" />
        </label>
      </FilterBar>
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel title={`${data.rows.length} quer${data.rows.length === 1 ? "y" : "ies"}`} eyebrow="Universe" pad={false}>
          {data.rows.length ? (
            <form action={bulkQueryAction}>
              <HiddenBack path={back} />
              {can("query:write") && (
                <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
                  <span className="eyebrow">Selected →</span>
                  <Button name="op" value="ACTIVE">Activate</Button>
                  <Button name="op" value="ARCHIVED">Archive</Button>
                  <Button name="op" value="imp5">Importance 5</Button>
                  <Button name="op" value="imp3">Importance 3</Button>
                  <Button name="op" value="imp1">Importance 1</Button>
                </div>
              )}
              <Table>
                <thead>
                  <tr>
                    <Th />
                    <Th>Query</Th>
                    <Th>Intent</Th>
                    <Th>Funnel</Th>
                    <Th>Imp.</Th>
                    <Th>Coverage</Th>
                    <Th>Product / cluster</Th>
                    <Th>Market</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.rows.map(({ q, cluster, productName }) => (
                    <tr key={q.id}>
                      <Td>{can("query:write") && <input type="checkbox" name="ids[]" value={q.id} aria-label={`Select ${q.query}`} />}</Td>
                      <Td>
                        <div className="text-platinum">{q.query}</div>
                        {q.notes && <div className="text-[11px] text-muted">{q.notes}</div>}
                      </Td>
                      <Td>
                        <Badge title={`confidence ${Math.round(q.intentConfidence * 100)}%`}>{q.intent}</Badge>
                      </Td>
                      <Td className="text-xs">{q.funnelStage}</Td>
                      <Td className="num">{q.importance}</Td>
                      <Td>
                        <StatusBadge status={q.coverage} />
                        {q.status !== "ACTIVE" && <div className="mt-1"><StatusBadge status={q.status} /></div>}
                      </Td>
                      <Td className="text-xs">
                        {productName ?? "—"}
                        <div className="text-muted">{cluster ?? ""}</div>
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
              <EmptyState title="No queries match">Add queries manually or generate the universe from a product’s knowledge graph.</EmptyState>
            </div>
          )}
        </Panel>
        <div className="flex flex-col gap-6">
          {can("query:write") && (
            <Panel title="Add query">
              <form action={addQueryAction} className="flex flex-col gap-3">
                <HiddenBack path={back} />
                <Field label="Query">
                  <input name="query" required maxLength={200} placeholder="tiktok agency moderation software" />
                </Field>
                <Field label="Product">
                  <select name="productId" defaultValue={data.product?.id ?? ""}>
                    <option value="">Ecosystem (no product)</option>
                    {data.prods.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Intent">
                    <select name="intent" defaultValue="">
                      <option value="">Auto-classify</option>
                      {INTENTS.map((i) => (
                        <option key={i}>{i}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Importance">
                    <select name="importance" defaultValue="3">
                      {[1, 2, 3, 4, 5].map((i) => (
                        <option key={i}>{i}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Market">
                    <input name="market" defaultValue="global" />
                  </Field>
                  <Field label="Language">
                    <input name="language" defaultValue="en" />
                  </Field>
                </div>
                <Field label="Cluster">
                  <input name="cluster" placeholder="TikTok live moderation" />
                </Field>
                <div>
                  <Button variant="gold">Add query</Button>
                </div>
              </form>
            </Panel>
          )}
          {can("query:write") && data.prods.length > 0 && (
            <Panel title="Generate from knowledge graph" eyebrow="Query universe">
              <form action={generateQueriesAction} className="flex flex-col gap-3">
                <HiddenBack path={back} />
                <Field label="Product">
                  <select name="productId" defaultValue={data.product?.id ?? data.prods[0].id}>
                    {data.prods.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <p className="text-xs text-muted">Derived only from category, keywords, audiences, industries, problems, features, integrations and competitors in the graph.</p>
                <div>
                  <Button>Generate candidates</Button>
                </div>
              </form>
            </Panel>
          )}
          <Panel title="Topic clusters" eyebrow="Active queries">
            {data.clusters.length ? (
              <ul className="flex flex-col gap-1.5 text-sm">
                {data.clusters.map((c) => (
                  <li key={c.name} className="flex justify-between gap-2">
                    <span className="truncate text-chrome">{c.name}</span>
                    <span className="num text-xs text-muted">
                      {c.covered}/{c.n} covered
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted">No clusters yet.</p>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
