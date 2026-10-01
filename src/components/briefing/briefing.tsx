import Link from "next/link";
import { Badge, HiddenBack, Panel, cx, formatValue } from "@/components/ui";
import { Greeting } from "@/components/briefing/greeting";
import type { BriefingLine, LineKey, TopAction } from "@/core/briefing/briefing";
import { itemText } from "@/core/reports/report";
import { generateBriefingAction } from "@/app/actions/reports";
import { getI18n } from "@/i18n/server";
import type { T } from "@/i18n/core";
import type { BriefingView } from "@/services/briefings";
import { actionItem } from "@/services/reports";

/** Line labels (literal keys, so the French dictionary test covers them). */
const lineLabel = (t: T, key: LineKey): string => {
  switch (key) {
    case "CLICKS":
      return t("Organic clicks");
    case "IMPRESSIONS":
      return t("Organic impressions");
    case "ENTERED_TOP10":
      return t("Queries that entered positions 4 to 10");
    case "LOST_PAGES":
      return t("Pages that lost visibility");
    case "NEW_GAPS":
      return t("New content gaps");
    case "NEW_CITATIONS":
      return t("New citation opportunities");
    case "DRAFTS":
      return t("Drafts awaiting review");
    case "SIGNUPS_ORGANIC":
      return t("Signups from organic discovery");
    case "MRR_ORGANIC":
      return t("New MRR from organic discovery");
  }
};

