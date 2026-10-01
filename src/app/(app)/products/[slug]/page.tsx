import { inSequence } from "@/db";
import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { deleteProductAction, runProductAnalysisAction } from "@/app/actions/products";
import { Badge, Button, EmptyState, Flash, HiddenBack, KV, LinkButton, Meter, PageHeader, Panel, PotentialBadge, Stat, StatusBadge, Td, Th, ResponsiveTable } from "@/components/ui";
import { LineChart } from "@/components/charts/line-chart";
import { ProductTabs, RangePicker } from "@/components/shell/product-tabs";
import { experiments, jobs, opportunities } from "@/db/schema";
import { kpis, dailySeries } from "@/services/metrics";
import { scoreHistory, storedScoreWithDiff } from "@/services/score";
import { recomputeScoreAction } from "@/app/actions/knowledge";
import { latestAudit } from "@/services/seo";
import { promptSummaries } from "@/services/ai-visibility";
import { launchChecklist, stepsOf } from "@/services/onboarding";
import { onboardingHref, resumeAt } from "@/core/onboarding/steps";
import { enumLabel } from "@/i18n/core";
import { metricSeries } from "@/services/visibility";
import { loadProductGraph } from "@/core/knowledge/load";
import { addDays, isoDay } from "@/core/util/text";
import { daysParam, pageData, productOr404, type SP } from "@/lib/page";
import { listMedia } from "@/services/media";
import { ProductPhotos } from "@/components/media/product-photos";
import { getI18n, getT } from "@/i18n/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Product") };
}

