import { desc, eq } from "drizzle-orm";
import { addExperimentAction, designExperimentAction, enterExperimentCountsAction, refreshExperimentCountsAction, setExperimentStatusAction } from "@/app/actions/growth";
import { Badge, Button, Field, HiddenBack, Meter, Panel, StatusBadge, formatValue } from "@/components/ui";
import { evaluateExperiment, type ExperimentResult } from "@/core/experiments/stats";
import { EXPERIMENT_NEXT, type ExperimentStatus } from "@/core/experiments/workflow";
import { withOrg } from "@/db";
import { experiments, products } from "@/db/schema";
import { enumLabel } from "@/i18n/core";
import { getI18n } from "@/i18n/server";

export const EXPERIMENT_METRIC_OPTIONS = ["CTA_CLICK", "PRODUCT_VIEWED", "SIGNUP_STARTED", "SIGNUP_COMPLETED", "TRIAL_STARTED", "ACTIVATION_COMPLETED", "CHECKOUT_STARTED", "SUBSCRIPTION_STARTED"];

/**
 * Growth experiments: design (arms, counted event, minimum sample size),
 * counts per arm (tracked events tagged with the experiment, or entered
 * manually and labelled so), sample progress and the statistical result
 * explained. A winner needs the minimum sample in both arms and p < 0.05.
 */
