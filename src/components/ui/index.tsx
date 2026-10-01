import Link from "next/link";
import type { ReactNode } from "react";
import { getI18n, getT } from "@/i18n/server";

export function cx(...xs: (string | false | null | undefined)[]) {
  return xs.filter(Boolean).join(" ");
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow?: string; title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-8 flex flex-col gap-4 border-b border-line pb-6 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="eyebrow mb-2">{eyebrow}</div>}
        <h1 className="text-gradient-gold text-2xl font-semibold tracking-tight md:text-[1.7rem]">{title}</h1>
        {description && <p className="mt-2 max-w-3xl text-sm text-chrome">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

export function Panel({ title, eyebrow, actions, children, className, pad = true }: { title?: ReactNode; eyebrow?: string; actions?: ReactNode; children: ReactNode; className?: string; pad?: boolean }) {
  return (
    <section className={cx("min-w-0 border border-line bg-panel/90", className)}>
      {(title || eyebrow || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0">
            {eyebrow && <div className="eyebrow">{eyebrow}</div>}
            {title && <h2 className="truncate text-sm font-medium text-gold-bright">{title}</h2>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={pad ? "p-4" : ""}>{children}</div>
    </section>
  );
}

type Fmt = "count" | "money" | "percent";

/** Locale-aware number formatting; pass `intl` from `getI18n()` (defaults to en-GB). */
export function formatValue(v: number, fmt: Fmt = "count", currency = "EUR", intl = "en-GB") {
  if (fmt === "money") return new Intl.NumberFormat(intl, { style: "currency", currency, maximumFractionDigits: 0 }).format(v / 100);
  if (fmt === "percent") return new Intl.NumberFormat(intl, { style: "percent", minimumFractionDigits: v < 0.1 ? 2 : 1, maximumFractionDigits: v < 0.1 ? 2 : 1 }).format(v);
  return new Intl.NumberFormat(intl, { maximumFractionDigits: v < 10 && v % 1 ? 1 : 0 }).format(v);
}

export async function Delta({ now, prev }: { now: number | null; prev: number | null }) {
  if (now === null || prev === null) return null;
  const { t, intl } = await getI18n();
  if (prev === 0) return <span className="num text-[11px] text-muted">{now === 0 ? t("no change") : t("new")}</span>;
  const d = (now - prev) / prev;
  const flat = Math.abs(d) < 0.005;
  return (
    <span className={cx("num text-[11px]", flat ? "text-muted" : d > 0 ? "text-ok" : "text-crit")} title={t("Previous period: {value}", { value: formatValue(prev, "count", undefined, intl) })}>
      {flat ? "±0%" : `${d > 0 ? "▲" : "▼"} ${formatValue(Math.abs(d), "percent", undefined, intl)}`}
    </span>
  );
}

/** KPI tile. `value === null` renders an explicit "not connected" state, never a fake zero. */
export async function Stat({ label, value, prev, fmt = "count", currency, source, href }: { label: string; value: number | null; prev?: number | null; fmt?: Fmt; currency?: string; source?: string; href?: string }) {
  const { t, intl } = await getI18n();
  const body = (
    <div className="flex h-full min-w-0 flex-col justify-between gap-3 border border-line bg-panel p-4 transition-colors hover:border-line-strong">
      <div className="eyebrow">{label}</div>
      {value === null ? (
        <div>
          <div className="text-lg text-muted">{t("Not connected")}</div>
          {source && <div className="mt-1 text-[11px] text-muted">{source}</div>}
        </div>
      ) : (
        <div>
          <div className="num text-2xl font-medium tracking-tight text-platinum">{formatValue(value, fmt, currency, intl)}</div>
          <div className="mt-1 flex flex-col gap-0.5">
            <Delta now={value} prev={prev ?? null} />
            {source && <span className="line-clamp-2 text-[11px] text-muted">{source}</span>}
          </div>
        </div>
      )}
    </div>
  );
  return href ? (
    <Link href={href} className="block h-full">
      {body}
    </Link>
  ) : (
    body
  );
}

const TONES = {
  neutral: "border-line-strong text-chrome",
  gold: "border-gold-dim text-gold-bright",
  ok: "border-ok/40 text-ok",
  warn: "border-warn/40 text-warn",
  crit: "border-crit/50 text-crit",
  muted: "border-line text-muted",
} as const;

export function Badge({ children, tone = "neutral", title }: { children: ReactNode; tone?: keyof typeof TONES; title?: string }) {
  return (
    <span title={title} className={cx("inline-flex items-center gap-1 whitespace-nowrap border px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider", TONES[tone])}>
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, keyof typeof TONES> = {
  CRITICAL: "crit",
  HIGH: "crit",
  MEDIUM: "warn",
  LOW: "muted",
  INFO: "muted",
  PUBLISHED: "ok",
  APPROVED: "ok",
  CONNECTED: "ok",
  SUCCEEDED: "ok",
  VERIFIED: "ok",
  COVERED: "ok",
  PERFORMING: "ok",
  ACTIVE: "ok",
  DONE: "ok",
  HUMAN_APPROVAL: "gold",
  IN_REVIEW: "gold",
  READY_FOR_REVIEW: "gold",
  PROPOSED: "gold",
  OPEN: "gold",
  RUNNING: "gold",
  QUEUED: "neutral",
  PARTIAL: "warn",
  FACT_CHECK: "warn",
  SEO_CHECK: "warn",
  NEEDS_REVIEW: "warn",
  ON_HOLD: "warn",
  ERROR: "crit",
  FAILED: "crit",
  DEAD: "crit",
  REJECTED: "crit",
  NONE: "muted",
  UNVERIFIED: "muted",
  NOT_CONNECTED: "muted",
  DISMISSED: "muted",
  PLANNED: "muted",
  DRAFT: "neutral",
  CANDIDATE: "neutral",
  ARCHIVED: "muted",
  UNKNOWN: "muted",
  PENDING: "neutral",
  PAID: "ok",
  VOID: "muted",
  DISABLED: "muted",
  CANCELLED: "muted",
  CONCLUDED: "ok",
  ABANDONED: "muted",
};

export async function StatusBadge({ status }: { status: string }) {
  const t = await getT();
  const icon = ["CRITICAL", "HIGH", "ERROR", "FAILED", "DEAD", "REJECTED"].includes(status) ? "✕ " : ["PUBLISHED", "APPROVED", "CONNECTED", "SUCCEEDED", "VERIFIED", "COVERED", "DONE"].includes(status) ? "✓ " : "";
  return (
    <Badge tone={STATUS_TONE[status] ?? "neutral"}>
      {icon}
      {t(status.replace(/_/g, " "))}
    </Badge>
  );
}

export async function PotentialBadge({ potential }: { potential: string }) {
  const t = await getT();
  return <Badge tone={potential === "HIGH" ? "gold" : potential === "MEDIUM" ? "neutral" : "muted"}>{t("{level} potential", { level: t(potential) })}</Badge>;
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="grid-bg flex flex-col items-start gap-3 border border-dashed border-line-strong bg-obsidian/60 p-6">
      <div className="eyebrow text-chrome">{title}</div>
      {children && <div className="max-w-2xl text-sm text-chrome">{children}</div>}
      {action}
    </div>
  );
}

const BTN = {
  primary: "bg-platinum text-obsidian hover:bg-white border-platinum",
  gold: "bg-gradient-to-b from-gold-bright to-gold text-obsidian hover:brightness-110 border-gold",
  ghost: "bg-transparent text-platinum border-line-strong hover:border-blue-bright",
  danger: "bg-transparent text-crit border-crit/50 hover:border-crit",
} as const;

export function Button({ children, variant = "ghost", name, value, type = "submit", title, disabled, formAction }: { children: ReactNode; variant?: keyof typeof BTN; name?: string; value?: string; type?: "submit" | "button"; title?: string; disabled?: boolean; formAction?: (fd: FormData) => void | Promise<void> }) {
  return (
    <button
      type={type}
      name={name}
      value={value}
      title={title}
      disabled={disabled}
      formAction={formAction}
      className={cx("inline-flex items-center gap-2 border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors disabled:cursor-not-allowed disabled:opacity-40", BTN[variant])}
    >
      {children}
    </button>
  );
}

export function LinkButton({ href, children, variant = "ghost" }: { href: string; children: ReactNode; variant?: keyof typeof BTN }) {
  return (
    <Link href={href} className={cx("inline-flex items-center gap-2 border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors", BTN[variant])}>
      {children}
    </Link>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <label className={cx("flex flex-col gap-1.5", className)}>
      <span className="eyebrow text-chrome">{label}</span>
      {children}
      {hint && <span className="text-[11px] text-muted">{hint}</span>}
    </label>
  );
}

/** Flash messages from server actions; runtime strings are translated through the dictionary templates. */
export async function Flash({ searchParams }: { searchParams: Record<string, string | string[] | undefined> }) {
  const t = await getT();
  const ok = typeof searchParams.ok === "string" ? searchParams.ok : null;
  const error = typeof searchParams.error === "string" ? searchParams.error : null;
  if (!ok && !error) return null;
  return (
    <div role="status" className={cx("mb-6 border px-4 py-3 text-sm", error ? "border-crit/50 text-crit" : "border-ok/40 text-ok")}>
      {error ? `✕ ${t(error)}` : `✓ ${t(ok!)}`}
    </div>
  );
}

export function Table({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm">{children}</table>
    </div>
  );
}
export function Th({ children, className }: { children?: ReactNode; className?: string }) {
  return <th className={cx("eyebrow whitespace-nowrap border-b border-line px-3 py-2 font-normal", className)}>{children}</th>;
}
export function Td({ children, className, colSpan, title }: { children?: ReactNode; className?: string; colSpan?: number; title?: string }) {
  return (
    <td colSpan={colSpan} title={title} className={cx("border-b border-line/60 px-3 py-2.5 align-top text-chrome", className)}>
      {children}
    </td>
  );
}

export function Tabs({ items, active }: { items: { href: string; label: string; key: string }[]; active: string }) {
  return (
    <nav className="mb-6 flex gap-1 overflow-x-auto border-b border-line">
      {items.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          className={cx("whitespace-nowrap border-b-2 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.14em]", t.key === active ? "border-blue-bright text-platinum" : "border-transparent text-muted hover:text-chrome")}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}

export function Meter({ value, max, label }: { value: number; max: number; label?: string }) {
  const pct = max ? Math.max(0, Math.min(100, (value / max) * 100)) : 0;
  return (
    <div className="flex items-center gap-3" aria-label={label}>
      <div className="h-1.5 flex-1 bg-line">
        <div className="h-full bg-gradient-to-r from-royal to-blue-bright" style={{ width: `${pct}%` }} />
      </div>
      <span className="num w-16 text-right text-xs text-chrome">
        {Math.round(value * 10) / 10}/{max}
      </span>
    </div>
  );
}

export async function KV({ items }: { items: [string, ReactNode][] }) {
  const t = await getT();
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="min-w-0">
          <dt className="eyebrow">{k}</dt>
          <dd className="mt-0.5 break-words text-chrome">{v ?? <span className="text-muted">{t("Unknown")}</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

export function HiddenBack({ path }: { path: string }) {
  return <input type="hidden" name="_back" value={path} />;
}
