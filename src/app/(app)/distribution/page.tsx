import { and, count, desc, eq, sql } from "drizzle-orm";
import { Pager } from "@/components/shell/pager";
import { decodeCursor, PAGE_SIZE, pageOf } from "@/core/util/cursor";
import Link from "next/link";
import { addDistributionTargetAction, approveSubmissionAction, prepareSubmissionAction, setDistributionStatusAction } from "@/app/actions/growth";
import { Badge, Button, EmptyState, Field, Flash, hasActiveFilters, HiddenBack, PageHeader, Panel, ResponsiveTable, StatusBadge, Td, Th, formatValue } from "@/components/ui";
import { FilterBar, SelectFilter } from "@/components/shell/filters";
import { distributionTargets, products } from "@/db/schema";
import { DISTRIBUTION_KINDS, DISTRIBUTION_NEXT, DISTRIBUTION_STATUSES, REQUIRES_APPROVAL, type DistributionStatus } from "@/core/distribution/catalog";
import { DISTRIBUTION_CATEGORIES } from "@/core/distribution/venues";
import { REASON_SEPARATOR } from "@/core/distribution/relevance";
import { approvalStates, measureTargets, trackingLinkFor } from "@/services/distribution";
import { pageData, sp1, type SP } from "@/lib/page";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Distribution") };
}

