import { desc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { addCrossSellRuleAction, addExperimentAction, addRelationshipAction, removeRelationshipAction, runReportAction, toggleCrossSellRuleAction } from "@/app/actions/growth";
import { AutopilotLoop } from "./loop";
import { Experiments } from "./experiments";
import { listRelationships, RELATIONSHIP_TYPES, ruleFunnels } from "@/services/ecosystem";
import { Badge, Button, EmptyState, Field, Flash, HiddenBack, PageHeader, Panel, Table, Td, Th, formatValue } from "@/components/ui";
import { crossSellRules, growthReports, products } from "@/db/schema";
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
  const { t, intl } = await getI18n();
  const need = sp1(sp, "need")?.slice(0, 500);
  const { data, can, ctx } = await pageData(async (tx, ctx) => {
    const org = ctx.org.id;
    const report = await tx.query.growthReports.findFirst({ where: eq(growthReports.organizationId, org), orderBy: desc(growthReports.createdAt) });
    const prods = await tx.select().from(products).where(eq(products.organizationId, org)).orderBy(products.name);
    const rules = await tx.select().from(crossSellRules).where(eq(crossSellRules.organizationId, org));
    const ruleStats = await ruleFunnels(tx, org);
    const relationships = await listRelationships(tx, org);
    let recommendation = null;
    if (need) {
      const graphs = [];
      for (const p of prods) {
        const g = await loadProductGraph(tx, org, p.id);
        if (g) graphs.push(g);
      }
      recommendation = recommendProducts(need, graphs, { complementaryPairs: new Set(rules.map((r) => `${r.sourceProductId}:${r.destinationProductId}`)) });
    }
    return { report, prods, rules, ruleStats, relationships, recommendation };
  });
  const back = "/autopilot";
  const s = data.report?.sections as GrowthAnalysis | undefined;
  const pname = (id: string) => data.prods.find((p) => p.id === id)?.name ?? t("n/a");
  const rel = (id: string | null) => (id ? data.relationships.find((x) => x.id === id) : undefined);
  const matchLabel = (kind: string) => enumLabel(t, kind).toLocaleLowerCase(intl);

  return (
    <>
      <PageHeader
        eyebrow={t("12 / Autopilot")}
        title={t("Growth autopilot")}
        description={t("A deterministic growth analyst: measured changes, coinciding events (correlation, not proven causation), prioritised actions, content to create, technical issues, experiments and signals to monitor. Anything touching production content, external accounts or paid campaigns needs approval.")}
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
        <EmptyState
          variant="not_generated"
          what={t("No growth report yet")}
          why={t("The analyst runs weekly via the scheduler, or on demand. It only reports on connected, measured data.")}
          action={can("job:run") ? { label: t("Analyse now"), form: { action: runReportAction, fields: { days: "7" }, back } } : { label: t("Open the overview"), href: "/" }}
        />
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
                  <Badge tone={w.evidence === "CORRELATION" ? "warn" : "muted"}>{enumLabel(t, w.evidence)}</Badge> {w.product && <Badge tone="muted">{w.product}</Badge>} <span className="text-chrome">{t(w.observation)}</span>
                  {w.relatedEvents.length > 0 && <div className="mt-1 text-xs text-muted">{t("Coinciding: {events}", { events: w.relatedEvents.map((e) => t(e)).join("; ") })}</div>}
                </li>
              ))}
              {!s.whyItMayHaveHappened.length && <li className="text-sm text-muted">{t("No significant changes to explain.")}</li>}
            </ul>
            <p className="mt-4 text-[11px] text-muted">{t(s.disclaimer)}</p>
          </Panel>
          <Panel title={t("Actions & signals")} eyebrow={t("Recommended")}>
            <div className="eyebrow mb-2">{t("Content to create")}</div>
            <ul className="mb-4 flex flex-col gap-1 text-sm text-chrome">{s.contentToCreate.length ? s.contentToCreate.map((c) => <li key={c}>○ {t(c)}</li>) : <li className="text-muted">{t("None")}</li>}</ul>
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
                    {can("growth:write") && (
                      <form action={addExperimentAction} className="mt-1">
                        <HiddenBack path={`${back}#experiments`} />
                        <input type="hidden" name="name" value={e.name.slice(0, 160)} />
                        <input type="hidden" name="hypothesis" value={e.hypothesis} />
                        <input type="hidden" name="primaryMetric" value={e.primaryMetric} />
                        <input type="hidden" name="signalToMonitor" value={e.signalToMonitor.slice(0, 300)} />
                        {e.primaryMetric === "CTA click rate" && <input type="hidden" name="metricKey" value="CTA_CLICK" />}
                        <button className="eyebrow text-blue-bright hover:text-cyan">{t("Create experiment")}</button>
                      </form>
                    )}
                  </li>
                ))
              ) : (
                <li className="text-muted">{t("None")}</li>
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

      <AutopilotLoop orgId={ctx.org.id} canDecide={can("recommendation:decide")} back={back} />

      <Experiments orgId={ctx.org.id} canWrite={can("growth:write")} back={back} />

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
                  <Th>{t("Signups")}</Th>
                  <Th>{t("Subs")}</Th>
                  <Th>{t("Measured revenue")}</Th>
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
                        {rel(r.relationshipId) && <Badge tone="muted">{enumLabel(t, rel(r.relationshipId)!.type)}</Badge>}
                      </Td>
                      <Td className="text-xs">
                        {pname(r.sourceProductId)} → {pname(r.destinationProductId)}
                      </Td>
                      <Td className="text-[11px]">
                        {r.conditions.requiredTraits?.length ? t("traits: {traits}", { traits: r.conditions.requiredTraits.join(", ") }) : t("any")}
                        {r.conditions.minDaysOnSource ? ` · ≥${t("{n}d", { n: r.conditions.minDaysOnSource })}` : ""}
                        <div className="text-muted">{t("cap 1/{days}d · max {max}", { days: r.frequencyCapDays, max: r.maxImpressions })}</div>
                      </Td>
                      <Td className="num">{st?.impressions ?? 0}</Td>
                      <Td className="num">{st?.clicks ?? 0}</Td>
                      <Td className="num">{st?.signups ?? 0}</Td>
                      <Td className="num">{st?.subscriptions ?? 0}</Td>
                      <Td className="num text-xs">
                        {st?.revenue.length ? st.revenue.map((v) => formatValue(v.cents, "money", v.currency, intl)).join(" · ") : formatValue(0, "count", undefined, intl)}
                        {st?.reportedRevenueCents ? <div className="text-[11px] text-muted">{t("{amount} reported by the product", { amount: formatValue(st.reportedRevenueCents, "money", undefined, intl) })}</div> : null}
                      </Td>
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
          <p className="border-t border-line px-4 py-2 text-[11px] text-muted">
            {t("Impressions and clicks: cross-sell events recorded by the products. Signups and subscriptions: destination-product events whose visit came from the rule's link (utm_source beacon-cross-sell, utm_campaign = rule id). Measured revenue: revenue events of those people in the destination product. Correlation, not causation.")}
          </p>
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
              {data.relationships.length > 0 && (
                <Field label={t("Ecosystem relationship (optional)")}>
                  <select name="relationshipId" defaultValue="">
                    <option value="">{t("None")}</option>
                    {data.relationships.map((x) => (
                      <option key={x.id} value={x.id}>
                        {`${pname(x.fromProductId)} → ${pname(x.toProductId)} · ${enumLabel(t, x.type)}`}
                      </option>
                    ))}
                  </select>
                </Field>
              )}
              <div>
                <Button>{t("Create rule")}</Button>
              </div>
            </form>
          </Panel>
        )}
      </div>

      <div id="ecosystem" className="mt-6 grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel title={t("Ecosystem graph")} eyebrow={t("Typed relationships between products · explained, optionally sourced")} pad={false}>
          {data.relationships.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>{t("From → to")}</Th>
                  <Th>{t("Type")}</Th>
                  <Th>{t("Rationale")}</Th>
                  <Th>{t("Rules")}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data.relationships.map((x) => (
                  <tr key={x.id}>
                    <Td className="text-xs">
                      {pname(x.fromProductId)} → {pname(x.toProductId)}
                    </Td>
                    <Td>
                      <Badge>{enumLabel(t, x.type)}</Badge>
                    </Td>
                    <Td className="text-xs">
                      {x.rationale}
                      {x.sourceId && <div className="text-[11px] text-muted">{t("Sourced")}</div>}
                    </Td>
                    <Td className="num text-xs">{data.rules.filter((r) => r.relationshipId === x.id).length}</Td>
                    <Td>
                      {can("growth:write") && (
                        <form action={removeRelationshipAction}>
                          <HiddenBack path={`${back}#ecosystem`} />
                          <input type="hidden" name="id" value={x.id} />
                          <button className="eyebrow hover:text-chrome">{t("remove")}</button>
                        </form>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <div className="p-4">
              <EmptyState
                variant="not_generated"
                what={t("No relationships yet.")}
                why={t("Describe how your products relate (complementary, same audience, workflow extension, upsell, cross-sell) so cross-sell rules rest on an explicit, reviewable reason.")}
                action={
                  can("growth:write") && data.prods.length > 1
                    ? { label: t("Describe a relationship"), href: `${back}#new-relationship` }
                    : data.prods.length < 2
                      ? { label: t("Add a product"), href: "/products" }
                      : { label: t("Review cross-sell rules"), href: `${back}#cross-sell` }
                }
              />
            </div>
          )}
        </Panel>
        {can("growth:write") && data.prods.length > 1 && (
          <Panel title={t("New relationship")}>
            <form id="new-relationship" action={addRelationshipAction} className="flex flex-col gap-3">
              <HiddenBack path={`${back}#ecosystem`} />
              <div className="grid grid-cols-2 gap-2">
                <Field label={t("From")}>
                  <select name="fromProductId">
                    {data.prods.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={t("To")}>
                  <select name="toProductId" defaultValue={data.prods[1]?.id}>
                    {data.prods.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label={t("Type")}>
                <select name="type">
                  {RELATIONSHIP_TYPES.map((x) => (
                    <option key={x} value={x}>
                      {enumLabel(t, x)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("Rationale (why these products relate)")}>
                <textarea name="rationale" required minLength={10} maxLength={500} className="min-h-16" />
              </Field>
              <div>
                <Button>{t("Save relationship")}</Button>
              </div>
            </form>
          </Panel>
        )}
      </div>

      <Panel title={t("AI sales agent: test a visitor need")} eyebrow={t("Explainable product recommendation")} className="mt-6">
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
                  <p className="text-xs text-chrome">{data.recommendation.primary.relevantFeatures.join(", ") || t("None")}</p>
                  <div className="eyebrow mb-1 mt-3">{t("Pricing (verified)")}</div>
                  <p className="text-xs text-chrome">{data.recommendation.primary.pricing.map((x) => t(x)).join(" · ") || t("No verified pricing recorded")}</p>
                  {data.recommendation.primary.cta && <div className="mt-3 text-xs text-gold-bright">{t("CTA: {label} → {url}", { label: data.recommendation.primary.cta.label, url: data.recommendation.primary.cta.url })}</div>}
                </div>
                <div className="border border-line p-4">
                  <div className="eyebrow">{t("Complementary products")}</div>
                  {data.recommendation.complementary.length ? (
                    data.recommendation.complementary.map((c) => (
                      <div key={c.productId} className="mt-2 text-sm text-chrome">
                        {c.productName} <span className="text-xs text-muted">({c.why.map((w) => w.fact).join(", ")})</span>
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