export default async function ProductDashboard({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SP> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const days = daysParam(sp);
  const { data, can } = await pageData(async (tx, ctx) => {
    const p = await productOr404(tx, ctx.org.id, slug);
    const g = (await loadProductGraph(tx, ctx.org.id, p.id))!;
    // The stored score is the single source of truth (same as the command center); recompute stores a new one.
    const stored = await storedScoreWithDiff(tx, ctx.org.id, p.id);
    const [k, series, history, audit, ai, checklist, opps, exps, clicks, impressions, qstats, pstats] = await inSequence([
      () => kpis(tx, ctx.org.id, { days, productId: p.id }),
      () => dailySeries(tx, ctx.org.id, days, p.id),
      () => scoreHistory(tx, ctx.org.id, p.id),
      () => latestAudit(tx, ctx.org.id, p.id),
      () => promptSummaries(tx, ctx.org.id, p.id),
      () => launchChecklist(tx, ctx.org.id, p.id),
      () => tx.select().from(opportunities).where(and(eq(opportunities.productId, p.id), eq(opportunities.status, "OPEN"))).orderBy(desc(opportunities.priorityScore)).limit(6),
      () => tx.select().from(experiments).where(eq(experiments.productId, p.id)).orderBy(desc(experiments.createdAt)).limit(5),
      () => metricSeries(tx, ctx.org.id, "search_clicks", isoDay(addDays(new Date(), -days)), { productId: p.id, dimension: "" }),
      () => metricSeries(tx, ctx.org.id, "search_impressions", isoDay(addDays(new Date(), -days)), { productId: p.id, dimension: "" }),
      () => tx.execute<{ coverage: string; n: number }>(sql`select coverage, count(*)::int as n from queries where product_id = ${p.id} and status = 'ACTIVE' group by coverage`),
      () => tx.execute<{ status: string; n: number }>(sql`select status, count(*)::int as n from pages where product_id = ${p.id} group by status`),
    ]);
    const photos = await listMedia(tx, ctx.org.id, { productId: p.id });
    const analysis = await tx.select().from(jobs).where(and(eq(jobs.organizationId, ctx.org.id), eq(jobs.type, "product.analyze"), sql`${jobs.payload}->>'productId' = ${p.id}`)).orderBy(desc(jobs.createdAt)).limit(1);
    return { p, g, stored, k, series, history, audit, ai, checklist, opps, exps, clicks, impressions, qstats: qstats.rows, pstats: pstats.rows, analysis: analysis[0] ?? null, photos };
  });
  const { t } = await getI18n();
  const { p, stored, k } = data;
  const score = stored?.score ?? null;
  const base = `/products/${p.slug}`;
  const cov = Object.fromEntries(data.qstats.map((r) => [r.coverage, Number(r.n)]));
  const pages = Object.fromEntries(data.pstats.map((r) => [r.status, Number(r.n)]));

  return (
    <>
      <PageHeader
        eyebrow={t("Product · {category}", { category: p.category ?? t("category unknown") })}
        title={p.name}
        description={p.shortDescription ?? <span className="text-muted">{t("No short description yet. Add it in onboarding, Product information.")}</span>}
        actions={
          <>
            <RangePicker base={base} days={days} />
            {can("product:write") && (
              <LinkButton variant="gold" href={p.onboardingCompletedAt ? `${base}/onboarding?step=product` : onboardingHref(p.slug, resumeAt(stepsOf(p)))}>
                {p.onboardingCompletedAt ? t("Edit product") : t("Continue editing →")}
              </LinkButton>
            )}
            {can("job:run") && (
              <form action={runProductAnalysisAction}>
                <HiddenBack path={base} />
                <input type="hidden" name="productId" value={p.id} />
                <Button>{t("Re-run analysis")}</Button>
              </form>
            )}
          </>
        }
      />
      <ProductTabs slug={p.slug} active="overview" />
      <Flash searchParams={sp} />
      {data.analysis && data.analysis.status !== "SUCCEEDED" && (
        <div className="mb-6 flex items-center gap-3 border border-gold-dim px-4 py-3 text-sm text-chrome">
          <StatusBadge status={data.analysis.status} /> {data.analysis.status === "DEAD" ? t("Product analysis failed: {error}", { error: String(data.analysis.lastError) }) : t("Product analysis is queued or running in the background worker.")}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[26rem_1fr]">
        <Panel
          eyebrow={t("Beacon score")}
          title={t("Operational discoverability readiness")}
          actions={
            can("job:run") && (
              <form action={recomputeScoreAction}>
                <HiddenBack path={base} />
                <input type="hidden" name="productId" value={p.id} />
                <Button>{t("Recompute")}</Button>
              </form>
            )
          }
        >
          {!score || !stored ? (
            <p className="text-sm text-muted">{t("Not computed yet. Recompute to store the first score; it is then refreshed daily.")}</p>
          ) : (
            <>
              <div className="flex items-end gap-3">
                <div className="num text-6xl font-medium tracking-tighter text-platinum">{score.total}</div>
                <div className="pb-2 text-sm text-muted">/ 100</div>
                {stored.diff.totalDelta !== null && stored.diff.totalDelta !== 0 && (
                  <div className={`num pb-2 text-sm ${stored.diff.totalDelta > 0 ? "text-ok" : "text-crit"}`}>
                    {stored.diff.totalDelta > 0 ? "+" : ""}
                    {stored.diff.totalDelta}
                  </div>
                )}
              </div>
              <p className="mt-1 text-xs text-muted">
                {t("Computed {date}.", { date: stored.computedAt.toISOString().slice(0, 16).replace("T", " ") })}{" "}
                {t("Measured coverage: {pct}% of the 100 points (unmeasurable lines are excluded and the score is rescaled).", { pct: Math.round(score.coverage * 100) })}
              </p>
              <p className="mt-1 text-xs text-muted">{t("Transparent readiness score from observable facts. Not a ranking or traffic prediction.")}</p>
              {score.notMeasured.length > 0 && (
                <ul className="mt-3 flex flex-col gap-1 border-l border-warn/40 pl-3">
                  {score.notMeasured.map((n) => (
                    <li key={`${n.component}:${n.label}`} className="text-[11px] text-warn">
                      {t("{label}:", { label: t(n.label) })} {t(n.reason)}
                    </li>
                  ))}
                </ul>
              )}
              <div className="mt-5 flex flex-col gap-3">
                {score.components.map((c) => (
                  <details key={c.key} className="group">
                    <summary className="flex cursor-pointer list-none flex-col gap-1">
                      <span className="flex justify-between gap-2 text-xs text-chrome">
                        <span>{t(c.label)}</span>
                        <span className="num text-muted group-open:text-gold">{c.max ? `${Math.round((c.earned / c.max) * 100)}%` : t("Not measured")}</span>
                      </span>
                      <Meter value={c.earned} max={c.max || 1} label={t(c.label)} />
                    </summary>
                    <ul className="mt-2 flex flex-col gap-1.5 border-l border-line pl-3">
                      {c.lines.map((l) => (
                        <li key={l.label} className="text-[11px]">
                          {l.measurable ? (
                            <span className="num text-platinum">
                              {l.earned}/{l.max}
                            </span>
                          ) : (
                            <span className="text-muted">{t("excluded")}</span>
                          )}{" "}
                          <span className="text-chrome">{t("{label}:", { label: t(l.label) })}</span> <span className="text-muted">{t(l.reason)}</span>
                        </li>
                      ))}
                      {c.missing > 0 && <li className="text-[11px] text-muted">{t("Missing points: {n}", { n: c.missing })}</li>}
                      {c.nextActions.slice(0, 3).map((a) => (
                        <li key={a} className="text-[11px] text-gold">
                          → {t(a)}
                        </li>
                      ))}
                    </ul>
                  </details>
                ))}
              </div>
              {stored.previousAt && (
                <div className="mt-6 border-t border-line pt-4">
                  <div className="eyebrow">{t("Since last computation ({date})", { date: stored.previousAt.toISOString().slice(0, 10) })}</div>
                  {stored.diff.lines.length ? (
                    <ul className="mt-2 flex flex-col gap-1">
                      {stored.diff.lines.map((d) => (
                        <li key={`${d.component}:${d.label}`} className="flex justify-between gap-3 text-[11px]">
                          <span className="text-chrome">
                            {t(d.component)} · {t(d.label)}
                            {d.measurableBefore !== null && d.measurableBefore !== d.measurableAfter ? ` (${d.measurableAfter ? t("now measured") : t("no longer measured")})` : ""}
                          </span>
                          <span className={`num ${d.delta > 0 ? "text-ok" : d.delta < 0 ? "text-crit" : "text-muted"}`}>
                            {d.delta > 0 ? "+" : ""}
                            {d.delta}
                          </span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="mt-2 text-[11px] text-muted">{t("No line changed.")}</p>
                  )}
                </div>
              )}
              {score.pathTo.tasks.length > 0 && (
                <div className="mt-6 border-t border-line pt-4">
                  <div className="eyebrow text-gold">{t("Fastest path to {target}", { target: score.pathTo.target })}</div>
                  <ol className="mt-2 flex flex-col gap-2">
                    {score.pathTo.tasks.map((task, i) => (
                      <li key={task.task} className="flex gap-3 text-xs">
                        <span className="num text-muted">{i + 1}.</span>
                        <span className="flex-1 text-chrome">{t(task.task)}</span>
                        <span className="num text-ok">+{task.points}</span>
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </>
          )}
        </Panel>

        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={t("Organic clicks")} kpi={k.discovery.organicClicks} />
            <Stat label={t("Impressions")} kpi={k.discovery.organicImpressions} />
            <Stat label={t("AI referrals")} kpi={k.discovery.aiReferrals} />
            <Stat label={t("AI mentions (sampled)")} kpi={k.discovery.aiMentions} />
            <Stat label={t("Visitors")} kpi={k.acquisition.visitors} />
            <Stat label={t("Signups")} kpi={k.acquisition.signups} />
            <Stat label={t("MRR")} kpi={k.revenue.mrr} fmt="money" />
            <Stat label={t("Conversion rate")} kpi={k.revenue.conversionRate} fmt="percent" />
          </div>
          <Panel title={t("Search visibility · last {days} days", { days })} eyebrow={t("Visibility")}>
            {data.clicks.length ? (
              <LineChart
                title={t("Organic clicks and impressions for {name}", { name: p.name })}
                series={[
                  { key: "impr", label: t("Impressions"), color: "var(--color-s1)", points: data.impressions.map((d) => ({ x: d.day, y: d.value })) },
                  { key: "clicks", label: t("Clicks"), color: "var(--color-s2)", points: data.clicks.map((d) => ({ x: d.day, y: d.value })) },
                ]}
              />
            ) : (
              <EmptyState
                variant={k.discovery.organicClicks.state === "NOT_CONNECTED" ? "not_connected" : "no_data_yet"}
                what={k.discovery.organicClicks.state === "NOT_CONNECTED" ? t("No Search Console data yet.") : t("Search data connected, no rows imported yet.")}
                why={k.discovery.organicClicks.state === "NOT_CONNECTED" ? t("Beacon never estimates search traffic. Connect Search Console or Bing Webmaster to import measured impressions and clicks.") : t("Data appears after the first sync and the history import complete.")}
                action={{ label: k.discovery.organicClicks.state === "NOT_CONNECTED" ? t("Connect Google Search Console") : t("Integration settings"), href: k.discovery.organicClicks.state === "NOT_CONNECTED" ? `${base}/onboarding?step=search` : "/settings/integrations" }}
              />
            )}
          </Panel>
          <Panel title={t("Visitors & signups · last {days} days", { days })} eyebrow={t("Acquisition")}>
            {k.acquisition.visitors.now !== null ? (
              <LineChart
                title={t("Daily visitors and signups for {name}", { name: p.name })}
                series={[
                  { key: "v", label: t("Visitors"), color: "var(--color-s1)", points: data.series.map((d) => ({ x: d.day, y: d.visitors })) },
                  { key: "s", label: t("Signups"), color: "var(--color-s3)", points: data.series.map((d) => ({ x: d.day, y: d.signups })) },
                ]}
              />
            ) : (
              <EmptyState
                variant={k.acquisition.visitors.state === "NOT_CONNECTED" ? "not_connected" : "no_data_yet"}
                what={t("No first-party events yet")}
                why={k.acquisition.visitors.state === "NOT_CONNECTED" ? t("Install the Beacon tracker to measure visitors, CTA clicks and conversions.") : t("A tracking key exists but no event has arrived yet. Check that the snippet is installed on the product site.")}
                action={{ label: t("Install tracker"), href: `${base}/tracking` }}
              />
            )}
          </Panel>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Panel title={t("Queries")} eyebrow={t("Coverage")} actions={<Link className="eyebrow hover:text-chrome" href={`/queries?product=${p.slug}`}>{t("Open →")}</Link>}>
          <KV items={[[t("Covered"), cov.COVERED ?? 0], [t("Partial"), cov.PARTIAL ?? 0], [t("Not covered"), cov.NONE ?? 0], [t("Active total"), (cov.COVERED ?? 0) + (cov.PARTIAL ?? 0) + (cov.NONE ?? 0)]]} />
        </Panel>
        <Panel title={t("Pages")} eyebrow={t("Discovery")} actions={<Link className="eyebrow hover:text-chrome" href={`/discovery?product=${p.slug}`}>{t("Open →")}</Link>}>
          <KV items={[[t("Planned"), pages.PLANNED ?? 0], [t("Draft / review"), (pages.DRAFT ?? 0) + (pages.IN_REVIEW ?? 0)], [t("Approved"), pages.APPROVED ?? 0], [t("Published"), pages.PUBLISHED ?? 0]]} />
        </Panel>
        <Panel title={t("Technical")} eyebrow={t("Latest audit")} actions={data.audit && <Link className="eyebrow hover:text-chrome" href={`/discovery/audits/${data.audit.id}`}>{t("Open →")}</Link>}>
          {data.audit ? (
            <KV items={[[t("Critical"), data.audit.summary.CRITICAL ?? 0], [t("High"), data.audit.summary.HIGH ?? 0], [t("Pages crawled"), data.audit.pagesCrawled], [t("Finished"), data.audit.finishedAt?.toISOString().slice(0, 16).replace("T", " ")]]} />
          ) : (
            <p className="text-sm text-muted">{t("No audit yet. Run one from Discovery.")}</p>
          )}
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel title={t("Top opportunities")} eyebrow={t("Opportunity engine")} pad={false} actions={<Link className="eyebrow hover:text-chrome" href={`/opportunities?product=${p.slug}`}>{t("All →")}</Link>}>
          {data.opps.length ? (
            <ul>
              {data.opps.map((o) => (
                <li key={o.id} className="flex items-start justify-between gap-3 border-b border-line/60 px-4 py-3 last:border-0">
                  <div className="min-w-0">
                    <Link href={`/opportunities/${o.id}`} className="text-sm text-platinum hover:text-blue-bright">
                      {t(o.title)}
                    </Link>
                    <div className="text-xs text-muted">{t(o.problem)}</div>
                  </div>
                  <PotentialBadge potential={o.potential} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-4 text-sm text-muted">{t("No open opportunities. They are generated after analysis, audits and data syncs.")}</div>
          )}
        </Panel>
        <Panel title={t("AI observations")} eyebrow={t("Sampled AI visibility")} pad={false} actions={<Link className="eyebrow hover:text-chrome" href="/ai-visibility">{t("Open →")}</Link>}>
          {data.ai.length ? (
            <ResponsiveTable>
              <thead>
                <tr>
                  <Th>{t("Prompt")}</Th>
                  <Th>{t("Tests")}</Th>
                  <Th>{t("Mentioned")}</Th>
                  <Th>{t("Competitors seen")}</Th>
                </tr>
              </thead>
              <tbody>
                {data.ai.slice(0, 6).map((a) => (
                  <tr key={a.prompt.id}>
                    <Td primary className="max-w-xs">{a.prompt.prompt}</Td>
                    <Td label={t("Tests")} className="num">{a.testsRun}</Td>
                    <Td label={t("Mentioned")} className="num">{a.testsRun ? `${a.mentions}/${a.testsRun}` : t("n/a")}</Td>
                    <Td label={t("Competitors seen")} className="text-xs">{a.competitors.join(", ") || t("None")}</Td>
                  </tr>
                ))}
              </tbody>
            </ResponsiveTable>
          ) : (
            <div className="p-4 text-sm text-muted">{t("No AI visibility prompts for this product.")}</div>
          )}
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Panel
          title={t("Launch checklist")}
          eyebrow={p.launchMode === "OFF" ? t("Readiness") : t("Launch mode: {mode}", { mode: enumLabel(t, p.launchMode) })}
          className="lg:col-span-2"
          actions={
            <Link className="eyebrow inline-flex min-h-10 items-center hover:text-chrome md:min-h-0" href={`${base}/launch`}>
              {t("Launch view →")}
            </Link>
          }
        >
          <ul className="grid gap-2 sm:grid-cols-2">
            {data.checklist
              .filter((c) => c.phase === "PRE_LAUNCH")
              .map((c) => (
                <li key={c.key}>
                  <Link href={c.href} className="flex min-h-10 items-center gap-3 border border-line px-3 py-2 text-sm hover:border-line-strong">
                    <span className={c.status === "DONE" ? "text-ok" : c.blocking ? "text-warn" : "text-muted"}>{c.status === "DONE" ? "✓" : "○"}</span>
                    <span className={c.status === "DONE" ? "text-chrome" : "text-platinum"}>{t(c.label)}</span>
                    {c.status === "NOT_CONNECTED" ? <span className="ml-auto text-[11px] text-muted">{t("Not connected")}</span> : c.blocking && c.status !== "DONE" ? <span className="ml-auto"><Badge tone="warn">{t("Blocking")}</Badge></span> : null}
                  </Link>
                </li>
              ))}
          </ul>
        </Panel>
        <Panel title={t("Competitors & experiments")} eyebrow={t("Context")}>
          <div className="eyebrow mb-2">{t("Competitors")}</div>
          <div className="flex flex-wrap gap-1.5">
            {data.g.competitors.length ? data.g.competitors.map((c) => <Badge key={c.competitorId}>{c.competitor.name} · {t("{n} facts", { n: c.comparisonFacts.filter((f) => f.sourceUrl).length })}</Badge>) : <span className="text-sm text-muted">{t("None recorded")}</span>}
          </div>
          <div className="eyebrow mb-2 mt-5">{t("Experiments")}</div>
          {data.exps.length ? (
            <ul className="flex flex-col gap-1.5">
              {data.exps.map((e) => (
                <li key={e.id} className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate text-chrome">{e.name}</span>
                  <StatusBadge status={e.status} />
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-sm text-muted">{t("None")}</span>
          )}
          {data.history.length > 1 && (
            <>
              <div className="eyebrow mb-1 mt-5">{t("Score history")}</div>
              <div className="num text-xs text-chrome">{data.history.map((h) => Math.round(h.total)).join(" → ")}</div>
            </>
          )}
        </Panel>
      </div>

      <ProductPhotos product={p} photos={data.photos} canEdit={can("product:write")} back={`${base}#photos`} />

      {can("product:delete") && (
        <section id="delete" className="mt-6 border border-crit/40 bg-crit/5 p-4">
          <div className="eyebrow text-crit">{t("Danger zone")}</div>
          <h2 className="mt-1 text-sm font-medium text-platinum">{t("Delete this product")}</h2>
          <p className="mt-2 max-w-2xl text-sm text-chrome">
            {t("This permanently removes the product and everything attached to it: knowledge graph, queries, planned pages, content, audits, opportunities and scores. Uploaded photos and revenue history are kept. This cannot be undone.")}
          </p>
          <form action={deleteProductAction} className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
            <HiddenBack path={`${base}#delete`} />
            <input type="hidden" name="productId" value={p.id} />
            <label className="flex min-w-0 flex-1 flex-col gap-1.5">
              <span className="eyebrow text-chrome">{t("Type “{name}” to confirm", { name: p.name })}</span>
              <input name="confirm" autoComplete="off" required placeholder={p.name} />
            </label>
            <Button variant="danger">{t("Delete product")}</Button>
          </form>
        </section>
      )}
    </>
  );
}
