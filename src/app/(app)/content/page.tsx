import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { createContentAction } from "@/app/actions/content";
import { Button, EmptyState, Field, Flash, HiddenBack, PageHeader, Panel, Badge } from "@/components/ui";
import { FilterBar, SelectFilter } from "@/components/shell/filters";
import { contentAssets, products, queries } from "@/db/schema";
import { PIPELINE } from "@/core/content/workflow";
import { pageData, sp1, type SP } from "@/lib/page";

export const metadata = { title: "Content" };

const TYPES = ["LANDING_PAGE", "ARTICLE", "FAQ", "TUTORIAL", "COMPARISON", "RELEASE_ANNOUNCEMENT", "X_POST", "LINKEDIN_POST", "TIKTOK_SCRIPT", "SHORT_VIDEO_SCRIPT", "NEWSLETTER", "DIRECTORY_DESCRIPTION", "OUTREACH"];

export default async function ContentPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const f = { product: sp1(sp, "product"), status: sp1(sp, "status"), type: sp1(sp, "type") };
  const { data, can } = await pageData(async (tx, ctx) => {
    const prods = await tx.select().from(products).where(eq(products.organizationId, ctx.org.id)).orderBy(products.name);
    const product = f.product ? prods.find((p) => p.slug === f.product) : undefined;
    const assets = await tx
      .select({ a: contentAssets, productName: products.name })
      .from(contentAssets)
      .leftJoin(products, eq(products.id, contentAssets.productId))
      .where(and(eq(contentAssets.organizationId, ctx.org.id), product ? eq(contentAssets.productId, product.id) : undefined, f.status ? eq(contentAssets.status, f.status as never) : undefined, f.type ? eq(contentAssets.type, f.type as never) : undefined))
      .orderBy(desc(contentAssets.updatedAt))
      .limit(300);
    const qs = await tx.select({ id: queries.id, query: queries.query }).from(queries).where(and(eq(queries.organizationId, ctx.org.id), eq(queries.status, "ACTIVE"), product ? eq(queries.productId, product.id) : undefined)).orderBy(desc(queries.importance)).limit(200);
    return { prods, product, assets, qs };
  });
  const cols = [...PIPELINE, "REJECTED"] as const;
  const back = `/content${f.product ? `?product=${f.product}` : ""}`;
  return (
    <>
      <PageHeader eyebrow="05 / Content" title="AI content studio" description="IDEA → GENERATED → FACT CHECK → SEO/GEO CHECK → HUMAN APPROVAL → PUBLISHED → PERFORMANCE. Drafts are built from verified knowledge-graph facts; invented customers, statistics, integrations, awards, reviews, pricing or competitor claims are flagged and block approval." />
      <Flash searchParams={sp} />
      <FilterBar action="/content">
        <SelectFilter name="product" label="Product" value={f.product} options={data.prods.map((p) => ({ value: p.slug, label: p.name }))} />
        <SelectFilter name="status" label="Stage" value={f.status} options={cols.map((c) => ({ value: c, label: c.replace(/_/g, " ") }))} />
        <SelectFilter name="type" label="Format" value={f.type} options={TYPES.map((t) => ({ value: t, label: t.replace(/_/g, " ") }))} />
      </FilterBar>
      <div className="grid gap-6 2xl:grid-cols-[1fr_22rem]">
        <div className="overflow-x-auto">
          {data.assets.length === 0 ? (
            <EmptyState title="No content yet">Create an asset here, from a planned page in Discovery, or from an opportunity.</EmptyState>
          ) : (
            <div className="grid min-w-[64rem] grid-cols-8 gap-2">
              {cols.map((col) => {
                const list = data.assets.filter((x) => x.a.status === col);
                return (
                  <div key={col} className="flex flex-col gap-2">
                    <div className="eyebrow flex justify-between border-b border-line pb-2">
                      <span>{col.replace(/_/g, " ")}</span>
                      <span className="num">{list.length}</span>
                    </div>
                    {list.map(({ a, productName }) => (
                      <Link key={a.id} href={`/content/${a.id}`} className="border border-line bg-panel p-2.5 hover:border-line-strong">
                        <div className="line-clamp-3 text-xs text-platinum">{a.title}</div>
                        <div className="mt-1.5 flex flex-wrap gap-1">
                          <Badge tone="muted">{a.type.replace(/_/g, " ")}</Badge>
                        </div>
                        <div className="mt-1 truncate text-[10px] text-muted">{productName}</div>
                      </Link>
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {can("content:write") && data.prods.length > 0 && (
          <Panel title="New content" eyebrow="Workspace">
            <form action={createContentAction} className="flex flex-col gap-3">
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
              <Field label="Format">
                <select name="type" defaultValue="LANDING_PAGE">
                  {TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Working title (optional)">
                <input name="title" maxLength={200} />
              </Field>
              <Field label="Target query (optional)">
                <select name="targetQueryId" defaultValue="">
                  <option value="">—</option>
                  {data.qs.map((q) => (
                    <option key={q.id} value={q.id}>
                      {q.query}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Brief (optional)">
                <textarea name="brief" className="min-h-16" />
              </Field>
              <label className="flex items-center gap-2 text-xs text-chrome">
                <input type="checkbox" name="useLlm" /> Let the configured LLM polish prose (facts still checked)
              </label>
              <div className="flex gap-2">
                <Button variant="gold" name="generate" value="1">
                  Generate draft
                </Button>
                <Button>Save idea</Button>
              </div>
            </form>
          </Panel>
        )}
      </div>
    </>
  );
}
