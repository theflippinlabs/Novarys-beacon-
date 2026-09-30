"use client";

import { useId, useMemo, useState } from "react";

export type Series = { key: string; label: string; color: string; points: { x: string; y: number }[] };

/**
 * Minimal SVG line chart: 2px lines, hairline grid, single y-axis, crosshair +
 * tooltip on hover, legend for ≥2 series, and a data table for screen readers.
 */
export function LineChart({ series, height = 180, format = (v: number) => v.toLocaleString("en-GB"), title }: { series: Series[]; height?: number; format?: (v: number) => string; title: string }) {
  const id = useId();
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const pad = { l: 44, r: 12, t: 10, b: 22 };
  const xs = series[0]?.points.map((p) => p.x) ?? [];
  const max = useMemo(() => {
    const m = Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.y)));
    if (m === 0) return 1;
    const mag = 10 ** Math.floor(Math.log10(m));
    return Math.ceil(m / mag) * mag;
  }, [series]);
  const x = (i: number) => pad.l + (xs.length <= 1 ? 0 : (i * (W - pad.l - pad.r)) / (xs.length - 1));
  const y = (v: number) => pad.t + (1 - v / max) * (height - pad.t - pad.b);
  const ticks = [0, max / 2, max];

  if (!xs.length) return <div className="text-sm text-muted">No data points yet.</div>;

  return (
    <figure className="w-full">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="h-auto w-full overflow-visible"
        role="img"
        aria-labelledby={`${id}-t`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((px - pad.l) / (W - pad.l - pad.r)) * (xs.length - 1));
          setHover(Math.max(0, Math.min(xs.length - 1, i)));
        }}
      >
        <title id={`${id}-t`}>{title}</title>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--color-line)" strokeWidth={1} />
            <text x={pad.l - 8} y={y(t) + 3} textAnchor="end" className="fill-muted font-mono text-[10px]">
              {format(t)}
            </text>
          </g>
        ))}
        {[0, Math.floor((xs.length - 1) / 2), xs.length - 1].map((i) => (
          <text key={i} x={x(i)} y={height - 6} textAnchor={i === 0 ? "start" : i === xs.length - 1 ? "end" : "middle"} className="fill-muted font-mono text-[10px]">
            {xs[i]?.slice(5)}
          </text>
        ))}
        {series.map((s) => (
          <g key={s.key}>
            <path d={`M${s.points.map((p, i) => `${x(i)},${y(p.y)}`).join("L")}L${x(s.points.length - 1)},${y(0)}L${x(0)},${y(0)}Z`} fill={s.color} opacity={0.08} />
            <polyline points={s.points.map((p, i) => `${x(i)},${y(p.y)}`).join(" ")} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            <circle cx={x(s.points.length - 1)} cy={y(s.points.at(-1)!.y)} r={4} fill={s.color} stroke="var(--color-panel)" strokeWidth={2} />
          </g>
        ))}
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={height - pad.b} stroke="var(--color-line-strong)" strokeWidth={1} />
            {series.map((s) => (
              <circle key={s.key} cx={x(hover)} cy={y(s.points[hover]?.y ?? 0)} r={4} fill={s.color} stroke="var(--color-panel)" strokeWidth={2} />
            ))}
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="pointer-events-none mt-1 flex flex-wrap gap-x-4 gap-y-1 font-mono text-[11px] text-chrome" aria-live="polite">
          <span className="text-muted">{xs[hover]}</span>
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="inline-block h-2 w-2" style={{ background: s.color }} />
              {s.label}: <span className="text-platinum">{format(s.points[hover]?.y ?? 0)}</span>
            </span>
          ))}
        </div>
      )}
      {series.length > 1 && hover === null && (
        <figcaption className="mt-1 flex flex-wrap gap-4 font-mono text-[11px] text-chrome">
          {series.map((s) => (
            <span key={s.key} className="flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3" style={{ background: s.color }} />
              {s.label}
            </span>
          ))}
        </figcaption>
      )}
      <table className="sr-only">
        <caption>{title}</caption>
        <thead>
          <tr>
            <th>Date</th>
            {series.map((s) => (
              <th key={s.key}>{s.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {xs.map((d, i) => (
            <tr key={d}>
              <td>{d}</td>
              {series.map((s) => (
                <td key={s.key}>{s.points[i]?.y}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
