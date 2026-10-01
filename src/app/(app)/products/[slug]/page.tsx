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

export const metadata = { title: "Product" };

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
    const analysis = await db().select().from(jobs).where(and(eq(jobs.organizationId, ctx.org.id), eq(jobs.type, "product.analyze"), sql`${jobs.payload}->>'productId' = ${p.id}`)).orderBy(desc(jobs.createdAt)).limit(1);
    return { p, g, score, k, series, history, audit, ai, checklist, opps, exps, clicks, impressions, qstats: qstats.rows, pstats: pstats.rows, analysis: analysis[0] ?? null };
  });
  const { p, score, k } = data;
  const base = `/products/${p.slug}`;
  const cov = Object.fromEntries(data.qstats.map((r) => [r.coverage, Number(r.n)]));
  const pages = Object.fromEntries(data.pstats.map((r) => [r.status, Number(r.n)]));

  return (
    <>
      <PageHeader
        eyebrow={`Product · ${p.category ?? "category unknown"}`}
        title={p.name}
        description={p.shortDescription ?? <span className="text-muted">No short description yet — complete onboarding step 4.</span>}
        actions={
          <>
            <RangePicker base={base} days={days} />
            {can("job:run") && (
              <form action={runProductAnalysisAction}>
                <HiddenBack path={base} />
                <input type="hidden" name="productId" value={p.id} />
                <Button>Re-run analysis</Button>
              </form>
            )}
          </>
        }
      />
      <ProductTabs slug={p.slug} active="overview" />
      <Flash searchParams={sp} />
      {data.analysis && data.analysis.status !== "SUCCEEDED" && (
        <div className="mb-6 flex items-center gap-3 border border-gold-dim px-4 py-3 text-sm text-chrome">
          <StatusBadge status={data.analysis.status} /> Product analysis {data.analysis.status === "DEAD" ? `failed: ${data.analysis.lastError}` : "is queued or running in the background worker."}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[26rem_1fr]">
        <Panel eyebrow="Beacon score" title="Operational discoverability readiness">
          <div className="flex items-end gap-3">
            <div className="num text-6xl font-medium tracking-tighter text-platinum">{score.total}</div>
            <div className="pb-2 text-sm text-muted">/ 100</div>
          </div>
          <p className="mt-1 text-xs text-muted">Transparent readiness score from observable facts. Not a ranking or traffic prediction.</p>
          <div className="mt-5 flex flex-col gap-3">
            {score.components.map((c) => (
              <details key={c.key} className="group">
                <summary className="flex cursor-pointer list-none flex-col gap-1">
                  <span className="flex justify-between text-xs text-chrome">
                    <span>{c.label}</span>
                    <span className="text-muted group-open:text-gold">details</span>
                  </span>
                  <Meter value={c.earned} max={c.max} label={c.label} />
                </summary>
                <ul className="mt-2 flex flex-col gap-1.5 border-l border-line pl-3">
                  {c.lines.map((l) => (
                    <li key={l.label} className="text-[11px]">
                      <span className="num text-platinum">
                        {l.earned}/{l.max}
                      </span>{" "}
                      <span className="text-chrome">{l.label}:</span> <span className="text-muted">{l.reason}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </div>
          {score.pathTo.tasks.length > 0 && (
            <div className="mt-6 border-t border-line pt-4">
              <div className="eyebrow text-gold">Fastest path to {score.pathTo.target}</div>
              <ol className="mt-2 flex flex-col gap-2">
                {score.pathTo.tasks.map((t, i) => (
                  <li key={t.task} className="flex gap-3 text-xs">
                    <span className="num text-muted">{i + 1}.</span>
                    <span className="flex-1 text-chrome">{t.task}</span>
                    <span className="num text-ok">+{t.points}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </Panel>

        <div className="flex flex-col gap-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Stat label="Organic clicks" value={k.discovery.organicClicks.now} prev={k.discovery.organicClicks.prev} source={k.discovery.organicClicks.source} />
            <Stat label="Impressions" value={k.discovery.organicImpressions.now} prev={k.discovery.organicImpressions.prev} source={k.discovery.organicImpressions.source} />
            <Stat label="AI referrals" value={k.discovery.aiReferrals.now} prev={k.discovery.aiReferrals.prev} source={k.discovery.aiReferrals.source} />
            <Stat label="AI mentions (sampled)" value={k.discovery.aiMentions.now} prev={k.discovery.aiMentions.prev} source={k.discovery.aiMentions.source} />
            <Stat label="Visitors" value={k.acquisition.visitors.now} prev={k.acquisition.visitors.prev} source={k.acquisition.visitors.source} />
            <Stat label="Signups" value={k.acquisition.signups.now} prev={k.acquisition.signups.prev} source={k.acquisition.signups.source} />
            <Stat label="MRR" value={k.revenue.mrr.now} fmt="money" currency={k.currency} source={k.revenue.mrr.source} />
            <Stat label="Conversion rate" value={k.revenue.conversionRate.now} prev={k.revenue.conversionRate.prev} fmt="percent" source={k.revenue.conversionRate.source} />
          </div>
          <Panel title={`Search visibility · last ${days} days`} eyebrow="Visibility">
            {data.clicks.length ? (
              <LineChart
                title={`Organic clicks and impressions for ${p.name}`}
                series={[
                  { key: "impr", label: "Impressions", color: "var(--color-s1)", points: data.impressions.map((d) => ({ x: d.day, y: d.value })) },
                  { key: "clicks", label: "Clicks", color: "var(--color-s2)", points: data.clicks.map((d) => ({ x: d.day, y: d.value })) },
                ]}
              />
            ) : (
              <EmptyState title="Search data not connected" action={<LinkButton href={`${base}/onboarding?step=13`}>Connect Search Console</LinkButton>}>
                Beacon never estimates search traffic. Connect Search Console or Bing Webmaster to import measured impressions and clicks.
              </EmptyState>
            )}
          </Panel>
          <Panel title={`Visitors & signups · last ${days} days`} eyebrow="Acquisition">
            {k.acquisition.visitors.now !== null ? (
              <LineChart
                title={`Daily visitors and signups for ${p.name}`}
                series={[
                  { key: "v", label: "Visitors", color: "var(--color-s1)", points: data.series.map((d) => ({ x: d.day, y: d.visitors })) },
                  { key: "s", label: "Signups", color: "var(--color-s3)", points: data.series.map((d) => ({ x: d.day, y: d.signups })) },
                ]}
              />
            ) : (
              <EmptyState title="No first-party events yet" action={<LinkButton href={`${base}/tracking`}>Install tracker</LinkButton>}>
                Install the Beacon tracker to measure visitors, CTA clicks and conversions.
              </EmptyState>
            )}
          </Panel>
        </div>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Panel title="Queries" eyebrow="Coverage" actions={<Link className="eyebrow hover:text-chrome" href={`/queries?product=${p.slug}`}>Open →</Link>}>
          <KV items={[["Covered", cov.COVERED ?? 0], ["Partial", cov.PARTIAL ?? 0], ["Not covered", cov.NONE ?? 0], ["Active total", (cov.COVERED ?? 0) + (cov.PARTIAL ?? 0) + (cov.NONE ?? 0)]]} />
        </Panel>
        <Panel title="Pages" eyebrow="Discovery" actions={<Link className="eyebrow hover:text-chrome" href={`/discovery?product=${p.slug}`}>Open →</Link>}>
          <KV items={[["Planned", pages.PLANNED ?? 0], ["Draft / review", (pages.DRAFT ?? 0) + (pages.IN_REVIEW ?? 0)], ["Approved", pages.APPROVED ?? 0], ["Published", pages.PUBLISHED ?? 0]]} />
        </Panel>
        <Panel title="Technical" eyebrow="Latest audit" actions={data.audit && <Link className="eyebrow hover:text-chrome" href={`/discovery/audits/${data.audit.id}`}>Open →</Link>}>
          {data.audit ? (
            <KV items={[["Critical", data.audit.summary.CRITICAL ?? 0], ["High", data.audit.summary.HIGH ?? 0], ["Pages crawled", data.audit.pagesCrawled], ["Finished", data.audit.finishedAt?.toISOString().slice(0, 16).replace("T", " ")]]} />
          ) : (
            <p className="text-sm text-muted">No audit yet. Run one from Discovery.</p>
          )}
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Panel title="Top opportunities" eyebrow="Opportunity engine" pad={false} actions={<Link className="eyebrow hover:text-chrome" href={`/opportunities?product=${p.slug}`}>All →</Link>}>
          {data.opps.length ? (
            <ul>
              {data.opps.map((o) => (
                <li key={o.id} className="flex items-start justify-between gap-3 border-b border-line/60 px-4 py-3 last:border-0">
                  <div className="min-w-0">
                    <Link href={`/opportunities/${o.id}`} className="text-sm text-platinum hover:text-blue-bright">
                      {o.title}
                    </Link>
                    <div className="text-xs text-muted">{o.problem}</div>
                  </div>
                  <PotentialBadge potential={o.potential} />
                </li>
              ))}
            </ul>
          ) : (
            <div className="p-4 text-sm text-muted">No open opportunities. They are generated after analysis, audits and data syncs.</div>
          )}
        </Panel>
        <Panel title="AI observations" eyebrow="Sampled AI visibility" pad={false} actions={<Link className="eyebrow hover:text-chrome" href="/ai-visibility">Open →</Link>}>
          {data.ai.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>Prompt</Th>
                  <Th>Tests</Th>
                  <Th>Mentioned</Th>
                  <Th>Competitors seen</Th>
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
            <div className="p-4 text-sm text-muted">No AI visibility prompts for this product.</div>
          )}
        </Panel>
      </div>

      <div className="mt-6 grid gap-6 lg:grid-cols-3">
        <Panel title="Launch checklist" eyebrow="Readiness" className="lg:col-span-2">
          <ul className="grid gap-2 sm:grid-cols-2">
            {data.checklist.map((c) => (
              <li key={c.label}>
                <Link href={c.href} className="flex items-center gap-3 border border-line px-3 py-2 text-sm hover:border-line-strong">
                  <span className={c.done ? "text-ok" : "text-muted"}>{c.done ? "✓" : "○"}</span>
                  <span className={c.done ? "text-chrome" : "text-platinum"}>{c.label}</span>
                  {c.detail && <span className="num ml-auto text-xs text-muted">{c.detail}</span>}
                </Link>
              </li>
            ))}
          </ul>
        </Panel>
        <Panel title="Competitors & experiments" eyebrow="Context">
          <div className="eyebrow mb-2">Competitors</div>
          <div className="flex flex-wrap gap-1.5">
            {data.g.competitors.length ? data.g.competitors.map((c) => <Badge key={c.competitorId}>{c.competitor.name} · {c.comparisonFacts.filter((f) => f.sourceUrl).length} facts</Badge>) : <span className="text-sm text-muted">None recorded</span>}
          </div>
          <div className="eyebrow mb-2 mt-5">Experiments</div>
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
            <span className="text-sm text-muted">None</span>
          )}
          {data.history.length > 1 && (
            <>
              <div className="eyebrow mb-1 mt-5">Score history</div>
              <div className="num text-xs text-chrome">{data.history.map((h) => Math.round(h.total)).join(" → ")}</div>
            </>
          )}
        </Panel>
      </div>
    </>
  );
}
