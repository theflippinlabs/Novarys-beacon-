import Link from "next/link";
import type { Metadata } from "next";
import { captureBaselineAction, launchProductAction, setLaunchPlanAction } from "@/app/actions/launch";
import { Badge, Button, EmptyState, Field, Flash, HiddenBack, PageHeader, Panel, ResponsiveTable, Td, Th, formatValue } from "@/components/ui";
import { ProductTabs } from "@/components/shell/product-tabs";
import { launchChecklist, launchPhase, MONITORING_DAYS, openBlockers, type ChecklistItem, type LaunchPhase } from "@/core/launch/checklist";
import { launchFacts, launchMonitoring } from "@/services/launch";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";
import { pageData, productOr404, type SP } from "@/lib/page";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Launch") };
}

const PHASES: { key: LaunchPhase; label: string; hint: string }[] = [
  { key: "PRE_LAUNCH", label: "Pre-launch", hint: "Get the product, its site and its measurement ready." },
  { key: "LAUNCH_DAY", label: "Launch day", hint: "Publish the announcement and send the approved submissions." },
  { key: "POST_LAUNCH", label: "Post-launch", hint: "Watch what the launch changed during the first two weeks." },
];

export default async function LaunchPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SP> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { data, can } = await pageData(async (tx, ctx) => {
    const p = await productOr404(tx, ctx.org.id, slug);
    const facts = await launchFacts(tx, ctx.org.id, p.id);
    const monitoring = await launchMonitoring(tx, ctx.org.id, p.id);
    return { p, facts, monitoring };
  });
  const { t, intl } = await getI18n();
  const { p, facts, monitoring } = data;
  const items = launchChecklist(facts);
  const blockers = openBlockers(items);
  const phase = launchPhase({ launchMode: p.launchMode, launchDate: p.launchDate, launchedAt: p.launchedAt });
  const base = `/products/${p.slug}`;
  const back = `${base}/launch`;
  const canWrite = can("product:write");
  const done = items.filter((i) => i.status === "DONE").length;

  const statusBadge = (i: ChecklistItem) =>
    i.status === "DONE" ? <Badge tone="ok">✓ {t("Done")}</Badge> : i.status === "NOT_CONNECTED" ? <Badge tone="muted">{t("Not connected")}</Badge> : <Badge tone={i.blocking ? "warn" : "neutral"}>{t("To do")}</Badge>;

  return (
    <>
      <PageHeader
        eyebrow={t("Product · {category}", { category: p.category ?? t("category unknown") })}
        title={t("Launch · {name}", { name: p.name })}
        description={t("Launch mode turns the launch into a checklist derived from real state, then monitors the first {n} days. Nothing here is self-reported.", { n: MONITORING_DAYS })}
      />
      <ProductTabs slug={p.slug} active="launch" />
      <Flash searchParams={sp} />

      <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
        <div className="flex min-w-0 flex-col gap-6">
          {PHASES.map((ph) => {
            const list = items.filter((i) => i.phase === ph.key);
            return (
              <Panel key={ph.key} title={t(ph.label)} eyebrow={phase.phase === ph.key ? t("Current phase") : t("{done}/{n} done", { done: list.filter((i) => i.status === "DONE").length, n: list.length })} pad={false}>
                <p className="border-b border-line px-4 py-2 text-xs text-muted">{t(ph.hint)}</p>
                <ul>
                  {list.map((i) => (
                    <li key={i.key} id={`item-${i.key}`} className="flex flex-col gap-2 border-b border-line/60 px-4 py-3 last:border-0 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          {statusBadge(i)}
                          {i.blocking && i.status !== "DONE" && <Badge tone="warn">{t("Blocking")}</Badge>}
                          <span className="text-sm text-platinum">{t(i.label)}</span>
                        </div>
                        <p className="mt-1 break-words text-xs text-chrome">{t(i.evidence.text, i.evidence.params)}</p>
                      </div>
                      <Link href={i.href} className="eyebrow inline-flex min-h-10 shrink-0 items-center hover:text-chrome md:min-h-0">
                        {i.status === "DONE" ? t("Evidence →") : t("Fix →")}
                      </Link>
                    </li>
                  ))}
                </ul>
              </Panel>
            );
          })}

          <Panel title={t("Post-launch monitoring")} eyebrow={t("Daily deltas, first {n} days", { n: MONITORING_DAYS })} pad={false}>
            {!monitoring ? (
              <div className="p-4">
                <EmptyState
                  variant="not_generated"
                  what={t("Monitoring starts at launch.")}
                  why={t("Once the product is launched, this panel shows each day's search, analytics and conversion figures with the change from the day before, for {n} days.", { n: MONITORING_DAYS })}
                  action={{ label: t("Review the checklist"), href: `${back}#item-knowledge` }}
                />
              </div>
            ) : (
              <>
                <div className="flex flex-wrap gap-2 border-b border-line px-4 py-3">
                  {monitoring.series.map((s) => (
                    <span key={s.key} className="inline-flex items-center gap-1.5 text-xs text-chrome">
                      {t(s.label)}
                      {s.state === "OK" ? <Badge tone="ok">{t("Measured")}</Badge> : s.state === "NO_DATA_YET" ? <Badge tone="neutral">{t("No data yet")}</Badge> : <Badge tone="muted">{t("Not connected")}</Badge>}
                    </span>
                  ))}
                </div>
                <ResponsiveTable>
                  <thead>
                    <tr>
                      <Th>{t("Day")}</Th>
                      {monitoring.series.map((s) => (
                        <Th key={s.key} className="text-right">
                          {t(s.label)}
                        </Th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {monitoring.series[0].rows.map((r, idx) => (
                      <tr key={r.day}>
                        <Td primary className="num text-xs">
                          {t("Day {n}", { n: idx + 1 })} · {r.day}
                        </Td>
                        {monitoring.series.map((s) => {
                          const row = s.rows[idx];
                          return (
                            <Td key={s.key} label={t(s.label)} className="num text-right text-xs">
                              {s.state === "NOT_CONNECTED" ? (
                                <span className="text-muted">{t("Not connected")}</span>
                              ) : row.value === null ? (
                                <span className="text-muted">{t("No data yet")}</span>
                              ) : (
                                <span className="text-platinum">
                                  {formatValue(row.value, "count", undefined, intl)}
                                  {row.delta !== null && row.delta !== 0 && (
                                    <span className={row.delta > 0 ? "ml-1.5 text-ok" : "ml-1.5 text-crit"}>
                                      {row.delta > 0 ? "+" : ""}
                                      {formatValue(row.delta, "count", undefined, intl)}
                                    </span>
                                  )}
                                </span>
                              )}
                            </Td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </ResponsiveTable>
                {p.launchBaseline && (
                  <p className="border-t border-line px-4 py-2 text-[11px] text-muted">
                    {t("Baseline before launch: {q} active queries", { q: p.launchBaseline.activeQueries })}
                    {p.launchBaseline.search ? ` · ${t("{clicks} clicks and {impr} impressions over {days} days", { clicks: formatValue(p.launchBaseline.search.clicks, "count", undefined, intl), impr: formatValue(p.launchBaseline.search.impressions, "count", undefined, intl), days: p.launchBaseline.search.days })}` : ` · ${t("search: Not connected")}`}
                    {p.launchBaseline.visitorsPerDay !== null ? ` · ${t("{n} visitors per day", { n: p.launchBaseline.visitorsPerDay })}` : ` · ${t("tracker: no events")}`}
                  </p>
                )}
              </>
            )}
          </Panel>
        </div>

        <div className="flex flex-col gap-6">
          <Panel title={t("Launch mode")} eyebrow={t("{done}/{n} checklist items done", { done, n: items.length })}>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="eyebrow">{t("Mode")}</dt>
                <dd className="mt-0.5 text-platinum">{enumLabel(t, phase.mode)}</dd>
              </div>
              <div>
                <dt className="eyebrow">{t("Launch date")}</dt>
                <dd className="num mt-0.5 text-platinum">{p.launchDate ?? t("Not set")}</dd>
              </div>
              {phase.dayOfLaunch !== null && phase.dayOfLaunch >= 0 && (
                <div className="col-span-2">
                  <dt className="eyebrow">{t("Since launch")}</dt>
                  <dd className="mt-0.5 text-chrome">{phase.monitoring ? t("Day {n} of {total} of monitoring", { n: phase.dayOfLaunch + 1, total: MONITORING_DAYS }) : t("Monitoring window ended")}</dd>
                </div>
              )}
            </dl>
            {canWrite && !p.launchedAt && (
              <form action={setLaunchPlanAction} className="mt-4 flex flex-col gap-3 border-t border-line pt-4">
                <HiddenBack path={back} />
                <input type="hidden" name="productId" value={p.id} />
                <Field label={t("Planned launch date")}>
                  <input type="date" name="launchDate" defaultValue={p.launchDate ?? ""} />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button variant={p.launchMode === "OFF" ? "gold" : "ghost"} name="mode" value="PRE_LAUNCH">
                    {p.launchMode === "OFF" ? t("Start pre-launch") : t("Save date")}
                  </Button>
                  {p.launchMode !== "OFF" && (
                    <Button name="mode" value="OFF">
                      {t("Turn launch mode off")}
                    </Button>
                  )}
                </div>
              </form>
            )}
          </Panel>

          {canWrite && !p.launchedAt && (
            <Panel title={t("Launch product")} eyebrow={blockers.length ? t("{n} blocking item(s) open", { n: blockers.length }) : t("Ready to launch")}>
              {blockers.length > 0 && (
                <ul className="mb-3 flex flex-col gap-1 border-l border-warn/40 pl-3 text-xs text-warn">
                  {blockers.map((b) => (
                    <li key={b.key}>
                      <a href={`#item-${b.key}`} className="inline-flex min-h-10 items-center hover:underline md:min-h-0">
                        {t(b.label)}
                      </a>
                    </li>
                  ))}
                </ul>
              )}
              <form action={launchProductAction} className="flex flex-col gap-3">
                <HiddenBack path={back} />
                <input type="hidden" name="productId" value={p.id} />
                {blockers.length > 0 && (
                  <label className="flex min-h-10 items-center gap-2 text-xs text-chrome">
                    <input type="checkbox" name="force" />
                    {t("Launch anyway with open blocking items")}
                  </label>
                )}
                <p className="text-xs text-muted">{t("Launching records today as the launch date, captures the query baseline if it is missing and starts the {n}-day monitoring.", { n: MONITORING_DAYS })}</p>
                <div>
                  <Button variant="gold">{t("Launch product")}</Button>
                </div>
              </form>
            </Panel>
          )}

          <Panel title={t("Query baseline")} eyebrow={t("What post-launch deltas compare against")}>
            <div id="baseline" />
            {p.launchBaseline ? (
              <p className="text-sm text-chrome">{t("Captured {date}: {n} active queries.", { date: p.launchBaseline.capturedAt.slice(0, 10), n: p.launchBaseline.activeQueries })}</p>
            ) : (
              <p className="text-sm text-muted">{t("No baseline captured yet.")}</p>
            )}
            {canWrite && !p.launchedAt && (
              <form action={captureBaselineAction} className="mt-3">
                <HiddenBack path={`${back}#baseline`} />
                <input type="hidden" name="productId" value={p.id} />
                <Button>{p.launchBaseline ? t("Capture again") : t("Capture baseline")}</Button>
              </form>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
