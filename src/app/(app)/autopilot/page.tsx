import { and, desc, eq, sql } from "drizzle-orm";
import { addCrossSellRuleAction, addExperimentAction, decideRecommendationAction, runReportAction, setExperimentStatusAction, toggleCrossSellRuleAction } from "@/app/actions/growth";
import { Badge, Button, EmptyState, Field, Flash, HiddenBack, PageHeader, Panel, StatusBadge, Table, Td, Th, formatValue } from "@/components/ui";
import { crossSellRules, experiments, growthReports, products, recommendations } from "@/db/schema";
import type { GrowthAnalysis } from "@/core/autopilot/analyst";
import { loadProductGraph } from "@/core/knowledge/load";
import { recommendProducts } from "@/core/sales/recommend";
import { pageData, sp1, type SP } from "@/lib/page";

export const metadata = { title: "Autopilot" };

export default async function AutopilotPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
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

  return (
    <>
      <PageHeader
        eyebrow="12 / Autopilot"
        title="Growth autopilot"
        description="A deterministic growth analyst: measured changes, coinciding events (correlation — not proven causation), prioritised actions, content to create, technical issues, experiments and signals to monitor. Anything touching production content, external accounts or paid campaigns needs approval."
        actions={
          can("job:run") && (
            <form action={runReportAction} className="flex items-center gap-2">
              <HiddenBack path={back} />
              <select name="days" defaultValue="7" aria-label="Period" className="!w-24">
                <option value="7">7 days</option>
                <option value="28">28 days</option>
              </select>
              <Button variant="gold">Analyse now</Button>
            </form>
          )
        }
      />
      <Flash searchParams={sp} />

      {!s ? (
        <EmptyState title="No growth report yet">The analyst runs weekly via the scheduler, or on demand. It only reports on connected, measured data.</EmptyState>
      ) : (
        <div className="grid gap-6 xl:grid-cols-2">
          <Panel title={`${data.report!.periodStart} → ${data.report!.periodEnd}`} eyebrow="What happened">
            {s.whatHappened.length ? (
              <Table>
                <tbody>
                  {s.whatHappened.map((w) => (
                    <tr key={w.metric}>
                      <Td className="text-platinum">{w.metric}</Td>
                      <Td className="num">{w.unit === "cents" ? `${formatValue(w.prev, "money")} → ${formatValue(w.now, "money")}` : `${formatValue(w.prev)} → ${formatValue(w.now)}`}</Td>
                      <Td className={`num ${w.direction === "up" ? "text-ok" : w.direction === "down" ? "text-crit" : "text-muted"}`}>{w.change === null ? "new" : `${w.change > 0 ? "▲" : w.change < 0 ? "▼" : "±"} ${Math.abs(Math.round(w.change * 100))}%`}</Td>
                      <Td className="text-[11px] text-muted">{w.source}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="text-sm text-muted">No comparable measured metrics in this period.</p>
            )}
            <div className="eyebrow mb-2 mt-5">Why it may have happened</div>
            <ul className="flex flex-col gap-2">
              {s.whyItMayHaveHappened.map((w, i) => (
                <li key={i} className="text-sm">
                  <Badge tone={w.evidence === "CORRELATION" ? "warn" : "muted"}>{w.evidence.replace("_", " ")}</Badge> <span className="text-chrome">{w.observation}</span>
                  {w.relatedEvents.length > 0 && <div className="mt-1 text-xs text-muted">Coinciding: {w.relatedEvents.join("; ")}</div>}
                </li>
              ))}
              {!s.whyItMayHaveHappened.length && <li className="text-sm text-muted">No significant changes to explain.</li>}
            </ul>
            <p className="mt-4 text-[11px] text-muted">{s.disclaimer}</p>
          </Panel>
          <Panel title="Actions & signals" eyebrow="Recommended">
            <div className="eyebrow mb-2">Content to create</div>
            <ul className="mb-4 flex flex-col gap-1 text-sm text-chrome">{s.contentToCreate.length ? s.contentToCreate.map((c) => <li key={c}>○ {c}</li>) : <li className="text-muted">—</li>}</ul>
            <div className="eyebrow mb-2">Technical issues</div>
            <ul className="mb-4 flex flex-col gap-1 text-sm text-chrome">{s.technicalIssues.length ? s.technicalIssues.map((c) => <li key={c}>✕ {c}</li>) : <li className="text-muted">No open critical issues.</li>}</ul>
            <div className="eyebrow mb-2">Experiments proposed</div>
            <ul className="mb-4 flex flex-col gap-2 text-sm">
              {s.experiments.length ? (
                s.experiments.map((e) => (
                  <li key={e.name}>
                    <div className="text-platinum">{e.name}</div>
                    <div className="text-xs text-muted">{e.hypothesis} · Monitor: {e.signalToMonitor}</div>
                  </li>
                ))
              ) : (
                <li className="text-muted">—</li>
              )}
            </ul>
            <div className="eyebrow mb-2">Expected signals to monitor</div>
            <ul className="mb-4 flex flex-col gap-1 text-xs text-chrome">{s.signalsToMonitor.map((x) => <li key={x}>• {x}</li>)}</ul>
            <div className="eyebrow mb-2">Data coverage</div>
            <p className="text-xs text-chrome">
              Connected: {s.dataCoverage.connected.join(", ") || "none"} · Missing: <span className="text-warn">{s.dataCoverage.missing.join(", ") || "none"}</span>
            </p>
          </Panel>
        </div>
      )}

      <Panel title={`${data.recs.length} recommendation(s) awaiting a decision`} eyebrow="Approval queue" className="mt-6" pad={false}>
        {data.recs.length ? (
          <Table>
            <tbody>
              {data.recs.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <Badge tone="muted">{r.kind.replace(/_/g, " ")}</Badge>
                  </Td>
                  <Td className="text-platinum">
                    {r.title}
                    <div className="text-xs text-muted">{r.body}</div>
                  </Td>
                  <Td>{r.requiresApproval ? <Badge tone="gold">requires approval</Badge> : <Badge tone="muted">informational</Badge>}</Td>
                  <Td>
                    {can("recommendation:decide") && (
                      <form action={decideRecommendationAction} className="flex gap-2">
                        <HiddenBack path={back} />
                        <input type="hidden" name="id" value={r.id} />
                        <Button name="status" value="APPROVED">Approve</Button>
                        <Button name="status" value="REJECTED" variant="danger">
                          Reject
                        </Button>
                      </form>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="p-4 text-sm text-muted">Nothing to decide.</p>
        )}
      </Panel>

      <div id="experiments" className="mt-6 grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel title="Experiments" eyebrow="Hypothesis → signal → result" pad={false}>
          {data.exps.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>Experiment</Th>
                  <Th>Metric</Th>
                  <Th>Status</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data.exps.map((e) => (
                  <tr key={e.id}>
                    <Td>
                      <div className="text-platinum">{e.name}</div>
                      <div className="text-xs text-muted">{e.hypothesis}</div>
                      {e.result && <div className="mt-1 text-xs text-chrome">Result: {e.result}</div>}
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
                          {e.status === "DRAFT" && <Button name="status" value="RUNNING">Start</Button>}
                          {e.status === "RUNNING" && <Button name="status" value="READY_FOR_REVIEW">Ready for review</Button>}
                          {e.status === "READY_FOR_REVIEW" && (
                            <>
                              <input name="result" placeholder="Observed result" aria-label="Result" />
                              <Button name="status" value="CONCLUDED">Conclude</Button>
                            </>
                          )}
                          <button name="status" value="ABANDONED" className="eyebrow text-left hover:text-crit">
                            abandon
                          </button>
                        </form>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="p-4 text-sm text-muted">No experiments yet.</p>
          )}
        </Panel>
        {can("growth:write") && (
          <Panel title="New experiment">
            <form action={addExperimentAction} className="flex flex-col gap-3">
              <HiddenBack path={back} />
              <Field label="Name">
                <input name="name" required maxLength={160} />
              </Field>
              <Field label="Hypothesis">
                <textarea name="hypothesis" required minLength={10} className="min-h-16" />
              </Field>
              <Field label="Primary metric">
                <input name="primaryMetric" required placeholder="CTA click rate" />
              </Field>
              <Field label="Signal to monitor">
                <input name="signalToMonitor" placeholder="CTA_CLICK / PAGE_VIEW over 28 days" />
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
              <div>
                <Button>Create</Button>
              </div>
            </form>
          </Panel>
        )}
      </div>

      <div id="cross-sell" className="mt-6 grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel title="Cross-sell rules" eyebrow="Ecosystem recommendations · consent-gated · frequency-capped" pad={false}>
          {data.rules.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>Rule</Th>
                  <Th>From → to</Th>
                  <Th>Conditions</Th>
                  <Th>Impr.</Th>
                  <Th>Clicks</Th>
                  <Th>Conv.</Th>
                  <Th>Revenue</Th>
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
                        {r.conditions.requiredTraits?.length ? `traits: ${r.conditions.requiredTraits.join(", ")}` : "any"}
                        {r.conditions.minDaysOnSource ? ` · ≥${r.conditions.minDaysOnSource}d` : ""}
                        <div className="text-muted">
                          cap 1/{r.frequencyCapDays}d · max {r.maxImpressions}
                        </div>
                      </Td>
                      <Td className="num">{Number(st?.imp ?? 0)}</Td>
                      <Td className="num">{Number(st?.clk ?? 0)}</Td>
                      <Td className="num">{Number(st?.conv ?? 0)}</Td>
                      <Td className="num">{formatValue(Number(st?.rev ?? 0), "money")}</Td>
                      <Td>
                        {can("growth:write") && (
                          <form action={toggleCrossSellRuleAction}>
                            <HiddenBack path={back} />
                            <input type="hidden" name="id" value={r.id} />
                            {!r.active && <input type="hidden" name="active" value="on" />}
                            <button className="eyebrow hover:text-chrome">{r.active ? "pause" : "activate"}</button>
                          </form>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </Table>
          ) : (
            <p className="p-4 text-sm text-muted">No cross-sell rules. Recommendations are only shown to identities that consented to cross-product recommendations.</p>
          )}
        </Panel>
        {can("growth:write") && data.prods.length > 1 && (
          <Panel title="New cross-sell rule">
            <form action={addCrossSellRuleAction} className="flex flex-col gap-3">
              <HiddenBack path={back} />
              <Field label="Name">
                <input name="name" required maxLength={120} />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="From">
                  <select name="sourceProductId">
                    {data.prods.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="To">
                  <select name="destinationProductId" defaultValue={data.prods[1]?.id}>
                    {data.prods.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Field label="Required shared traits" hint="Comma separated, e.g. agency, team_size:10-50">
                <input name="requiredTraits" />
              </Field>
              <Field label="Min. days on source product">
                <input name="minDaysOnSource" type="number" min={0} defaultValue={7} />
              </Field>
              <Field label="Message (contextual, factual)">
                <textarea name="message" required minLength={10} maxLength={280} className="min-h-16" />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field label="CTA label">
                  <input name="ctaLabel" required defaultValue="Learn more" />
                </Field>
                <Field label="Cap (days)">
                  <input name="frequencyCapDays" type="number" min={1} defaultValue={14} />
                </Field>
              </div>
              <Field label="CTA URL (destination domain)">
                <input name="ctaUrl" type="url" required />
              </Field>
              <Field label="Max impressions">
                <input name="maxImpressions" type="number" min={1} max={20} defaultValue={3} />
              </Field>
              <div>
                <Button>Create rule</Button>
              </div>
            </form>
          </Panel>
        )}
      </div>

      <Panel title="AI sales agent — test a visitor need" eyebrow="Explainable product recommendation" className="mt-6">
        <form method="get" action="/autopilot#sales" className="flex flex-col gap-3 md:flex-row" id="sales">
          <input name="need" defaultValue={need ?? ""} placeholder="I run a TikTok agency with 30 creators." aria-label="Visitor need" />
          <Button>Recommend</Button>
        </form>
        {data.recommendation && (
          <div className="mt-5">
            {data.recommendation.primary ? (
              <div className="grid gap-4 md:grid-cols-2">
                <div className="border border-gold-dim p-4">
                  <div className="eyebrow text-gold">Primary recommendation · {data.recommendation.primary.fit} fit</div>
                  <div className="mt-1 text-lg text-platinum">{data.recommendation.primary.productName}</div>
                  <p className="mt-1 text-sm text-chrome">{data.recommendation.explanation}</p>
                  <div className="eyebrow mb-1 mt-3">Why it matches</div>
                  <ul className="text-xs text-chrome">
                    {data.recommendation.primary.why.map((w) => (
                      <li key={w.kind + w.fact}>
                        • {w.kind.toLowerCase().replace("_", " ")}: {w.fact} <span className="text-muted">({w.matchedTerms.join(", ")})</span>
                      </li>
                    ))}
                  </ul>
                  <div className="eyebrow mb-1 mt-3">Relevant features</div>
                  <p className="text-xs text-chrome">{data.recommendation.primary.relevantFeatures.join(", ") || "—"}</p>
                  <div className="eyebrow mb-1 mt-3">Pricing (verified)</div>
                  <p className="text-xs text-chrome">{data.recommendation.primary.pricing.join(" · ") || "No verified pricing recorded"}</p>
                  {data.recommendation.primary.cta && <div className="mt-3 text-xs text-gold-bright">CTA: {data.recommendation.primary.cta.label} → {data.recommendation.primary.cta.url}</div>}
                </div>
                <div className="border border-line p-4">
                  <div className="eyebrow">Complementary products</div>
                  {data.recommendation.complementary.length ? (
                    data.recommendation.complementary.map((c) => (
                      <div key={c.productId} className="mt-2 text-sm text-chrome">
                        {c.productName} <span className="text-xs text-muted">— {c.why.map((w) => w.fact).join(", ")}</span>
                      </div>
                    ))
                  ) : (
                    <p className="mt-2 text-sm text-muted">None match this need.</p>
                  )}
                  <p className="mt-4 text-[11px] text-muted">Considered {data.recommendation.considered} product(s). Ownership never boosts a score; unmatched products are not recommended.</p>
                </div>
              </div>
            ) : (
              <p className="text-sm text-chrome">{data.recommendation.explanation}</p>
            )}
          </div>
        )}
      </Panel>
    </>
  );
}
