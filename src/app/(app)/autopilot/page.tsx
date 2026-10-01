import { and, desc, eq, sql } from "drizzle-orm";
import type { Metadata } from "next";
import { addCrossSellRuleAction, addExperimentAction, decideRecommendationAction, runReportAction, setExperimentStatusAction, toggleCrossSellRuleAction } from "@/app/actions/growth";
import { Badge, Button, EmptyState, Field, Flash, HiddenBack, PageHeader, Panel, StatusBadge, Table, Td, Th, formatValue } from "@/components/ui";
import { crossSellRules, experiments, growthReports, products, recommendations } from "@/db/schema";
import type { GrowthAnalysis } from "@/core/autopilot/analyst";
import { loadProductGraph } from "@/core/knowledge/load";
import { recommendProducts } from "@/core/sales/recommend";
import { pageData, sp1, type SP } from "@/lib/page";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Autopilot") };
}

export default async function AutopilotPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { t, intl, locale } = await getI18n();
  const need = sp1(sp, "need")?.slice(0, 500);
  const { data, can } = await pageData(async (tx, ctx) => {
    const org = ctx.org.id;
    const report = await tx.query.growthReports.findFirst({ where: eq(growthReports.organizationId, org), orderBy: desc(growthReports.createdAt) });
    const recs = await tx.select().from(recommendations).where(and(eq(recommendations.organizationId, org), eq(recommendations.status, "PROPOSED"))).orderBy(desc(recommendations.createdAt)).limit(30);
    const exps = await tx.select().from(experiments).where(eq(experiments.organizationId, org)).orderBy(desc(experiments.updatedAt));
    const prods = await tx.select().from(products).where(eq(products.organizationId, org)).orderBy(products.name);
    const rules = await tx.select().from(crossSellRules).where(eq(crossSellRules.organizationId, org));
    const ruleStats = await tx.execute<{ rule_id: string; imp: number; clk: number; conv: number; rev: number }>(sql`
      select rule_id, count(*) filter (where type = 'IMPRESSION')::int as imp, count(*) filter (where type = 'CLICK')::int as clk,
        count(*) filter (where type = 'CONVERSION')::int as conv, coalesce(sum(revenue_cents), 0)::bigint as rev
      from cross_sell_events where organization_id = ${org} group by rule_id`);
    let recommendation = null;
    if (need) {
      const graphs = [];
      for (const p of prods) {
        const g = await loadProductGraph(tx, org, p.id);
        if (g) graphs.push(g);
      }
      recommendation = recommendProducts(need, graphs, { complementaryPairs: new Set(rules.map((r) => `${r.sourceProductId}:${r.destinationProductId}`)) });
    }
    return { report, recs, exps, prods, rules, ruleStats: new Map(ruleStats.rows.map((r) => [r.rule_id, r])), recommendation };
  });
  const back = "/autopilot";
  const s = data.report?.sections as GrowthAnalysis | undefined;
  const pname = (id: string) => data.prods.find((p) => p.id === id)?.name ?? "—";
  /** Enum value in lower case (English output keeps the raw value when `raw` is set). */
  const lower = (v: string, raw = false) => (locale === "en" && raw ? v : enumLabel(t, v).toLocaleLowerCase(intl));
  const recBody = (body: string) => {
    const m = /^From opportunity \((\w+), (\w+) potential\)\.$/.exec(body);
    return m ? t("From opportunity ({type}, {potential} potential).", { type: lower(m[1], true), potential: lower(m[2], true) }) : t(body);
  };
  const matchLabel = (kind: string) => enumLabel(t, kind).toLocaleLowerCase(intl);

  return (
    <>
      <PageHeader
        eyebrow={t("12 / Autopilot")}
        title={t("Growth autopilot")}
        description={t("A deterministic growth analyst: measured changes, coinciding events (correlation — not proven causation), prioritised actions, content to create, technical issues, experiments and signals to monitor. Anything touching production content, external accounts or paid campaigns needs approval.")}
        actions={
          can("job:run") && (
            <form action={runReportAction} className="flex items-center gap-2">
              <HiddenBack path={back} />
              <select name="days" defaultValue="7" aria-label={t("Period")} className="!w-24">
                <option value="7">{t("7 days")}</option>
                <option value="28">{t("28 days")}</option>
              </select>
              <Button variant="gold">{t("Analyse now")}</Button>
            </form>
          )
        }
      />
      <Flash searchParams={sp} />

      {!s ? (
        <EmptyState title={t("No growth report yet")}>{t("The analyst runs weekly via the scheduler, or on demand. It only reports on connected, measured data.")}</EmptyState>
      ) : (
        <div className="grid gap-6 xl:grid-cols-2">
          <Panel title={`${data.report!.periodStart} → ${data.report!.periodEnd}`} eyebrow={t("What happened")}>
            {s.whatHappened.length ? (
              <Table>
                <tbody>
                  {s.whatHappened.map((w) => (
                    <tr key={w.metric}>
                      <Td className="text-platinum">{t(w.metric)}</Td>
                      <Td className="num">{w.unit === "cents" ? `${formatValue(w.prev, "money", undefined, intl)} → ${formatValue(w.now, "money", undefined, intl)}` : `${formatValue(w.prev, "count", undefined, intl)} → ${formatValue(w.now, "count", undefined, intl)}`}</Td>
                      <Td className={`num ${w.direction === "up" ? "text-ok" : w.direction === "down" ? "text-crit" : "text-muted"}`}>{w.change === null ? t("new") : t("{sign} {pct}%", { sign: w.change > 0 ? "▲" : w.change < 0 ? "▼" : "±", pct: Math.abs(Math.round(w.change * 100)) })}</Td>
                      <Td className="text-[11px] text-muted">{t(w.source)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="text-sm text-muted">{t("No comparable measured metrics in this period.")}</p>
            )}
            <div className="eyebrow mb-2 mt-5">{t("Why it may have happened")}</div>
            <ul className="flex flex-col gap-2">
              {s.whyItMayHaveHappened.map((w, i) => (
                <li key={i} className="text-sm">
                  <Badge tone={w.evidence === "CORRELATION" ? "warn" : "muted"}>{enumLabel(t, w.evidence)}</Badge> <span className="text-chrome">{t(w.observation)}</span>
                  {w.relatedEvents.length > 0 && <div className="mt-1 text-xs text-muted">{t("Coinciding: {events}", { events: w.relatedEvents.map((e) => t(e)).join("; ") })}</div>}
                </li>
              ))}
              {!s.whyItMayHaveHappened.length && <li className="text-sm text-muted">{t("No significant changes to explain.")}</li>}
            </ul>
            <p className="mt-4 text-[11px] text-muted">{t(s.disclaimer)}</p>
          </Panel>
          <Panel title={t("Actions & signals")} eyebrow={t("Recommended")}>
            <div className="eyebrow mb-2">{t("Content to create")}</div>
            <ul className="mb-4 flex flex-col gap-1 text-sm text-chrome">{s.contentToCreate.length ? s.contentToCreate.map((c) => <li key={c}>○ {t(c)}</li>) : <li className="text-muted">—</li>}</ul>
            <div className="eyebrow mb-2">{t("Technical issues")}</div>
            <ul className="mb-4 flex flex-col gap-1 text-sm text-chrome">{s.technicalIssues.length ? s.technicalIssues.map((c) => <li key={c}>✕ {c}</li>) : <li className="text-muted">{t("No open critical issues.")}</li>}</ul>
            <div className="eyebrow mb-2">{t("Experiments proposed")}</div>
            <ul className="mb-4 flex flex-col gap-2 text-sm">
              {s.experiments.length ? (
                s.experiments.map((e) => (
                  <li key={e.name}>
                    <div className="text-platinum">{t(e.name)}</div>
                    <div className="text-xs text-muted">
                      {t(e.hypothesis)} · {t("Monitor: {signal}", { signal: t(e.signalToMonitor) })}
                    </div>
                  </li>
                ))
              ) : (
                <li className="text-muted">—</li>
              )}
            </ul>
            <div className="eyebrow mb-2">{t("Expected signals to monitor")}</div>
            <ul className="mb-4 flex flex-col gap-1 text-xs text-chrome">
              {s.signalsToMonitor.map((x) => {
                const w = s.whatHappened.find((m) => `${m.metric} (${m.source})` === x);
                return <li key={x}>• {w ? `${t(w.metric)} (${t(w.source)})` : t(x)}</li>;
              })}
            </ul>
            <div className="eyebrow mb-2">{t("Data coverage")}</div>
            <p className="text-xs text-chrome">
              {t("Connected:")} {s.dataCoverage.connected.join(", ") || t("none")} · {t("Missing:")} <span className="text-warn">{s.dataCoverage.missing.join(", ") || t("none")}</span>
            </p>
          </Panel>
        </div>
      )}

      <Panel title={t("{n} recommendation(s) awaiting a decision", { n: data.recs.length })} eyebrow={t("Approval queue")} className="mt-6" pad={false}>
        {data.recs.length ? (
          <Table>
            <tbody>
              {data.recs.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <Badge tone="muted">{enumLabel(t, r.kind)}</Badge>
                  </Td>
                  <Td className="text-platinum">
                    {t(r.title)}
                    <div className="text-xs text-muted">{recBody(r.body)}</div>
                  </Td>
                  <Td>{r.requiresApproval ? <Badge tone="gold">{t("requires approval")}</Badge> : <Badge tone="muted">{t("informational")}</Badge>}</Td>
                  <Td>
                    {can("recommendation:decide") && (
                      <form action={decideRecommendationAction} className="flex gap-2">
                        <HiddenBack path={back} />
                        <input type="hidden" name="id" value={r.id} />
                        <Button name="status" value="APPROVED">
                          {t("Approve")}
                        </Button>
                        <Button name="status" value="REJECTED" variant="danger">
                          {t("Reject")}
                        </Button>
                      </form>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="p-4 text-sm text-muted">{t("Nothing to decide.")}</p>
        )}
      </Panel>

      <div id="experiments" className="mt-6 grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel title={t("Experiments")} eyebrow={t("Hypothesis → signal → result")} pad={false}>
          {data.exps.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>{t("Experiment")}</Th>
                  <Th>{t("Metric")}</Th>
                  <Th>{t("Status")}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data.exps.map((e) => (
                  <tr key={e.id}>
                    <Td>
                      <div className="text-platinum">{e.name}</div>
                      <div className="text-xs text-muted">{e.hypothesis}</div>
                      {e.result && <div className="mt-1 text-xs text-chrome">{t("Result: {result}", { result: e.result })}</div>}
                    </Td>
                    <Td className="text-xs">
                      {e.primaryMetric}
                      {e.signalToMonitor && <div className="text-muted">{e.signalToMonitor}</div>}
                    </Td>
                    <Td>
                      <StatusBadge status={e.status} />
                      <div className="num mt-1 text-[10px] text-muted">
                        {e.startsOn ?? ""} {e.endsOn ? `→ ${e.endsOn}` : ""}
                      </div>
                    </Td>
                    <Td>
                      {can("growth:write") && !["CONCLUDED", "ABANDONED"].includes(e.status) && (
                        <form action={setExperimentStatusAction} className="flex flex-col gap-1">
                          <HiddenBack path={back} />
                          <input type="hidden" name="id" value={e.id} />
                          {e.status === "DRAFT" && (
                            <Button name="status" value="RUNNING">
                              {t("Start")}
                            </Button>
                          )}
                          {e.status === "RUNNING" && (
                            <Button name="status" value="READY_FOR_REVIEW">
                              {t("Ready for review")}
                            </Button>
                          )}
                          {e.status === "READY_FOR_REVIEW" && (
                            <>
                              <input name="result" placeholder={t("Observed result")} aria-label={t("Result")} />
                              <Button name="status" value="CONCLUDED">
                                {t("Conclude")}
                              </Button>
                            </>
                          )}
                          <button name="status" value="ABANDONED" className="eyebrow text-left hover:text-crit">
                            {t("abandon")}
                          </button>
                        </form>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="p-4 text-sm text-muted">{t("No experiments yet.")}</p>
          )}
        </Panel>
        {can("growth:write") && (
          <Panel title={t("New experiment")}>
            <form action={addExperimentAction} className="flex flex-col gap-3">
              <HiddenBack path={back} />
              <Field label={t("Name")}>
                <input name="name" required maxLength={160} />
              </Field>
              <Field label={t("Hypothesis")}>
                <textarea name="hypothesis" required minLength={10} className="min-h-16" />
              </Field>
              <Field label={t("Primary metric")}>
                <input name="primaryMetric" required placeholder={t("CTA click rate")} />
              </Field>
              <Field label={t("Signal to monitor")}>
                <input name="signalToMonitor" placeholder={t("CTA_CLICK / PAGE_VIEW over 28 days")} />
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
              <div>
                <Button>{t("Create")}</Button>
              </div>
            </form>
          </Panel>
        )}
      </div>

      <div id="cross-sell" className="mt-6 grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel title={t("Cross-sell rules")} eyebrow={t("Ecosystem recommendations · consent-gated · frequency-capped")} pad={false}>
          {data.rules.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>{t("Rule")}</Th>
                  <Th>{t("From → to")}</Th>
                  <Th>{t("Conditions")}</Th>
                  <Th>{t("Impr.")}</Th>
                  <Th>{t("Clicks")}</Th>
                  <Th>{t("Conv.")}</Th>
                  <Th>{t("Revenue")}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data.rules.map((r) => {
                  const st = data.ruleStats.get(r.id);
                  return (
                    <tr key={r.id}>
                      <Td>
                        <div className="text-platinum">{r.name}</div>
                        <div className="text-xs text-muted">{r.message}</div>
                      </Td>
                      <Td className="text-xs">
                        {pname(r.sourceProductId)} → {pname(r.destinationProductId)}
                      </Td>
                      <Td className="text-[11px]">
                        {r.conditions.requiredTraits?.length ? t("traits: {traits}", { traits: r.conditions.requiredTraits.join(", ") }) : t("any")}
                        {r.conditions.minDaysOnSource ? ` · ≥${t("{n}d", { n: r.conditions.minDaysOnSource })}` : ""}
                        <div className="text-muted">{t("cap 1/{days}d · max {max}", { days: r.frequencyCapDays, max: r.maxImpressions })}</div>
                      </Td>
                      <Td className="num">{Number(st?.imp ?? 0)}</Td>
                      <Td className="num">{Number(st?.clk ?? 0)}</Td>
                      <Td className="num">{Number(st?.conv ?? 0)}</Td>
                      <Td className="num">{formatValue(Number(st?.rev ?? 0), "money", undefined, intl)}</Td>
                      <Td>
                        {can("growth:write") && (
                          <form action={toggleCrossSellRuleAction}>
                            <HiddenBack path={back} />
                            <input type="hidden" name="id" value={r.id} />
                            {!r.active && <input type="hidden" name="active" value="on" />}
                            <button className="eyebrow hover:text-chrome">{r.active ? t("pause") : t("activate")}</button>
                          </form>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          ) : (
            <p className="p-4 text-sm text-muted">{t("No cross-sell rules. Recommendations are only shown to identities that consented to cross-product recommendations.")}</p>
          )}
        </Panel>
        {can("growth:write") && data.prods.length > 1 && (
          <Panel title={t("New cross-sell rule")}>
            <form action={addCrossSellRuleAction} className="flex flex-col gap-3">
              <HiddenBack path={back} />
              <Field label={t("Name")}>
                <input name="name" required maxLength={120} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label={t("From")}>
                  <select name="sourceProductId">
                    {data.prods.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("To")}>
                  <select name="destinationProductId" defaultValue={data.prods[1]?.id}>
                    {data.prods.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label={t("Required shared traits")} hint={t("Comma separated, e.g. agency, team_size:10-50")}>
                <input name="requiredTraits" />
              </Field>
              <Field label={t("Min. days on source product")}>
                <input name="minDaysOnSource" type="number" min={0} defaultValue={7} />
              </Field>
              <Field label={t("Message (contextual, factual)")}>
                <textarea name="message" required minLength={10} maxLength={280} className="min-h-16" />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label={t("CTA label")}>
                  <input name="ctaLabel" required defaultValue="Learn more" />
                </Field>
                <Field label={t("Cap (days)")}>
                  <input name="frequencyCapDays" type="number" min={1} defaultValue={14} />
                </Field>
              </div>
              <Field label={t("CTA URL (destination domain)")}>
                <input name="ctaUrl" type="url" required />
              </Field>
              <Field label={t("Max impressions")}>
                <input name="maxImpressions" type="number" min={1} max={20} defaultValue={3} />
              </Field>
              <div>
                <Button>{t("Create rule")}</Button>
              </div>
            </form>
          </Panel>
        )}
      </div>

      <Panel title={t("AI sales agent — test a visitor need")} eyebrow={t("Explainable product recommendation")} className="mt-6">
        <form method="get" action="/autopilot#sales" className="flex flex-col gap-3 md:flex-row" id="sales">
          <input name="need" defaultValue={need ?? ""} placeholder={t("I run a TikTok agency with 30 creators.")} aria-label={t("Visitor need")} />
          <Button>{t("Recommend")}</Button>
        </form>
        {data.recommendation && (
          <div className="mt-5">
            {data.recommendation.primary ? (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="border border-gold-dim p-4">
                  <div className="eyebrow text-gold">{data.recommendation.primary.fit === "STRONG" ? t("Primary recommendation · STRONG fit") : t("Primary recommendation · PARTIAL fit")}</div>
                  <div className="mt-1 text-lg text-platinum">{data.recommendation.primary.productName}</div>
                  <p className="mt-1 text-sm text-chrome">
                    {t("{product} matches on {matches}.", {
                      product: data.recommendation.primary.productName,
                      matches: data.recommendation.primary.why.map((w) => t('{kind} "{fact}"', { kind: matchLabel(w.kind), fact: w.fact })).join(", "),
                    })}
                  </p>
                  <div className="eyebrow mb-1 mt-3">{t("Why it matches")}</div>
                  <ul className="text-xs text-chrome">
                    {data.recommendation.primary.why.map((w) => (
                      <li key={w.kind + w.fact}>
                        {t("• {kind}: {fact}", { kind: matchLabel(w.kind), fact: w.fact })} <span className="text-muted">({w.matchedTerms.join(", ")})</span>
                      </li>
                    ))}
                  </ul>
                  <div className="eyebrow mb-1 mt-3">{t("Relevant features")}</div>
                  <p className="text-xs text-chrome">{data.recommendation.primary.relevantFeatures.join(", ") || "—"}</p>
                  <div className="eyebrow mb-1 mt-3">{t("Pricing (verified)")}</div>
                  <p className="text-xs text-chrome">{data.recommendation.primary.pricing.map((x) => t(x)).join(" · ") || t("No verified pricing recorded")}</p>
                  {data.recommendation.primary.cta && <div className="mt-3 text-xs text-gold-bright">{t("CTA: {label} → {url}", { label: data.recommendation.primary.cta.label, url: data.recommendation.primary.cta.url })}</div>}
                </div>
                <div className="border border-line p-4">
                  <div className="eyebrow">{t("Complementary products")}</div>
                  {data.recommendation.complementary.length ? (
                    data.recommendation.complementary.map((c) => (
                      <div key={c.productId} className="mt-2 text-sm text-chrome">
                        {c.productName} <span className="text-xs text-muted">— {c.why.map((w) => w.fact).join(", ")}</span>
                      </div>
                    ))
                  ) : (
                    <p className="mt-2 text-sm text-muted">{t("None match this need.")}</p>
                  )}
                  <p className="mt-4 text-[11px] text-muted">{t("Considered {n} product(s). Ownership never boosts a score; unmatched products are not recommended.", { n: data.recommendation.considered })}</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-chrome">{t(data.recommendation.explanation)}</p>
            )}
          </div>
        )}
      </Panel>
    </>
  );
}
