import { and, desc, eq } from "drizzle-orm";
import { addDistributionTargetAction, approveSubmissionAction, setDistributionStatusAction } from "@/app/actions/growth";
import { Badge, Button, EmptyState, Field, Flash, HiddenBack, PageHeader, Panel } from "@/components/ui";
import { FilterBar, SelectFilter } from "@/components/shell/filters";
import { distributionTargets, products } from "@/db/schema";
import { REQUIRES_APPROVAL } from "@/core/distribution/catalog";
import { pageData, sp1, type SP } from "@/lib/page";

export const metadata = { title: "Distribution" };

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
      <PageHeader eyebrow="06 / Distribution" title="Distribution center" description="Directories, launch platforms, communities, partners, media and backlink opportunities. Beacon never spams third-party platforms: external submissions require a recorded human approval." />
      <Flash searchParams={sp} />
      <FilterBar action="/distribution">
        <SelectFilter name="product" label="Product" value={f.product} options={data.prods.map((p) => ({ value: p.slug, label: p.name }))} />
        <SelectFilter name="kind" label="Kind" value={f.kind} options={KINDS.map((k) => ({ value: k, label: k.replace(/_/g, " ") }))} />
      </FilterBar>
      <div className="grid gap-6 2xl:grid-cols-[1fr_22rem]">
        {data.rows.length === 0 ? (
          <EmptyState title="No distribution targets">Product analysis suggests well-known venues; add your own partners, newsletters, communities and media.</EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <div className="grid min-w-[72rem] grid-cols-8 gap-2">
              {STATUSES.map((s) => {
                const list = data.rows.filter((r) => r.t.status === s);
                return (
                  <div key={s} className="flex flex-col gap-2">
                    <div className="eyebrow flex justify-between border-b border-line pb-2">
                      <span>{s.replace("_", " ")}</span>
                      <span className="num">{list.length}</span>
                    </div>
                    {list.map(({ t, productName }) => (
                      <div key={t.id} className="border border-line bg-panel p-2.5">
                        <div className="text-xs text-platinum">
                          {t.url ? (
                            <a href={t.url} target="_blank" rel="noreferrer noopener" className="hover:text-gold-bright">
                              {t.name}
                            </a>
                          ) : (
                            t.name
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          <Badge tone="muted">{t.kind.replace(/_/g, " ")}</Badge>
                          {t.submissionApprovedAt && <Badge tone="ok">approved</Badge>}
                        </div>
                        <div className="mt-1 truncate text-[10px] text-muted">{productName ?? "Ecosystem"}</div>
                        {t.notes && <div className="mt-1 line-clamp-3 text-[10px] text-muted">{t.notes}</div>}
                        {t.publishedUrl && (
                          <a href={t.publishedUrl} className="num mt-1 block truncate text-[10px] text-gold-bright" target="_blank" rel="noreferrer noopener">
                            {t.publishedUrl}
                          </a>
                        )}
                        {can("distribution:write") && (
                          <form action={setDistributionStatusAction} className="mt-2 flex flex-wrap gap-1">
                            <HiddenBack path={back} />
                            <input type="hidden" name="id" value={t.id} />
                            {(NEXT[t.status] ?? []).map((n) => {
                              const blocked = REQUIRES_APPROVAL.has(n) && !t.submissionApprovedAt;
                              return (
                                <button key={n} name="status" value={n} disabled={blocked} title={blocked ? "Requires approval first" : undefined} className="border border-line px-1.5 py-0.5 font-mono text-[9px] uppercase text-chrome hover:border-chrome disabled:opacity-40">
                                  → {n.replace("_", " ")}
                                </button>
                              );
                            })}
                          </form>
                        )}
                        {can("distribution:approve") && !t.submissionApprovedAt && (t.status === "PREPARED" || t.status === "QUALIFIED") && (
                          <form action={approveSubmissionAction} className="mt-1">
                            <HiddenBack path={back} />
                            <input type="hidden" name="id" value={t.id} />
                            <button className="font-mono text-[9px] uppercase text-gold hover:text-gold-bright">✓ approve submission</button>
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
          <Panel title="Add target">
            <form action={addDistributionTargetAction} className="flex flex-col gap-3">
              <HiddenBack path={back} />
              <Field label="Name">
                <input name="name" required maxLength={120} />
              </Field>
              <Field label="Kind">
                <select name="kind">
                  {KINDS.map((k) => (
                    <option key={k} value={k}>
                      {k.replace(/_/g, " ")}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="URL (https)">
                <input name="url" type="url" placeholder="https://" />
              </Field>
              <Field label="Product">
                <select name="productId" defaultValue="">
                  <option value="">Ecosystem</option>
                  {data.prods.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Relevance (1–5)">
                <input name="relevance" type="number" min={1} max={5} defaultValue={3} />
              </Field>
              <Field label="Notes">
                <textarea name="notes" className="min-h-16" />
              </Field>
              <div>
                <Button>Add</Button>
              </div>
            </form>
            <p className="mt-4 text-xs text-muted">Prepare submission copy in the Content studio (format “Directory description” or “Outreach”).</p>
          </Panel>
        )}
      </div>
    </>
  );
}