const fmtDateTime = (d: Date | string, intl: string) => new Date(d).toLocaleString(intl, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

function Change({ line, intl, t }: { line: BriefingLine; intl: string; t: T }) {
  if (line.state !== "OK" && line.state !== "NO_NEW_DATA") return null;
  if (line.key === "DRAFTS" || line.key === "SIGNUPS_ORGANIC") {
    if (line.prev === null || line.now === null) return null;
    const d = line.now - line.prev;
    if (d === 0) return <span className="text-[11px] text-muted">{t("no change since the previous briefing")}</span>;
    return <span className="num text-[11px] text-muted">{t("{value} vs previous briefing", { value: new Intl.NumberFormat(intl, { signDisplay: "exceptZero", maximumFractionDigits: 1 }).format(d) })}</span>;
  }
  if (line.key !== "CLICKS" && line.key !== "IMPRESSIONS") return null;
  if (line.prev === null) return <span className="text-[11px] text-muted">{t("First measurement")}</span>;
  if (line.deltaPct === null) return <span className="num text-[11px] text-muted">{line.now === line.prev ? t("no change") : t("new")}</span>;
  const d = line.deltaPct;
  return (
    <span className={cx("num text-[11px]", Math.abs(d) < 0.005 ? "text-muted" : d > 0 ? "text-ok" : "text-crit")}>
      {Math.abs(d) < 0.005 ? "±0%" : `${d > 0 ? "▲" : "▼"} ${formatValue(Math.abs(d), "percent", undefined, intl)}`} {t("since the previous briefing")}
    </span>
  );
}

function LineValue({ line, intl, t }: { line: BriefingLine; intl: string; t: T }) {
  if (line.state === "NOT_CONNECTED")
    return (
      <span className="text-sm text-muted">
        {t("Not connected")} <span className="text-[11px] text-blue-bright">{t("Connect →")}</span>
      </span>
    );
  if (line.state === "NO_DATA_YET") return <span className="text-sm text-muted">{t("No data yet")}</span>;
  if (line.key === "MRR_ORGANIC") {
    if (!line.money?.length) return <span className="text-sm text-muted">{t("No data yet")}</span>;
    return (
      <span className="flex flex-col items-end gap-0.5">
        {line.money.map((m) => (
          <span key={m.currency} className="num text-sm text-platinum">
            {formatValue(m.cents, "money", m.currency, intl)}
          </span>
        ))}
      </span>
    );
  }
  return <span className="num text-sm text-platinum">{line.now === null ? t("n/a") : formatValue(line.now, "count", undefined, intl)}</span>;
}

/** Attribution model names, as on the conversions and settings pages. */
const modelLabel = (t: T, m: unknown) => (m === "FIRST_TOUCH" ? t("First touch") : m === "LINEAR" ? t("Linear") : m === "POSITION_BASED" ? t("Position-based (40/20/40)") : t("Last non-direct touch"));

function LineNote({ line, t }: { line: BriefingLine; t: T }) {
  const model = modelLabel(t, line.vars?.model);
  if (line.state === "BASELINE")
    return <span className="text-[11px] text-muted">{line.key === "NEW_GAPS" || line.key === "NEW_CITATIONS" ? t("Currently open; new items are counted from the next briefing") : t("Baseline recorded; changes are counted from the next briefing")}</span>;
  if (line.state === "NO_NEW_DATA") return <span className="text-[11px] text-muted">{t("No new search data since the previous briefing")}</span>;
  if ((line.key === "CLICKS" || line.key === "IMPRESSIONS" || line.key === "ENTERED_TOP10" || line.key === "LOST_PAGES") && line.state === "OK" && line.vars?.end)
    return <span className="text-[11px] text-muted">{t("7 days of search data to {date}", { date: String(line.vars.end) })}</span>;
  if ((line.key === "SIGNUPS_ORGANIC" || line.key === "MRR_ORGANIC") && line.state === "OK") return <span className="text-[11px] text-muted">{t("{model} attribution: organic search and AI referrals, since the previous briefing", { model })}</span>;
  if (line.key === "SIGNUPS_ORGANIC" || line.key === "MRR_ORGANIC") return <span className="text-[11px] text-muted">{t("Attribution model: {model}", { model })}</span>;
  return null;
}

/** Briefing lines (deltas since the previous briefing) and the top 5 actions. */
export async function BriefingBody({ briefing, compact = false }: { briefing: BriefingView; compact?: boolean }) {
  const { t, intl } = await getI18n();
  const lines = briefing.deltas;
  const actions = briefing.topActions as TopAction[];
  const tierLabel = (a: TopAction) => (a.kind === "OPPORTUNITY" ? t("Opportunity") : a.kind === "DRAFT" ? t("Awaiting approval") : t("Blocking"));
  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
      <section aria-label={t("Since the previous analysis")} className="min-w-0">
        <div className="eyebrow mb-2">{t("Since the previous analysis")}</div>
        <ul className="border border-line">
          {lines.map((l) => (
            <li key={l.key} className="border-b border-line/60 last:border-0" data-line-state={l.state}>
              <Link href={l.href} className="flex items-start justify-between gap-3 px-3 py-2.5 hover:bg-panel-2">
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-sm text-chrome">{lineLabel(t, l.key)}</span>
                  <LineNote line={l} t={t} />
                  <Change line={l} intl={intl} t={t} />
                </span>
                <LineValue line={l} intl={intl} t={t} />
              </Link>
              {!compact && l.items && l.items.length > 0 && (
                <ul className="flex flex-col gap-1 px-3 pb-2.5">
                  {l.items.map((i) => (
                    <li key={`${l.key}:${i.label}`} className="min-w-0 truncate text-xs">
                      <Link href={i.href} className="text-blue-bright hover:underline">
                        {i.label}
                      </Link>
                      {i.detail && <span className="num ml-2 text-muted">{t("{now} vs {prev} impressions", { now: formatValue(i.detail.now, "count", undefined, intl), prev: formatValue(i.detail.prev, "count", undefined, intl) })}</span>}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      </section>
      <section aria-label={t("Top 5 actions today")} className="min-w-0">
        <div className="eyebrow mb-2">{t("Top 5 actions today")}</div>
        {actions.length ? (
          <ol className="border border-line">
            {actions.map((a) => (
              <li key={`${a.kind}:${a.id}`} className="border-b border-line/60 last:border-0">
                <Link href={a.href} className="flex items-start gap-3 px-3 py-2.5 hover:bg-panel-2">
                  <span className="num w-5 pt-0.5 text-xs text-gold">{a.rank}</span>
                  <span className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="text-sm text-platinum">{itemText(t, actionItem(a))}</span>
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge tone={a.tier <= 3 ? "crit" : a.kind === "DRAFT" ? "gold" : "neutral"}>{tierLabel(a)}</Badge>
                      {a.product && a.kind !== "BLOCKING_SEO" && <span className="text-[11px] text-muted">{a.product}</span>}
                      {a.priority !== undefined && <span className="num text-[11px] text-muted">{t("priority {value}", { value: a.priority })}</span>}
                      {a.ageDays !== undefined && <span className="num text-[11px] text-muted">{t("waiting for {n} day(s)", { n: a.ageDays })}</span>}
                    </span>
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        ) : (
          <p className="border border-line p-3 text-sm text-muted">{t("Nothing is blocking and no opportunity or draft is waiting.")}</p>
        )}
      </section>
    </div>
  );
}

/** Command-center briefing panel: greeting, period, deltas and top 5 actions; "Generate now" for members who can run jobs. */
export async function BriefingPanel({ briefing, canRun, back = "/" }: { briefing: BriefingView | null; canRun: boolean; back?: string }) {
  const { t, intl } = await getI18n();
  const generate = canRun ? (
    <form action={generateBriefingAction}>
      <HiddenBack path={back} />
      <button className="eyebrow border border-gold/50 px-2 py-1 text-gold-bright hover:border-gold">{t("Generate now")}</button>
    </form>
  ) : null;
  return (
    <Panel
      className="mb-8"
      eyebrow={t("Briefing")}
      title={<Greeting />}
      actions={
        <>
          <Link href="/briefings" className="eyebrow hover:text-chrome">
            {t("History")}
          </Link>
          {generate}
        </>
      }
    >
      {briefing ? (
        <>
          <p className="mb-4 text-xs text-muted">
            {t("Since {start} until {end} (UTC). Compared with the previous briefing; unconnected sources are shown as such.", { start: fmtDateTime(briefing.periodStart, intl), end: fmtDateTime(briefing.periodEnd, intl) })}
          </p>
          <BriefingBody briefing={briefing} compact />
        </>
      ) : (
        <p className="text-sm text-muted">{t("No briefing yet. Beacon generates one every day; use Generate now to create the first one.")}</p>
      )}
    </Panel>
  );
}
