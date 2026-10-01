import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { regenerateOpportunitiesAction, setOpportunityStatusAction } from "@/app/actions/growth";
import { Badge, Button, EmptyState, Flash, HiddenBack, PageHeader, Panel, PotentialBadge, StatusBadge } from "@/components/ui";
import { FilterBar, SelectFilter } from "@/components/shell/filters";
import { opportunities, products } from "@/db/schema";
import { pageData, sp1, type SP } from "@/lib/page";

export const metadata = { title: "Opportunities" };

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const f = { product: sp1(sp, "product"), potential: sp1(sp, "potential"), status: sp1(sp, "status") ?? "OPEN", type: sp1(sp, "type") };
  const { data, can } = await pageData(async (tx, ctx) => {
    const prods = await tx.select().from(products).where(eq(products.organizationId, ctx.org.id)).orderBy(products.name);
    const product = f.product ? prods.find((p) => p.slug === f.product) : undefined;
    const rows = await tx
      .select({ o: opportunities, productName: products.name })
      .from(opportunities)
      .leftJoin(products, eq(products.id, opportunities.productId))
      .where(
        and(
          eq(opportunities.organizationId, ctx.org.id),
          product ? eq(opportunities.productId, product.id) : undefined,
          f.potential ? eq(opportunities.potential, f.potential as never) : undefined,
          f.status !== "ALL" ? eq(opportunities.status, f.status as never) : undefined,
          f.type ? eq(opportunities.type, f.type) : undefined,
        ),
      )
      .orderBy(desc(opportunities.priorityScore))
      .limit(300);
    return { prods, product, rows };
  });
  const back = `/opportunities?${new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][])}`;
  return (
    <>
      <PageHeader
        eyebrow="08 / Opportunities"
        title="Opportunity engine"
        description="Evidence-based growth opportunities ranked by impact × confidence × urgency ÷ effort. Potential is expressed as LOW / MEDIUM / HIGH — Beacon does not fabricate traffic or revenue forecasts."
        actions={
          can("job:run") && (
            <form action={regenerateOpportunitiesAction}>
              <HiddenBack path={back} />
              <input type="hidden" name="productId" value={data.product?.id ?? ""} />
              <Button>Regenerate</Button>
            </form>
          )
        }
      />
      <Flash searchParams={sp} />
      <FilterBar action="/opportunities">
        <SelectFilter name="product" label="Product" value={f.product} options={data.prods.map((p) => ({ value: p.slug, label: p.name }))} />
        <SelectFilter name="potential" label="Potential" value={f.potential} options={["HIGH", "MEDIUM", "LOW"].map((v) => ({ value: v, label: v }))} />
        <SelectFilter name="type" label="Type" value={f.type} options={["CONTENT_GAP", "STRIKING_DISTANCE", "LOW_CTR", "AI_VISIBILITY_GAP", "TECHNICAL", "ENTITY_COMPLETENESS", "COMPARISON_FACTS", "INTERNAL_LINKING", "CONVERSION", "VISIBILITY_DROP"].map((v) => ({ value: v, label: v }))} />
        <SelectFilter name="status" label="Status" value={f.status} all="OPEN" options={["ACCEPTED", "IN_PROGRESS", "DONE", "DISMISSED", "ALL"].map((v) => ({ value: v, label: v }))} />
      </FilterBar>
      {data.rows.length === 0 ? (
        <EmptyState title="No opportunities">Opportunities appear after product analysis, audits, AI-visibility tests and data syncs. Nothing is shown without evidence.</EmptyState>
      ) : (
        <div className="grid gap-3">
          {data.rows.map(({ o, productName }) => (
            <Panel key={o.id} pad={false}>
              <div className="grid gap-4 p-4 md:grid-cols-[1fr_16rem]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <PotentialBadge potential={o.potential} />
                    <Badge tone="muted">{o.type.replace(/_/g, " ")}</Badge>
                    <StatusBadge status={o.status} />
                    <span className="text-xs text-muted">{productName}</span>
                  </div>
                  <Link href={`/opportunities/${o.id}`} className="mt-2 block text-base text-platinum hover:text-gold-bright">
                    {o.title}
                  </Link>
                  <p className="mt-1 text-sm text-chrome">{o.problem}</p>
                  {o.competitors.length > 0 && <p className="mt-1 text-xs text-muted">Competitors appearing: {o.competitors.join(" / ")}</p>}
                </div>
                <div className="flex flex-col items-start gap-2 md:items-end">
                  <div className="num text-2xl text-gold" title="priority = impact × confidence × urgency ÷ effort">
                    {o.priorityScore}
                  </div>
                  <div className="num text-[10px] text-muted">
                    IMPACT {o.impact} · CONF {o.confidence} · EFFORT {o.effort} · URG {o.urgency}
                  </div>
                  {can("growth:write") && o.status === "OPEN" && (
                    <form action={setOpportunityStatusAction} className="flex gap-2">
                      <HiddenBack path={back} />
                      <input type="hidden" name="id" value={o.id} />
                      <Button name="status" value="ACCEPTED">Accept</Button>
                      <Button name="status" value="DISMISSED">Dismiss</Button>
                    </form>
                  )}
                </div>
              </div>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}