export default async function DistributionPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { t, intl } = await getI18n();
  const f = { product: sp1(sp, "product"), category: sp1(sp, "category"), status: sp1(sp, "status") };
  const cursor = decodeCursor(sp1(sp, "cursor"));
  const { data, can } = await pageData(async (tx, ctx) => {
    const prods = await tx.select().from(products).where(eq(products.organizationId, ctx.org.id)).orderBy(products.name);
    const product = f.product ? prods.find((p) => p.slug === f.product) : undefined;
    const scope = and(eq(distributionTargets.organizationId, ctx.org.id), product ? eq(distributionTargets.productId, product.id) : undefined, f.category ? eq(distributionTargets.category, f.category as never) : undefined);
    // Status counts for the whole filtered set; the list itself is paginated (cursor, 50 per page, by relevance).
    const statusCounts = await tx.select({ status: distributionTargets.status, n: count() }).from(distributionTargets).where(scope).groupBy(distributionTargets.status);
    const all = statusCounts.map((c) => ({ t: { status: c.status }, n: Number(c.n) }));
    const where = and(scope, f.status ? eq(distributionTargets.status, f.status as never) : undefined);
    const [{ total }] = await tx.select({ total: count() }).from(distributionTargets).where(where);
    const rel = sql`coalesce(${distributionTargets.relevance}, -1)`;
    const after = cursor ? sql`(${rel}, ${distributionTargets.id}) < (${Number(cursor.v)}, ${cursor.id}::uuid)` : undefined;
    const page = pageOf(
      await tx
        .select({ t: distributionTargets, productName: products.name, productDomain: products.domain })
        .from(distributionTargets)
        .leftJoin(products, eq(products.id, distributionTargets.productId))
        .where(and(where, after))
        .orderBy(desc(rel), desc(distributionTargets.id))
        .limit(PAGE_SIZE + 1),
      PAGE_SIZE,
      (r) => ({ v: r.t.relevance ?? -1, id: r.t.id }),
    );
    const rows = page.items;
    const approvals = await approvalStates(tx, ctx.org.id, rows.map((r) => r.t));
    const measured = await measureTargets(tx, ctx.org.id, rows.map((r) => r.t));
    return { prods, rows, all, total, next: page.next, approvals, measured };
  });
  const params = (over: Partial<typeof f>) => new URLSearchParams(Object.entries({ ...f, ...over }).filter(([, v]) => v) as [string, string][]).toString();
  const back = `/distribution?${params({})}`;
  const counts = new Map<string, number>(DISTRIBUTION_STATUSES.map((s) => [s, data.all.find((r) => r.t.status === s)?.n ?? 0]));
  const reason = (text: string | null) =>
    text
      ? text
          .split(REASON_SEPARATOR)
          .map((x) => t(x))
          .join(" · ")
      : t("n/a");

  return (
    <>
      <PageHeader
        eyebrow={t("06 / Distribution")}
        title={t("Distribution center")}
        description={t("Directories, review platforms, launch sites, communities, newsletters, publications, partners, creators and agencies, ranked by relevance to each product. Beacon never submits anything: a person submits each listing after a recorded approval of an approved listing draft.")}
      />
      <Flash searchParams={sp} />
      <FilterBar action="/distribution">
        <SelectFilter name="product" label={t("Product")} value={f.product} options={data.prods.map((p) => ({ value: p.slug, label: p.name }))} />
        <SelectFilter name="category" label={t("Category")} value={f.category} options={DISTRIBUTION_CATEGORIES.map((k) => ({ value: k, label: enumLabel(t, k) }))} />
        <SelectFilter name="status" label={t("Status")} value={f.status} options={DISTRIBUTION_STATUSES.map((k) => ({ value: k, label: enumLabel(t, k) }))} />
      </FilterBar>

      <nav aria-label={t("Pipeline")} className="mb-6 grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
        {DISTRIBUTION_STATUSES.map((s) => (
          <Link key={s} href={`/distribution?${params({ status: f.status === s ? undefined : s })}`} className={`border px-3 py-2 ${f.status === s ? "border-blue-bright" : "border-line hover:border-line-strong"}`}>
            <div className="eyebrow truncate">{enumLabel(t, s)}</div>
            <div className="num text-lg text-platinum">{counts.get(s) ?? 0}</div>
          </Link>
        ))}
      </nav>

      <div className="grid gap-6 2xl:grid-cols-[1fr_22rem]">
        {data.rows.length === 0 ? (
          hasActiveFilters(sp, ["product", "category", "status"]) ? (
            <EmptyState variant="filtered" what={t("No distribution targets match these filters")} why={t("Change or clear the filters to see other targets.")} action={{ label: t("Clear filters"), href: "/distribution" }} />
          ) : (
            <EmptyState
              variant="not_generated"
              what={t("No distribution targets")}
              why={t("Product analysis suggests catalogue venues that fit each product; add your own partners, newsletters, communities and media.")}
              action={{ label: t("Open products"), href: "/products" }}
            />
          )
        ) : (
          <Panel title={t("{n} target(s)", { n: data.total })} eyebrow={t("Ranked by relevance")} pad={false}>
            <ResponsiveTable>
              <thead>
                <tr>
                  <Th>{t("Target")}</Th>
                  <Th>{t("Relevance")}</Th>
                  <Th>{t("Stage")}</Th>
                  <Th>{t("Listing and approval")}</Th>
                  <Th>{t("Tracking")}</Th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map(({ t: dt, productName, productDomain }) => {
                  const ap = data.approvals.get(dt.id)!;
                  const m = data.measured.get(dt.id);
                  const link = trackingLinkFor(dt, productDomain);
                  const next = DISTRIBUTION_NEXT[dt.status as DistributionStatus] ?? [];
                  return (
                    <tr key={dt.id} id={`target-${dt.id}`}>
                      <Td primary label={t("Target")}>
                        <div className="text-platinum">
                          {dt.url ? (
                            <a href={dt.url} target="_blank" rel="noreferrer noopener" className="hover:text-blue-bright">
                              {dt.name}
                            </a>
                          ) : (
                            dt.name
                          )}
                        </div>
                        <div className="mt-1 flex flex-wrap gap-1">
                          {dt.category && <Badge tone="muted">{enumLabel(t, dt.category)}</Badge>}
                          <Badge tone="muted">{productName ?? t("Ecosystem")}</Badge>
                        </div>
                        {dt.requirements && <p className="mt-1 max-w-sm text-[11px] text-muted">{t("Requirements: {text}", { text: t(dt.requirements) })}</p>}
                        {dt.notes && <p className="mt-1 max-w-sm text-[11px] text-muted">{t(dt.notes)}</p>}
                      </Td>
                      <Td label={t("Relevance")}>
                        <div className="num text-platinum">{dt.relevance === null ? t("n/a") : `${dt.relevance}/100`}</div>
                        <p className="mt-1 max-w-xs text-[11px] text-muted">{reason(dt.relevanceReason)}</p>
                      </Td>
                      <Td label={t("Stage")}>
                        <StatusBadge status={dt.status} />
                        {dt.lastAction && (
                          <div className="mt-1 text-[11px] text-muted">
                            {dt.lastAction.startsWith("Moved to ") ? t("Moved to {status}", { status: enumLabel(t, dt.lastAction.slice(9)) }) : t(dt.lastAction)}
                            {dt.lastActionAt ? ` · ${dt.lastActionAt.toISOString().slice(0, 10)}` : ""}
                          </div>
                        )}
                        {dt.result && <div className="mt-1 text-[11px] text-chrome">{t("Result: {result}", { result: dt.result })}</div>}
                        {dt.publishedUrl && (
                          <a href={dt.publishedUrl} className="num mt-1 block max-w-[14rem] truncate text-[11px] text-gold-bright" target="_blank" rel="noreferrer noopener">
                            {dt.publishedUrl}
                          </a>
                        )}
                        {can("distribution:write") && next.length > 0 && (
                          <form action={setDistributionStatusAction} className="mt-2 flex flex-col gap-1.5">
                            <HiddenBack path={`${back}#target-${dt.id}`} />
                            <input type="hidden" name="id" value={dt.id} />
                            {(dt.status === "SUBMITTED" || dt.status === "FOLLOW_UP" || dt.status === "PUBLISHED" || dt.status === "PERFORMING") && (
                              <details className="text-[11px]">
                                <summary className="cursor-pointer text-muted hover:text-chrome">{t("Record the outcome")}</summary>
                                <div className="mt-1 flex flex-col gap-1">
                                  <input name="publishedUrl" type="url" placeholder={t("Published URL (https)")} aria-label={t("Published URL (https)")} />
                                  <input name="result" maxLength={500} placeholder={t("Result")} aria-label={t("Result")} />
                                  <input name="followUpOn" type="date" aria-label={t("Follow up on")} />
                                </div>
                              </details>
                            )}
                            <div className="flex flex-wrap gap-1">
                              {next.map((n) => {
                                const blocked = REQUIRES_APPROVAL.has(n) && ap.state !== "VALID";
                                return (
                                  <button key={n} name="status" value={n} disabled={blocked} title={blocked ? t("Requires approval first") : undefined} className="min-h-8 border border-line px-1.5 py-0.5 font-mono text-[10px] uppercase text-chrome hover:border-chrome disabled:opacity-40">
                                    → {enumLabel(t, n)}
                                  </button>
                                );
                              })}
                            </div>
                          </form>
                        )}
                      </Td>
                      <Td label={t("Listing and approval")}>
                        {ap.asset ? (
                          <Link href={`/content/${ap.asset.id}`} className="text-xs text-blue-bright hover:text-cyan">
                            {t("Listing draft")} · {enumLabel(t, ap.asset.status)}
                          </Link>
                        ) : (
                          <span className="text-xs text-muted">{t("No listing draft yet")}</span>
                        )}
                        <div className="mt-1">
                          {ap.state === "VALID" ? (
                            <Badge tone="ok">{t("Submission approved")}</Badge>
                          ) : ap.state === "RESET" ? (
                            <Badge tone="warn" title={t("The listing changed after it was approved, or the target went back.")}>
                              {t("Approval reset")}
                            </Badge>
                          ) : (
                            <Badge tone="muted">{t("Not approved")}</Badge>
                          )}
                        </div>
                        {can("content:write") && (dt.status === "QUALIFIED" || dt.status === "PREPARED") && (!ap.asset || ap.asset.status === "REJECTED") && (
                          <form action={prepareSubmissionAction} className="mt-2">
                            <HiddenBack path={`${back}#target-${dt.id}`} />
                            <input type="hidden" name="id" value={dt.id} />
                            <Button>{t("Prepare submission")}</Button>
                          </form>
                        )}
                        {can("distribution:approve") && dt.status === "PREPARED" && ap.state !== "VALID" && (
                          <form action={approveSubmissionAction} className="mt-2">
                            <HiddenBack path={`${back}#target-${dt.id}`} />
                            <input type="hidden" name="id" value={dt.id} />
                            <Button disabled={ap.blockers.length > 0} title={ap.blockers[0] ? t(ap.blockers[0]) : undefined}>
                              {t("Approve submission")}
                            </Button>
                            {ap.blockers[0] && <p className="mt-1 max-w-xs text-[11px] text-muted">{t(ap.blockers[0])}</p>}
                          </form>
                        )}
                      </Td>
                      <Td label={t("Tracking")}>
                        {dt.utmCampaign ? (
                          <>
                            <div className="num text-[11px] text-chrome">utm_campaign={dt.utmCampaign}</div>
                            {link ? <input readOnly value={link} aria-label={t("Tracking link")} className="mt-1 !min-h-0 w-full max-w-[16rem] !py-1 font-mono !text-[10px]" /> : <div className="text-[11px] text-muted">{t("Set the product domain to build the tracking link.")}</div>}
                          </>
                        ) : (
                          <div className="text-[11px] text-muted">{t("A UTM campaign is generated when the target is prepared.")}</div>
                        )}
                        <div className="mt-1 text-xs">
                          {!m || m.state === "NOT_CONNECTED" ? (
                            <span className="text-muted">{t("Not connected")}</span>
                          ) : m.state === "NO_DATA_YET" ? (
                            <span className="text-muted">{t("No data yet")}</span>
                          ) : (
                            <span className="num text-platinum">{t("{visits} visit(s) · {conversions} conversion(s)", { visits: formatValue(m.visits ?? 0, "count", undefined, intl), conversions: formatValue(m.conversions ?? 0, "count", undefined, intl) })}</span>
                          )}
                        </div>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </ResponsiveTable>
            <p className="border-t border-line px-4 py-2 text-[11px] text-muted">
              {t("Visits: tracker touches carrying the target's utm_campaign. Conversions: signups and subscriptions whose event or attributed visit carries it. Not connected without a tracker key; no data yet before the first visit. Correlation, not causation.")}
            </p>
            <div className="px-4 pb-3">
              <Pager path="/distribution" params={f} shown={data.rows.length} total={data.total} next={data.next} current={sp1(sp, "cursor")} />
            </div>
          </Panel>
        )}
        {can("distribution:write") && (
          <Panel title={t("Add target")}>
            <form action={addDistributionTargetAction} className="flex flex-col gap-3">
              <HiddenBack path={back} />
              <Field label={t("Name")}>
                <input name="name" required maxLength={120} />
              </Field>
              <Field label={t("Category")}>
                <select name="category" defaultValue="SOFTWARE_DIRECTORY">
                  {DISTRIBUTION_CATEGORIES.map((k) => (
                    <option key={k} value={k}>
                      {enumLabel(t, k)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("Kind")}>
                <select name="kind">
                  {DISTRIBUTION_KINDS.map((k) => (
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
              <Field label={t("Relevance (0 to 100)")}>
                <input name="relevance" type="number" min={0} max={100} placeholder="60" />
              </Field>
              <Field label={t("Requirements")}>
                <textarea name="requirements" className="min-h-16" maxLength={1000} />
              </Field>
              <Field label={t("Notes")}>
                <textarea name="notes" className="min-h-16" />
              </Field>
              <div>
                <Button>{t("Add")}</Button>
              </div>
            </form>
            <p className="mt-4 text-xs text-muted">{t("“Prepare submission” drafts the listing (directory description or outreach) in the Content studio; approve it there, then approve the submission here.")}</p>
          </Panel>
        )}
      </div>
    </>
  );
}