export async function Experiments({ orgId, canWrite, back }: { orgId: string; canWrite: boolean; back: string }) {
  const { t, intl } = await getI18n();
  const { exps, prods } = await withOrg(orgId, async (tx) => ({
    exps: await tx.select().from(experiments).where(eq(experiments.organizationId, orgId)).orderBy(desc(experiments.updatedAt)),
    prods: await tx.select({ id: products.id, name: products.name }).from(products).where(eq(products.organizationId, orgId)).orderBy(products.name),
  }));
  const pct = (x: number | null) => (x === null ? t("n/a") : formatValue(x, "percent", undefined, intl));
  const pv = (p: number | null) => (p === null ? t("n/a") : p < 0.001 ? "< 0.001" : p.toFixed(3));
  const explain = (r: ExperimentResult, minN: number, min: number | null) => {
    const test = r.method === "FISHER_EXACT" ? t("Fisher's exact test") : t("two-proportion z-test");
    switch (r.reason) {
      case "NO_COUNTS":
        return t("No counts yet: a result needs exposures and conversions in both arms.");
      case "NO_MIN_SAMPLE":
        return t("No minimum sample size was set, so no winner can be declared.");
      case "BELOW_MIN_SAMPLE":
        return t("Below the minimum sample size ({n} of {min} per arm): no winner is declared yet, whatever the p-value.", { n: minN, min: min ?? 0 });
      case "NOT_SIGNIFICANT":
        return t("Not statistically significant ({test}, p = {p}, threshold 0.05).", { test, p: pv(r.pValue) });
      default:
        return t("{arm} converts better ({test}, p = {p} < 0.05).", { arm: r.winner === "VARIANT" ? t("The variant") : t("The control"), test, p: pv(r.pValue) });
    }
  };

  return (
    <div id="experiments" className="mt-6 grid gap-6 xl:grid-cols-[1fr_22rem]">
      <Panel title={t("Experiments")} eyebrow={t("Control vs variant · minimum sample · significance test")}>
        {exps.length ? (
          <ul className="flex flex-col divide-y divide-line">
            {exps.map((e) => {
              const r = evaluateExperiment({ controlN: e.controlN ?? undefined, controlConversions: e.controlConversions ?? undefined, variantN: e.variantN ?? undefined, variantConversions: e.variantConversions ?? undefined, minSampleSize: e.minSampleSize });
              const minN = Math.min(e.controlN ?? 0, e.variantN ?? 0);
              const next = EXPERIMENT_NEXT[e.status as ExperimentStatus] ?? [];
              const open = e.status !== "CONCLUDED" && e.status !== "ABANDONED";
              return (
                <li key={e.id} id={`experiment-${e.id}`} className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-platinum">{t(e.name)}</div>
                      <div className="text-xs text-muted">{t(e.hypothesis)}</div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      <StatusBadge status={e.status} />
                      {e.recommendationId && <Badge tone="muted">{t("From the autopilot")}</Badge>}
                    </div>
                  </div>
                  <div className="grid gap-3 text-xs sm:grid-cols-2">
                    <div>
                      <div className="eyebrow">{t("Control")}</div>
                      <div className="text-chrome">{e.control.description ? t(e.control.description) : t("Not described yet")}</div>
                      {e.control.url && <div className="num truncate text-[10px] text-muted">{e.control.url}</div>}
                    </div>
                    <div>
                      <div className="eyebrow">{t("Variant")}</div>
                      <div className="text-chrome">{e.variant.description ? t(e.variant.description) : t("Not described yet")}</div>
                      {e.variant.url && <div className="num truncate text-[10px] text-muted">{e.variant.url}</div>}
                    </div>
                    <div>
                      <div className="eyebrow">{t("Counted event")}</div>
                      <div className="text-chrome">{e.metricKey ? enumLabel(t, e.metricKey) : t("Not chosen yet")}</div>
                      <div className="text-[10px] text-muted">{t(e.primaryMetric)}</div>
                    </div>
                    <div>
                      <div className="eyebrow">{t("Minimum sample")}</div>
                      <div className="text-chrome">
                        {e.minSampleSize
                          ? t("{n} per arm", { n: formatValue(e.minSampleSize, "count", undefined, intl) })
                          : t("Not computed yet")}
                      </div>
                      {e.baselineRate && e.minDetectableEffect ? (
                        <div className="text-[10px] text-muted">{t("Baseline {rate}, detectable lift {mde}, alpha 0.05, power 0.8", { rate: pct(e.baselineRate), mde: pct(e.minDetectableEffect) })}</div>
                      ) : null}
                    </div>
                  </div>

                  <div className="border border-line p-3 text-xs">
                    <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <span className="eyebrow">{t("Sample progress")}</span>
                      {e.countsSource === "MANUAL" ? <Badge tone="warn">{t("Entered manually")}</Badge> : e.countsSource === "TRACKER" ? <Badge tone="muted">{t("From tracked events")}</Badge> : null}
                    </div>
                    {e.minSampleSize ? <Meter value={minN} max={e.minSampleSize} label={t("Sample progress")} /> : <p className="text-muted">{t("Compute the minimum sample size to follow progress.")}</p>}
                    {e.controlN !== null && e.variantN !== null && (
                      <p className="num mt-2 text-chrome">
                        {t("Control {rate} ({c}/{n})", { rate: pct(r.controlRate), c: e.controlConversions ?? 0, n: e.controlN })} · {t("Variant {rate} ({c}/{n})", { rate: pct(r.variantRate), c: e.variantConversions ?? 0, n: e.variantN })}
                        {r.lift !== null ? ` · ${t("lift {lift}", { lift: `${r.lift > 0 ? "+" : ""}${formatValue(r.lift, "percent", undefined, intl)}` })}` : ""}
                      </p>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Badge tone={r.winner === "INCONCLUSIVE" ? "muted" : "ok"}>{enumLabel(t, r.winner)}</Badge>
                      {r.pValue !== null && <span className="num text-muted">{t("p = {p} · confidence {c}", { p: pv(r.pValue), c: pct(r.confidence) })}</span>}
                    </div>
                    <p className="mt-1 text-chrome">{explain(r, minN, e.minSampleSize)}</p>
                    {e.result && <p className="mt-1 text-muted">{t("Note: {result}", { result: e.result })}</p>}
                  </div>

                  {canWrite && open && (
                    <div className="flex flex-col gap-2">
                      {e.status === "DRAFT" && (
                        <details className="text-xs">
                          <summary className="cursor-pointer text-blue-bright">{t("Design and sample size")}</summary>
                          <form action={designExperimentAction} className="mt-2 grid gap-2 sm:grid-cols-2">
                            <HiddenBack path={`${back}#experiment-${e.id}`} />
                            <input type="hidden" name="id" value={e.id} />
                            <Field label={t("Control")}>
                              <input name="control" defaultValue={e.control.description ?? ""} maxLength={300} />
                            </Field>
                            <Field label={t("Variant")}>
                              <input name="variant" defaultValue={e.variant.description ?? ""} maxLength={300} />
                            </Field>
                            <Field label={t("Control URL (https)")}>
                              <input name="controlUrl" type="url" defaultValue={e.control.url ?? ""} />
                            </Field>
                            <Field label={t("Variant URL (https)")}>
                              <input name="variantUrl" type="url" defaultValue={e.variant.url ?? ""} />
                            </Field>
                            <Field label={t("Counted event")}>
                              <select name="metricKey" defaultValue={e.metricKey ?? ""}>
                                <option value="">{t("Choose")}</option>
                                {EXPERIMENT_METRIC_OPTIONS.map((m) => (
                                  <option key={m} value={m}>
                                    {enumLabel(t, m)}
                                  </option>
                                ))}
                              </select>
                            </Field>
                            <Field label={t("Baseline conversion rate (%)")}>
                              <input name="baselinePct" type="number" step="0.01" min={0.01} max={99.99} defaultValue={e.baselineRate ? Math.round(e.baselineRate * 10000) / 100 : ""} />
                            </Field>
                            <Field label={t("Minimum detectable lift (%)")} hint={t("Relative: 20 means detecting 5.0% → 6.0%.")}>
                              <input name="mdePct" type="number" step="0.1" min={0.1} max={1000} defaultValue={e.minDetectableEffect ? Math.round(e.minDetectableEffect * 1000) / 10 : ""} />
                            </Field>
                            <div className="flex items-end">
                              <Button>{t("Save design")}</Button>
                            </div>
                          </form>
                        </details>
                      )}
                      {(e.status === "RUNNING" || e.status === "READY_FOR_REVIEW") && (
                        <>
                          <p className="text-[11px] text-muted">
                            {t("Tag events on each arm with the tracker attributes:")} <code className="num text-chrome">{`data-experiment="${e.id}" data-variant="control|variant"`}</code>
                          </p>
                          <div className="flex flex-wrap gap-2">
                            {e.countsSource !== "MANUAL" && (
                              <form action={refreshExperimentCountsAction}>
                                <HiddenBack path={`${back}#experiment-${e.id}`} />
                                <input type="hidden" name="id" value={e.id} />
                                <Button>{t("Refresh counts")}</Button>
                              </form>
                            )}
                          </div>
                          <details className="text-xs">
                            <summary className="cursor-pointer text-muted hover:text-chrome">{t("Enter counts manually")}</summary>
                            <form action={enterExperimentCountsAction} className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                              <HiddenBack path={`${back}#experiment-${e.id}`} />
                              <input type="hidden" name="id" value={e.id} />
                              <Field label={t("Control: units")}>
                                <input name="controlN" type="number" min={0} defaultValue={e.controlN ?? ""} />
                              </Field>
                              <Field label={t("Control: conversions")}>
                                <input name="controlConversions" type="number" min={0} defaultValue={e.controlConversions ?? ""} />
                              </Field>
                              <Field label={t("Variant: units")}>
                                <input name="variantN" type="number" min={0} defaultValue={e.variantN ?? ""} />
                              </Field>
                              <Field label={t("Variant: conversions")}>
                                <input name="variantConversions" type="number" min={0} defaultValue={e.variantConversions ?? ""} />
                              </Field>
                              <div className="col-span-2 sm:col-span-4">
                                <Button>{t("Save counts")}</Button>
                                <p className="mt-1 text-[11px] text-muted">{t("Manual counts are labelled “entered manually”. Leave every field empty to clear them.")}</p>
                              </div>
                            </form>
                          </details>
                        </>
                      )}
                      <form action={setExperimentStatusAction} className="flex flex-wrap items-center gap-2">
                        <HiddenBack path={`${back}#experiment-${e.id}`} />
                        <input type="hidden" name="id" value={e.id} />
                        {next.includes("CONCLUDED") && <input name="result" placeholder={t("Decision note (optional)")} aria-label={t("Decision note (optional)")} className="!w-auto flex-1" />}
                        {next
                          .filter((s) => s !== "ABANDONED")
                          .map((s) => (
                            <Button key={s} name="status" value={s} variant={s === "CONCLUDED" ? "gold" : "ghost"}>
                              {s === "RUNNING" ? (e.status === "DRAFT" ? t("Start") : t("Resume")) : s === "READY_FOR_REVIEW" ? t("Ready for review") : t("Conclude")}
                            </Button>
                          ))}
                        <button name="status" value="ABANDONED" className="eyebrow text-left hover:text-crit">
                          {t("abandon")}
                        </button>
                      </form>
                    </div>
                  )}
                  {!open && (
                    <p className="num text-[10px] text-muted">
                      {e.startsOn ?? ""} {e.endsOn ? `→ ${e.endsOn}` : ""}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted">{t("No experiments yet.")}</p>
        )}
        <p className="mt-4 border-t border-line pt-3 text-[11px] text-muted">
          {t("Two-proportion z-test, or Fisher's exact test when an expected count is below 5. No winner is declared below the minimum sample size or with p ≥ 0.05: the result stays INCONCLUSIVE.")}
        </p>
      </Panel>
      {canWrite && (
        <Panel title={t("New experiment")}>
          <form action={addExperimentAction} className="flex flex-col gap-3">
            <HiddenBack path={`${back}#experiments`} />
            <Field label={t("Name")}>
              <input name="name" required maxLength={160} />
            </Field>
            <Field label={t("Hypothesis")}>
              <textarea name="hypothesis" required minLength={10} className="min-h-16" />
            </Field>
            <Field label={t("Primary metric")}>
              <input name="primaryMetric" required placeholder={t("CTA click rate")} />
            </Field>
            <Field label={t("Counted event")}>
              <select name="metricKey" defaultValue="CTA_CLICK">
                {EXPERIMENT_METRIC_OPTIONS.map((m) => (
                  <option key={m} value={m}>
                    {enumLabel(t, m)}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("Control")}>
              <input name="control" maxLength={300} placeholder={t("Current page")} />
            </Field>
            <Field label={t("Variant")}>
              <input name="variant" maxLength={300} />
            </Field>
            <Field label={t("Signal to monitor")}>
              <input name="signalToMonitor" placeholder={t("CTA_CLICK / PAGE_VIEW over 28 days")} />
            </Field>
            <Field label={t("Product")}>
              <select name="productId" defaultValue="">
                <option value="">{t("Ecosystem")}</option>
                {prods.map((p) => (
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
  );
}
