import { Badge, cx } from "@/components/ui";
import { enumLabel, type T } from "@/i18n/core";
import { getI18n } from "@/i18n/server";
import type { Estimate, EstimatedValue, EstimateInput, EstimateUnit, ImpactEstimate, NotEstimable } from "@/core/estimate/types";

/**
 * Estimates (src/core/estimate) rendered the same way everywhere: an
 * interval bar (p10 to p90, p50 mark), the confidence, and "How this was
 * estimated" (method and inputs). A NOT_ESTIMABLE estimate never shows a
 * number: it shows why and what to connect. Server components, translated.
 */

/** Format a value in its unit (money in minor units, never converted). */
export function formatEstimateValue(v: number, unit: EstimateUnit | undefined, intl: string, currency?: string): string {
  if (unit === "ratio" || unit === "probability") {
    const digits = v !== 0 && Math.abs(v) < 0.1 ? 2 : 1;
    return new Intl.NumberFormat(intl, { style: "percent", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
  }
  if (unit === "money_minor") {
    const major = v / 100;
    const digits = Math.abs(major) < 100 ? 2 : 0;
    return currency
      ? new Intl.NumberFormat(intl, { style: "currency", currency, minimumFractionDigits: digits, maximumFractionDigits: digits }).format(major)
      : new Intl.NumberFormat(intl, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(major);
  }
  const a = Math.abs(v);
  return new Intl.NumberFormat(intl, { maximumFractionDigits: a === 0 || a >= 100 ? 0 : a >= 10 ? 1 : 2 }).format(v);
}

const ENUMISH = /^[A-Z][A-Z0-9_]*$/;

function inputValue(t: T, i: EstimateInput, intl: string): string {
  if (typeof i.value === "number") return formatEstimateValue(i.value, i.unit, intl, i.currency);
  return ENUMISH.test(i.value) ? enumLabel(t, i.value) : t(i.value);
}

const CONF_TONE = { LOW: "warn", MEDIUM: "neutral", HIGH: "ok" } as const;

/** Interval bar: the p10 to p90 band (series colour 1) with the p50 mark (series colour 2). */
export async function EstimateBar({ estimate, compact = false }: { estimate: EstimatedValue; compact?: boolean }) {
  const { t, intl } = await getI18n();
  const f = (v: number) => formatEstimateValue(v, estimate.unit, intl, estimate.currency);
  const lo = Math.min(0, estimate.p10);
  const top = estimate.unit === "ratio" || estimate.unit === "probability" ? Math.min(1, Math.max(estimate.p90 * 1.15, 0.0001)) : Math.max(estimate.p90 * 1.15, 0);
  const hi = top > lo ? top : lo + 1;
  const pct = (v: number) => Math.max(0, Math.min(100, ((v - lo) / (hi - lo)) * 100));
  const label = t("80% interval: {p10} to {p90}, median {p50}", { p10: f(estimate.p10), p90: f(estimate.p90), p50: f(estimate.p50) });
  return (
    <div className="min-w-0" role="img" aria-label={label} title={label}>
      <div className={cx("relative w-full rounded-[2px] bg-line", compact ? "h-1.5" : "h-2.5")}>
        <div className="absolute inset-y-0 rounded-[2px]" style={{ left: `${pct(estimate.p10)}%`, width: `${Math.max(0.8, pct(estimate.p90) - pct(estimate.p10))}%`, background: "var(--color-s1)", opacity: 0.75 }} />
        <div className={cx("absolute w-[3px] -translate-x-1/2 rounded-[1px]", compact ? "-inset-y-0.5" : "-inset-y-1")} style={{ left: `${pct(estimate.p50)}%`, background: "var(--color-s2)" }} />
      </div>
      {!compact && (
        <div className="num mt-1.5 flex justify-between gap-2 text-[11px] text-muted">
          <span>{t("p10 {value}", { value: f(estimate.p10) })}</span>
          <span>{t("p90 {value}", { value: f(estimate.p90) })}</span>
        </div>
      )}
    </div>
  );
}

async function Inputs({ inputs }: { inputs: EstimateInput[] }) {
  const { t, intl } = await getI18n();
  if (!inputs.length) return null;
  return (
    <ul className="mt-2 flex flex-col gap-2">
      {inputs.map((i, k) => (
        <li key={`${i.name}-${k}`} className="min-w-0 border-l border-line-strong pl-2">
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-xs text-chrome">{t(i.name)}</span>
            <span className="num text-xs text-platinum">{inputValue(t, i, intl)}</span>
            <Badge tone="muted">{i.source === "MEASURED" ? t("Measured") : t("Your history")}</Badge>
            {i.sampleSize !== undefined && <span className="num text-[10px] text-muted">{t("n = {n}", { n: i.sampleSize.toLocaleString(intl) })}</span>}
          </div>
          <p className="mt-0.5 break-words text-[11px] text-muted">{t(i.detail)}</p>
        </li>
      ))}
    </ul>
  );
}

async function Missing({ estimate }: { estimate: NotEstimable }) {
  const { t } = await getI18n();
  return (
    <div>
      <p className="text-sm text-muted">{t("Not estimable")}</p>
      <p className="mt-1 text-xs text-chrome">{t(estimate.reason)}</p>
      {estimate.missing.length > 0 && (
        <div className="mt-2">
          <div className="eyebrow">{t("What to connect")}</div>
          <ul className="mt-1 flex flex-col gap-0.5 text-xs text-blue-bright">
            {estimate.missing.map((m) => (
              <li key={m}>{t(m)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** One estimate: value and interval, or why it cannot be estimated, with "How this was estimated". */
export async function EstimateView({ estimate, compact = false }: { estimate: Estimate; compact?: boolean }) {
  const { t, intl } = await getI18n();
  const currency = estimate.currency ? ` (${estimate.currency})` : "";
  return (
    <div className="min-w-0" data-estimate={estimate.key} data-estimate-state={estimate.state}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="eyebrow">
          {t(estimate.label)}
          {currency}
        </div>
        {estimate.state === "ESTIMATED" && (
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge tone={CONF_TONE[estimate.confidence]}>{t("Confidence: {level}", { level: enumLabel(t, estimate.confidence) })}</Badge>
            {estimate.horizonDays > 0 && <Badge tone="muted">{t("{days} days", { days: estimate.horizonDays })}</Badge>}
          </div>
        )}
      </div>
      {estimate.state === "ESTIMATED" ? (
        <div className="mt-2">
          <div className={cx("num font-medium text-platinum", compact ? "text-base" : "text-xl")}>{formatEstimateValue(estimate.p50, estimate.unit, intl, estimate.currency)}</div>
          <div className="mt-2">
            <EstimateBar estimate={estimate} compact={compact} />
          </div>
        </div>
      ) : (
        <div className="mt-2">
          <Missing estimate={estimate} />
        </div>
      )}
      <details className="mt-3 border-t border-line pt-2">
        <summary className="cursor-pointer text-[11px] text-chrome hover:text-blue-bright">{estimate.state === "ESTIMATED" ? t("How this was estimated") : t("What was available")}</summary>
        {estimate.state === "ESTIMATED" && <p className="mt-2 text-xs text-chrome">{t(estimate.method)}</p>}
        {estimate.inputs.length ? <Inputs inputs={estimate.inputs} /> : <p className="mt-2 text-xs text-muted">{t("No measured input yet.")}</p>}
      </details>
    </div>
  );
}

const REACHED: Record<ImpactEstimate["reached"], string> = {
  none: "Nothing can be estimated yet for this action.",
  clicks: "Estimated so far: extra clicks only.",
  signups: "Estimated so far: extra clicks and signups.",
  revenue: "Estimated: extra clicks, signups and revenue.",
};

/** The master estimator's result: expected signups and revenue per currency, then the chain behind them. */
export async function ImpactEstimateView({ impact }: { impact: ImpactEstimate }) {
  const { t } = await getI18n();
  const traffic = impact.parts.find((p) => p.key === "traffic_potential");
  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted">{t(REACHED[impact.reached])}</p>
      <EstimateView estimate={impact.signups} />
      {impact.signups.state === "NOT_ESTIMABLE" && traffic?.state === "ESTIMATED" && <EstimateView estimate={traffic} />}
      {impact.revenue.map((r, i) => (
        <EstimateView key={`${r.currency ?? "none"}-${i}`} estimate={r} />
      ))}
      {impact.parts.length > 0 && (
        <details className="border-t border-line pt-2">
          <summary className="cursor-pointer text-[11px] text-chrome hover:text-blue-bright">{t("Estimate chain ({n} parts)", { n: impact.parts.length })}</summary>
          <div className="mt-3 flex flex-col gap-4">
            {impact.parts.map((p, i) => (
              <EstimateView key={`${p.key}-${p.currency ?? ""}-${i}`} estimate={p} compact />
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

/** Compact one-line summary for lists: the deepest estimated quantity, or "Impact not estimable" without any number. */
export async function ImpactSummary({ impact }: { impact: ImpactEstimate | null | undefined }) {
  const { t, intl } = await getI18n();
  if (!impact) return null;
  const traffic = impact.parts.find((p) => p.key === "traffic_potential");
  const shown: EstimatedValue | null = impact.signups.state === "ESTIMATED" ? impact.signups : traffic?.state === "ESTIMATED" ? traffic : null;
  if (!shown) {
    const first = impact.signups.state === "NOT_ESTIMABLE" ? impact.signups.missing[0] : undefined;
    return (
      <div className="text-[11px] text-muted" data-estimate-state="NOT_ESTIMABLE">
        {t("Impact not estimable")}
        {first && <span className="block text-blue-bright">{t("Needs: {item}", { item: t(first) })}</span>}
      </div>
    );
  }
  return (
    <div className="w-full min-w-0 md:w-56" data-estimate-state="ESTIMATED">
      <div className="flex items-baseline justify-between gap-2 text-[11px]">
        <span className="text-muted">{t(shown.label)}</span>
        <span className="num text-platinum">{formatEstimateValue(shown.p50, shown.unit, intl, shown.currency)}</span>
      </div>
      <div className="mt-1">
        <EstimateBar estimate={shown} compact />
      </div>
    </div>
  );
}
