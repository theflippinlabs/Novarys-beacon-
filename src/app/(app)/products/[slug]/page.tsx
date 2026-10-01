import { inSequence } from "@/db";
import Link from "next/link";
import { and, desc, eq, sql } from "drizzle-orm";
import { runProductAnalysisAction } from "@/app/actions/products";
import { Badge, Button, EmptyState, Flash, HiddenBack, KV, LinkButton, Meter, PageHeader, Panel, PotentialBadge, Stat, StatusBadge, Table, Td, Th } from "@/components/ui";
import { LineChart } from "@/components/charts/line-chart";
import { ProductTabs, RangePicker } from "@/components/shell/product-tabs";
import { experiments, jobs, opportunities } from "@/db/schema";
import { computeBeaconScore } from "@/core/score/beacon-score";
import { kpis, dailySeries } from "@/services/metrics";
import { scoreInput, scoreHistory } from "@/services/score";
import { latestAudit } from "@/services/seo";
import { promptSummaries } from "@/services/ai-visibility";
import { launchChecklist } from "@/services/onboarding";
import { metricSeries } from "@/services/visibility";
import { loadProductGraph } from "@/core/knowledge/load";
import { addDays, isoDay } from "@/core/util/text";
import { daysParam, pageData, productOr404, type SP } from "@/lib/page";
import { db } from "@/db";
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
    const score = computeBeaconScore(await scoreInput(tx, ctx.org.id, p.id));
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
    const analysis = await db().select().from(jobs).where(and(eq(jobs.organizationId, ctx.org.id), eq(jobs.type, "product.analyze"), sql`${jobs.payload}->>'productId' = ${p.id}`)).orderBy(desc(jobs.createdAt)).limit(1);
    return { p, g, score, k, series, history, audit, ai, checklist, opps, exps, clicks, impressions, qstats: qstats.rows, pstats: pstats.rows, analysis: analysis[0] ?? null, photos };
  });
  const { t } = await getI18n();
  const { p, score, k } = data;
  const base = `/products/${p.slug}`;
  const cov = Object.fromEntries(data.qstats.map((r) => [r.coverage, Number(r.n)]));
  const pages = Object.fromEntries(data.pstats.map((r) => [r.status, Number(r.n)]));

  return (
    <>
      <PageHeader
        eyebrow={t("Product · {category}", { category: p.category ?? t("category unknown") })}
        title={p.name}
        description={p.shortDescription ?? <span className="text-muted">{t("No short description yet — complete onboarding step 4.")}</span>}
        actions={
          <>
            <RangePicker base={base} days={days} />
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
        <Panel eyebrow={t("Beacon score")} title={t("Operational discoverability readiness")}>
          <div className="flex items-end gap-3">
            <div className="num text-6xl font-medium tracking-tighter text-platinum">{score.total}</div>
            <div className="pb-2 text-sm text-muted">/ 100</div>
          </div>
          <p className="mt-1 text-xs text-muted">{t("Transparent readiness score from observable facts. Not a ranking or traffic prediction.")}</p>
          <div className="mt-5 flex flex-col gap-3">
            {score.components.map((c) => (
              <details key={c.key} className="group">
                <summary className="flex cursor-pointer list-none flex-col gap-1">
                  <span className="flex justify-between text-xs text-chrome">
                    <span>{t(c.label)}</span>
                    <span className="text-muted group-open:text-gold">{t("details")}</span>
                  </span>
                  <Meter value={c.earned} max={c.max} label={t(c.label)} />
                </summary>
                <ul className="mt-2 flex flex-col gap-1.5 border-l border-line pl-3">
                  {c.lines.map((l) => (
                    <li key={l.label} className="text-[11px]">
                      <span className="num text-platinum">
                        {l.earned}/{l.max}
                      </span>{" "}
                      <span className="text-chrome">{t("{label}:", { label: t(l.label) })}</span> <span className="text-muted">{t(l.reason)}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
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
        </Panel>

        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label={t("Organic clicks")} value={k.discovery.organicClicks.now} prev={k.discovery.organicClicks.prev} source={t(k.discovery.organicClicks.source)} />
            <Stat label={t("Impressions")} value={k.discovery.organicImpressions.now} prev={k.discovery.organicImpressions.prev} source={t(k.discovery.organicImpressions.source)} />
            <Stat label={t("AI referrals")} value={k.discovery.aiReferrals.now} prev={k.discovery.aiReferrals.prev} source={t(k.discovery.aiReferrals.source)} />
            <Stat label={t("AI mentions (sampled)")} value={k.discovery.aiMentions.now} prev={k.discovery.aiMentions.prev} source={t(k.discovery.aiMentions.source)} />
            <Stat label={t("Visitors")} value={k.acquisition.visitors.now} prev={k.acquisition.visitors.prev} source={t(k.acquisition.visitors.source)} />
            <Stat label={t("Signups")} value={k.acquisition.signups.now} prev={k.acquisition.signups.prev} source={t(k.acquisition.signups.source)} />
            <Stat label={t("MRR")} value={k.revenue.mrr.now} fmt="money" currency={k.currency} source={t(k.revenue.mrr.source)} />
            <Stat label={t("Conversion rate")} value={k.revenue.conversionRate.now} prev={k.revenue.conversionRate.prev} fmt="percent" source={t(k.revenue.conversionRate.source)} />
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
              <EmptyState title={t("Search data not connected")} action={<LinkButton href={`${base}/onboarding?step=13`}>{t("Connect Search Console")}</LinkButton>}>
                {t("Beacon never estimates search traffic. Connect Search Console or Bing Webmaster to import measured impressions and clicks.")}
              </EmptyState>
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
              <EmptyState title={t("No first-party events yet")} action={<LinkButton href={`${base}/tracking`}>{t("Install tracker")}</LinkButton>}>
                {t("Install the Beacon tracker to measure visitors, CTA clicks and conversions.")}
              </EmptyState>
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
            <Table>
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
                    <Td className="max-w-xs">{a.prompt.prompt}</Td>
                    <Td className="num">{a.testsRun}</Td>
                    <Td className="num">{a.testsRun ? `${a.mentions}/${a.testsRun}` : "—"}</Td>
                    <Td className="text-xs">{a.competitors.join(", ") || "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <div className="p-4 text-sm text-muted">{t("No AI visibility prompts for this product.")}</div>
          )}
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Panel title={t("Launch checklist")} eyebrow={t("Readiness")} className="lg:col-span-2">
          <ul className="grid gap-2 sm:grid-cols-2">
            {data.checklist.map((c) => (
              <li key={c.label}>
                <Link href={c.href} className="flex items-center gap-3 border border-line px-3 py-2 text-sm hover:border-line-strong">
                  <span className={c.done ? "text-ok" : "text-muted"}>{c.done ? "✓" : "○"}</span>
                  <span className={c.done ? "text-chrome" : "text-platinum"}>{t(c.label)}</span>
                  {c.detail && <span className="num ml-auto text-xs text-muted">{t(c.detail)}</span>}
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
    </>
  );
}
