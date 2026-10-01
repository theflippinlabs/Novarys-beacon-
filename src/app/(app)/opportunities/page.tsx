import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { regenerateOpportunitiesAction, setOpportunityStatusAction } from "@/app/actions/growth";
import { Badge, Button, EmptyState, Flash, HiddenBack, PageHeader, Panel, PotentialBadge, StatusBadge } from "@/components/ui";
import { FilterBar, SelectFilter } from "@/components/shell/filters";
import { opportunities, products } from "@/db/schema";
import { OPPORTUNITY_CATEGORIES, OPPORTUNITY_TYPES } from "@/core/opportunities/engine";
import { pageData, sp1, type SP } from "@/lib/page";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Opportunities") };
}

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { t } = await getI18n();
  const f = { product: sp1(sp, "product"), potential: sp1(sp, "potential"), status: sp1(sp, "status") ?? "OPEN", category: sp1(sp, "category"), type: sp1(sp, "type") };
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
          f.category ? eq(opportunities.category, f.category) : undefined,
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
        eyebrow={t("08 / Opportunities")}
        title={t("Opportunity engine")}
        description={t("Evidence-based growth opportunities ranked by impact × confidence × urgency ÷ effort. Potential is expressed as LOW / MEDIUM / HIGH; Beacon does not fabricate traffic or revenue forecasts.")}
        actions={
          can("job:run") && (
            <form action={regenerateOpportunitiesAction}>
              <HiddenBack path={back} />
              <input type="hidden" name="productId" value={data.product?.id ?? ""} />
              <Button>{t("Regenerate")}</Button>
            </form>
          )
        }
      />
      <Flash searchParams={sp} />
      <FilterBar action="/opportunities">
        <SelectFilter name="product" label={t("Product")} value={f.product} options={data.prods.map((p) => ({ value: p.slug, label: p.name }))} />
        <SelectFilter name="potential" label={t("Potential")} value={f.potential} options={["HIGH", "MEDIUM", "LOW"].map((v) => ({ value: v, label: enumLabel(t, v) }))} />
        <SelectFilter name="category" label={t("Category")} value={f.category} options={OPPORTUNITY_CATEGORIES.map((v) => ({ value: v, label: enumLabel(t, v) }))} />
        <SelectFilter name="type" label={t("Type")} value={f.type} options={OPPORTUNITY_TYPES.map((v) => ({ value: v, label: enumLabel(t, v) }))} />
        <SelectFilter name="status" label={t("Status")} value={f.status} all={enumLabel(t, "OPEN")} options={["ACCEPTED", "IN_PROGRESS", "DONE", "DISMISSED", "OBSOLETE", "ALL"].map((v) => ({ value: v, label: enumLabel(t, v) }))} />
      </FilterBar>
      {data.rows.length === 0 ? (
        f.product || f.potential || f.category || f.type || (f.status !== "OPEN" && f.status !== "ALL") ? (
          <EmptyState
            variant="filtered"
            what={t("No opportunities match these filters.")}
            why={t("Other opportunities exist outside this product, potential, category, type or status.")}
            action={{ label: t("Clear filters"), href: "/opportunities" }}
          />
        ) : (
          <EmptyState
            variant="not_generated"
            what={t("No opportunities")}
            why={t("Opportunities appear after product analysis, audits, AI-visibility tests and data syncs. Nothing is shown without evidence.")}
            action={can("job:run") ? { label: t("Generate opportunities"), form: { action: regenerateOpportunitiesAction, fields: { productId: data.product?.id ?? "" }, back } } : { label: t("Open products"), href: "/products" }}
          />
        )
      ) : (
        <div className="grid gap-3">
          {data.rows.map(({ o, productName }) => (
            <Panel key={o.id} pad={false}>
              <div className="grid gap-4 p-4 md:grid-cols-[1fr_16rem]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <PotentialBadge potential={o.potential} />
                    <Badge>{enumLabel(t, o.category)}</Badge>
                    <Badge tone="muted">{enumLabel(t, o.type)}</Badge>
                    <StatusBadge status={o.status} />
                    <span className="text-xs text-muted">{productName}</span>
                  </div>
                  <Link href={`/opportunities/${o.id}`} className="mt-2 block text-base text-platinum hover:text-blue-bright">
                    {t(o.title)}
                  </Link>
                  <p className="mt-1 text-sm text-chrome">{t(o.problem)}</p>
                  {o.competitors.length > 0 && <p className="mt-1 text-xs text-muted">{t("Competitors appearing: {list}", { list: o.competitors.join(" / ") })}</p>}
                  {o.nextAction && (
                    <Link href={o.nextAction.href} className="mt-2 inline-block text-xs text-blue-bright hover:underline">
                      {t("Next action: {label}", { label: t(o.nextAction.label) })} →
                    </Link>
                  )}
                </div>
                <div className="flex flex-col items-start gap-2 md:items-end">
                  <div className="num text-2xl text-gold" title={t("priority = impact × confidence × urgency ÷ effort")}>
                    {o.priorityScore}
                  </div>
                  <div className="num text-[10px] text-muted">
                    {t("IMPACT {impact} · CONF {confidence} · EFFORT {effort} · URG {urgency}", { impact: o.impact, confidence: o.confidence, effort: o.effort, urgency: o.urgency })}
                  </div>
                  {can("growth:write") && o.status === "OPEN" && (
                    <form action={setOpportunityStatusAction} className="flex gap-2">
                      <HiddenBack path={back} />
                      <input type="hidden" name="id" value={o.id} />
                      <Button name="status" value="ACCEPTED">{t("Accept")}</Button>
                      <Button name="status" value="DISMISSED">{t("Dismiss")}</Button>
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
