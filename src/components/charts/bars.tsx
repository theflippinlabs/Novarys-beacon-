import type { ReactNode } from "react";
import { enumLabel } from "@/i18n/core";
import { getI18n } from "@/i18n/server";

/** Horizontal bar list: one hue (magnitude), value at the bar tip, native tooltip per bar. */
export async function BarList({ rows, format, color = "var(--color-blue)", empty }: { rows: { label: ReactNode; value: number; key: string; hint?: string }[]; format?: (v: number) => string; color?: string; empty?: string }) {
  const { t, intl } = await getI18n();
  const fmt = format ?? ((v: number) => v.toLocaleString(intl));
  if (!rows.length) return <div className="text-sm text-muted">{empty ?? t("No data yet.")}</div>;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  return (
    <ul className="flex flex-col gap-2.5">
      {rows.map((r) => (
        <li key={r.key} className="grid grid-cols-[minmax(0,10rem)_1fr] items-center gap-3 sm:grid-cols-[minmax(0,14rem)_1fr]" title={r.hint ?? `${fmt(r.value)}`}>
          <span className="truncate text-xs text-chrome">{r.label}</span>
          <span className="flex items-center gap-2">
            <span className="h-3 rounded-r-[4px]" style={{ width: `${Math.max(1, (Math.abs(r.value) / max) * 100)}%`, maxWidth: "calc(100% - 5rem)", background: color }} />
            <span className="num text-xs text-platinum">{fmt(r.value)}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** Funnel as ordered bars with step-to-step conversion. Null rates render as "—" (no denominator). */
export async function FunnelBars({ steps }: { steps: { step: string; visitors: number; conversionFromPrev: number | null }[] }) {
  const { t, intl } = await getI18n();
  const max = Math.max(...steps.map((s) => s.visitors), 1);
  return (
    <ol className="flex flex-col gap-2">
      {steps.map((s) => (
        <li key={s.step} className="grid grid-cols-[9rem_1fr_4.5rem] items-center gap-3">
          <span className="eyebrow text-chrome">{enumLabel(t, s.step)}</span>
          <span className="flex items-center gap-2">
            <span className="h-4 rounded-r-[4px] bg-blue" style={{ width: `${Math.max(0.5, (s.visitors / max) * 100)}%`, maxWidth: "calc(100% - 3.5rem)" }} title={t("{n} unique", { n: s.visitors })} />
            <span className="num text-xs text-platinum">{s.visitors.toLocaleString(intl)}</span>
          </span>
          <span className="num text-right text-xs text-muted">{s.conversionFromPrev === null ? "—" : t("{pct}%", { pct: (s.conversionFromPrev * 100).toLocaleString(intl, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }) })}</span>
        </li>
      ))}
    </ol>
  );
}

export function Sparkline({ values, color = "var(--color-blue-bright)" }: { values: number[]; color?: string }) {
  if (values.length < 2) return null;
  const max = Math.max(...values, 1);
  const W = 100;
  const H = 24;
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * W},${H - (v / max) * (H - 3) - 1.5}`).join(" ");
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-6 w-24" aria-hidden>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
