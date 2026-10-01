import { and, desc, eq } from "drizzle-orm";
import { addDistributionTargetAction, approveSubmissionAction, setDistributionStatusAction } from "@/app/actions/growth";
import { Badge, Button, EmptyState, Field, Flash, HiddenBack, PageHeader, Panel } from "@/components/ui";
import { FilterBar, SelectFilter } from "@/components/shell/filters";
import { distributionTargets, products } from "@/db/schema";
import { REQUIRES_APPROVAL } from "@/core/distribution/catalog";
import { pageData, sp1, type SP } from "@/lib/page";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Distribution") };
}

const STATUSES = ["DISCOVERED", "QUALIFIED", "PREPARED", "SUBMITTED", "PUBLISHED", "PERFORMING", "FOLLOW_UP", "REJECTED"] as const;
const NEXT: Record<string, string[]> = {
  DISCOVERED: ["QUALIFIED", "REJECTED"],
  QUALIFIED: ["PREPARED", "REJECTED"],
  PREPARED: ["SUBMITTED", "REJECTED"],
  SUBMITTED: ["PUBLISHED", "FOLLOW_UP", "REJECTED"],
  FOLLOW_UP: ["SUBMITTED", "PUBLISHED", "REJECTED"],
  PUBLISHED: ["PERFORMING", "FOLLOW_UP"],
  PERFORMING: ["FOLLOW_UP"],
  REJECTED: ["DISCOVERED"],
};
const KINDS = ["DIRECTORY", "LAUNCH_PLATFORM", "COMMUNITY", "SOCIAL_CHANNEL", "NEWSLETTER", "PARTNER", "AFFILIATE", "INFLUENCER", "AGENCY", "MEDIA", "BACKLINK"];

export default async function DistributionPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { t } = await getI18n();
  const f = { product: sp1(sp, "product"), kind: sp1(sp, "kind") };
  const { data, can } = await pageData(async (tx, ctx) => {
    const prods = await tx.select().from(products).where(eq(products.organizationId, ctx.org.id)).orderBy(products.name);
    const product = f.product ? prods.find((p) => p.slug === f.product) : undefined;
    const rows = await tx
      .select({ t: distributionTargets, productName: products.name })
      .from(distributionTargets)
      .leftJoin(products, eq(products.id, distributionTargets.productId))
      .where(and(eq(distributionTargets.organizationId, ctx.org.id), product ? eq(distributionTargets.productId, product.id) : undefined, f.kind ? eq(distributionTargets.kind, f.kind as never) : undefined))
      .orderBy(desc(distributionTargets.updatedAt));
    return { prods, rows };
  });
  const back = `/distribution?${new URLSearchParams(Object.entries(f).filter(([, v]) => v) as [string, string][])}`;
  return (
    <>
      <PageHeader eyebrow={t("06 / Distribution")} title={t("Distribution center")} description={t("Directories, launch platforms, communities, partners, media and backlink opportunities. Beacon never spams third-party platforms: external submissions require a recorded human approval.")} />
      <Flash searchParams={sp} />
      <FilterBar action="/distribution">
        <SelectFilter name="product" label={t("Product")} value={f.product} options={data.prods.map((p) => ({ value: p.slug, label: p.name }))} />
        <SelectFilter name="kind" label={t("Kind")} value={f.kind} options={KINDS.map((k) => ({ value: k, label: enumLabel(t, k) }))} />
      </FilterBar>
      <div className="grid gap-6 2xl:grid-cols-[1fr_22rem]">
        {data.rows.length === 0 ? (
          <EmptyState title={t("No distribution targets")}>{t("Product analysis suggests well-known venues; add your own partners, newsletters, communities and media.")}</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <div className="grid min-w-[72rem] grid-cols-8 gap-2">
              {STATUSES.map((s) => {
                const list = data.rows.filter((r) => r.t.status === s);
                return (
                  <div key={s} className="flex flex-col gap-2">
                    <div className="eyebrow flex justify-between border-b border-line pb-2">
                      <span>{enumLabel(t, s)}</span>
                      <span className="num">{list.length}</span>
                    </div>
                    {list.map(({ t: dt, productName }) => (
                      <div key={dt.id} className="border border-line bg-panel p-2.5">
                        <div className="text-xs text-platinum">
                          {dt.url ? (
                            <a href={dt.url} target="_blank" rel="noreferrer noopener" className="hover:text-blue-bright">
                              {dt.name}
                            </a>
                          ) : (
                            dt.name
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <Badge tone="muted">{enumLabel(t, dt.kind)}</Badge>
                          {dt.submissionApprovedAt && <Badge tone="ok">{t("approved")}</Badge>}
                        </div>
                        <div className="mt-1 truncate text-[10px] text-muted">{productName ?? t("Ecosystem")}</div>
                        {dt.notes && <div className="mt-1 line-clamp-3 text-[10px] text-muted">{t(dt.notes)}</div>}
                        {dt.publishedUrl && (
                          <a href={dt.publishedUrl} className="num mt-1 block truncate text-[10px] text-gold-bright" target="_blank" rel="noreferrer noopener">
                            {dt.publishedUrl}
                          </a>
                        )}
                        {can("distribution:write") && (
                          <form action={setDistributionStatusAction} className="mt-2 flex flex-wrap gap-1">
                            <HiddenBack path={back} />
                            <input type="hidden" name="id" value={dt.id} />
                            {(NEXT[dt.status] ?? []).map((n) => {
                              const blocked = REQUIRES_APPROVAL.has(n) && !dt.submissionApprovedAt;
                              return (
                                <button key={n} name="status" value={n} disabled={blocked} title={blocked ? t("Requires approval first") : undefined} className="border border-line px-1.5 py-0.5 font-mono text-[9px] uppercase text-chrome hover:border-chrome disabled:opacity-40">
                                  → {enumLabel(t, n)}
                                </button>
                              );
                            })}
                          </form>
                        )}
                        {can("distribution:approve") && !dt.submissionApprovedAt && (dt.status === "PREPARED" || dt.status === "QUALIFIED") && (
                          <form action={approveSubmissionAction} className="mt-1">
                            <HiddenBack path={back} />
                            <input type="hidden" name="id" value={dt.id} />
                            <button className="font-mono text-[9px] uppercase text-blue-bright hover:text-cyan">{t("✓ approve submission")}</button>
                          </form>
                        )}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          </div>
        )}
        {can("distribution:write") && (
          <Panel title={t("Add target")}>
            <form action={addDistributionTargetAction} className="flex flex-col gap-3">
              <HiddenBack path={back} />
              <Field label={t("Name")}>
                <input name="name" required maxLength={120} />
              </Field>
              <Field label={t("Kind")}>
                <select name="kind">
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {enumLabel(t, k)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("URL (https)")}>
                <input name="url" type="url" placeholder="https://" />
              </Field>
              <Field label={t("Product")}>
                <select name="productId" defaultValue="">
                  <option value="">{t("Ecosystem")}</option>
                  {data.prods.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("Relevance (1–5)")}>
                <input name="relevance" type="number" min={1} max={5} defaultValue={3} />
              </Field>
              <Field label={t("Notes")}>
                <textarea name="notes" className="min-h-16" />
              </Field>
              <div>
                <Button>{t("Add")}</Button>
              </div>
            </form>
            <p className="mt-4 text-xs text-muted">{t("Prepare submission copy in the Content studio (format “Directory description” or “Outreach”).")}</p>
          </Panel>
        )}
      </div>
    </>
  );
}
