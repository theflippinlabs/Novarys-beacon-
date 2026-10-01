import type { Metadata } from "next";
import type { ReactNode } from "react";
import { eq } from "drizzle-orm";
import { Badge, EmptyState, formatValue, PageHeader, Panel, StatusBadge, Table, Tabs, Td, Th } from "@/components/ui";
import { FilterBar, SelectFilter } from "@/components/shell/filters";
import { products } from "@/db/schema";
import { previousPeriod, resolveRange, type LowCtr, type Movement, type QueryStat } from "@/core/search/insights";
import { SEARCH_PROVIDERS, type SearchProvider } from "@/integrations/registry";
import { getI18n, getT } from "@/i18n/server";
import { pageData, sp1, type SP } from "@/lib/page";
import { searchDataState, searchInsights } from "@/services/search-insights";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Search performance") };
}

const PROVIDER_LABEL: Record<SearchProvider, string> = { GOOGLE_SEARCH_CONSOLE: "Google Search Console", BING_WEBMASTER: "Bing Webmaster Tools" };
const when = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : null);

type Col<T> = { label: string; render: (row: T) => ReactNode; num?: boolean };

/** Table from md up, stacked cards below (mobile). */
function DataList<T>({ rows, cols, rowKey, empty }: { rows: T[]; cols: Col<T>[]; rowKey: (r: T) => string; empty: string }) {
  if (!rows.length) return <p className="p-4 text-sm text-muted">{empty}</p>;
  const [first, ...rest] = cols;
  return (
    <>
      <ul className="flex flex-col divide-y divide-line md:hidden">
        {rows.map((r) => (
          <li key={rowKey(r)} className="p-3">
            <div className="break-words text-sm text-platinum">{first.render(r)}</div>
            <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
              {rest.map((c) => (
                <div key={c.label} className="flex justify-between gap-2">
                  <dt className="text-muted">{c.label}</dt>
                  <dd className="num text-chrome">{c.render(r)}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      <div className="hidden md:block">
        <Table>
          <thead>
            <tr>
              {cols.map((c) => (
                <Th key={c.label} className={c.num ? "text-right" : undefined}>
                  {c.label}
                </Th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={rowKey(r)}>
                {cols.map((c, i) => (
                  <Td key={c.label} className={i === 0 ? "max-w-md break-words text-platinum" : "num text-right"}>
                    {c.render(r)}
                  </Td>
                ))}
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
    </>
  );
}

export default async function SearchPerformancePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { t, intl } = await getI18n();
  const count = (v: number) => formatValue(v, "count", undefined, intl);
  const signed = (v: number) => new Intl.NumberFormat(intl, { signDisplay: "exceptZero", maximumFractionDigits: 0 }).format(v);
  const pct = (v: number | null) => (v === null ? t("n/a") : formatValue(v, "percent", undefined, intl));
  const pos = (v: number | null) => (v === null ? t("n/a") : v.toLocaleString(intl, { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
  const f = { product: sp1(sp, "product"), provider: sp1(sp, "provider"), range: sp1(sp, "range") ?? "28d", start: sp1(sp, "start"), end: sp1(sp, "end") };

  const { data } = await pageData(async (tx, ctx) => {
    const prods = await tx.select().from(products).where(eq(products.organizationId, ctx.org.id)).orderBy(products.name);
    const product = f.product ? prods.find((p) => p.slug === f.product) : undefined;
    const base = { organizationId: ctx.org.id, productId: product?.id ?? null };
    const all = await searchDataState(tx, base);
    const requested = SEARCH_PROVIDERS.find((p) => p === f.provider);
    const provider: SearchProvider = requested ?? (all.integrations.some((i) => i.provider === "GOOGLE_SEARCH_CONSOLE") || !all.integrations.length ? "GOOGLE_SEARCH_CONSOLE" : "BING_WEBMASTER");
    const scope = { ...base, provider };
    const state = await searchDataState(tx, scope);
    if (!state.connected || !state.hasData || !state.lastDay) return { prods, product, provider, state, insights: null, range: null };
    const range = resolveRange({ preset: f.range, start: f.start, end: f.end }, state.lastDay);
    const insights = await searchInsights(tx, scope, range);
    return { prods, product, provider, state, insights, range };
  });

  const { state, insights, range, provider } = data;
  const lastSync = state.integrations.map((i) => i.lastSuccessAt ?? i.lastSyncAt).filter((d): d is Date => Boolean(d)).sort((a, b) => b.getTime() - a.getTime())[0];

  const movementCols = (label: string): Col<Movement>[] => [
    { label, render: (m) => m.key },
    { label: t("Clicks"), num: true, render: (m) => count(m.now?.clicks ?? 0) },
    { label: t("Clicks change"), num: true, render: (m) => <span className={m.clicksDelta > 0 ? "text-ok" : m.clicksDelta < 0 ? "text-crit" : ""}>{signed(m.clicksDelta)}</span> },
    { label: t("Impressions"), num: true, render: (m) => count(m.now?.impressions ?? 0) },
    { label: t("Impressions change"), num: true, render: (m) => <span className={m.impressionsDelta > 0 ? "text-ok" : m.impressionsDelta < 0 ? "text-crit" : ""}>{signed(m.impressionsDelta)}</span> },
    { label: t("Position"), num: true, render: (m) => pos(m.now?.position ?? m.prev?.position ?? null) },
  ];
  const statCols = (label: string, side: "now" | "prev" = "now"): Col<Movement>[] => [
    { label, render: (m) => m.key },
    { label: side === "now" ? t("Impressions") : t("Impressions (previous)"), num: true, render: (m) => count(m[side]?.impressions ?? 0) },
    { label: side === "now" ? t("Clicks") : t("Clicks (previous)"), num: true, render: (m) => count(m[side]?.clicks ?? 0) },
    { label: t("Position"), num: true, render: (m) => pos(m[side]?.position ?? null) },
  ];
  const lowCtrCols: Col<LowCtr>[] = [
    { label: t("Query"), render: (r) => r.key },
    { label: t("Impressions"), num: true, render: (r) => count(r.impressions) },
    { label: t("CTR"), num: true, render: (r) => pct(r.ctr) },
    { label: t("Expected CTR"), num: true, render: (r) => pct(r.expectedCtr) },
    { label: t("Position"), num: true, render: (r) => pos(r.position) },
    { label: t("Bucket"), num: true, render: (r) => r.bucket },
  ];
  const strikingCols: Col<QueryStat>[] = [
    { label: t("Query"), render: (r) => r.key },
    { label: t("Impressions"), num: true, render: (r) => count(r.impressions) },
    { label: t("Clicks"), num: true, render: (r) => count(r.clicks) },
    { label: t("CTR"), num: true, render: (r) => pct(r.ctr) },
    { label: t("Position"), num: true, render: (r) => pos(r.position) },
  ];
  const movementKey = (m: Movement) => m.key;
  const statKey = (r: QueryStat) => r.key;

  return (
    <>
      <PageHeader eyebrow={t("04 / Queries")} title={t("Search performance")} description={t("Measured clicks, impressions, CTR and impressions-weighted positions from your search providers, by day, query and page. Each period is compared with the previous period of the same length.")} />
      <Tabs
        active="search"
        items={[
          { key: "universe", label: t("Query universe"), href: "/queries" },
          { key: "search", label: t("Search performance"), href: "/queries/search" },
        ]}
      />
      <FilterBar action="/queries/search">
        <SelectFilter name="product" label={t("Product")} value={f.product} all={t("All products")} options={data.prods.map((p) => ({ value: p.slug, label: p.name }))} />
        <label className="flex min-w-40 flex-col gap-1">
          <span className="eyebrow">{t("Source")}</span>
          <select name="provider" defaultValue={provider}>
            {SEARCH_PROVIDERS.map((p) => (
              <option key={p} value={p}>
                {PROVIDER_LABEL[p]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-w-32 flex-col gap-1">
          <span className="eyebrow">{t("Period")}</span>
          <select name="range" defaultValue={range?.preset ?? f.range}>
            <option value="7d">{t("Last 7 days")}</option>
            <option value="28d">{t("Last 28 days")}</option>
            <option value="3m">{t("Last 3 months")}</option>
            <option value="6m">{t("Last 6 months")}</option>
            <option value="custom">{t("Custom")}</option>
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="eyebrow">{t("From (custom)")}</span>
          <input type="date" name="start" defaultValue={range?.preset === "custom" ? range.start : f.start} />
        </label>
        <label className="flex flex-col gap-1">
          <span className="eyebrow">{t("To (custom)")}</span>
          <input type="date" name="end" defaultValue={range?.preset === "custom" ? range.end : f.end} />
        </label>
      </FilterBar>

      {!state.connected ? (
        <EmptyState
          variant="not_connected"
          what={t("No {provider} data yet.", { provider: PROVIDER_LABEL[provider] })}
          why={t("No {provider} integration is connected for this scope. Beacon never shows estimated search numbers: connect a source to see measured data.", { provider: PROVIDER_LABEL[provider] })}
          action={{ label: provider === "BING_WEBMASTER" ? t("Connect Bing Webmaster") : t("Connect Google Search Console"), href: "/settings/integrations" }}
        >
          {state.integrations.length > 0 && (
            <ul className="mt-3 flex flex-col gap-1">
              {state.integrations.map((i) => (
                <li key={i.id} className="flex items-center gap-2 text-xs">
                  <StatusBadge status={i.status} />
                  <span className="text-muted">{data.prods.find((p) => p.id === i.productId)?.name ?? t("n/a")}</span>
                </li>
              ))}
            </ul>
          )}
        </EmptyState>
      ) : !insights || !range ? (
        <EmptyState
          variant="no_data_yet"
          what={t("{provider} is connected, no data imported yet.", { provider: PROVIDER_LABEL[provider] })}
          why={t("{provider} is connected. Data appears after the first sync and the history import complete.", { provider: PROVIDER_LABEL[provider] })}
          action={{ label: t("Integration settings"), href: "/settings/integrations" }}
        >
          <div className="text-xs text-muted">{lastSync ? t("Last successful sync: {date}", { date: when(lastSync)! }) : t("Waiting for the first sync.")}</div>
          <ul className="mt-3 flex flex-col gap-1">
            {state.integrations.map((i) => (
              <li key={i.id} className="flex flex-wrap items-center gap-2 text-xs">
                <StatusBadge status={i.status} />
                <span className="text-muted">{data.prods.find((p) => p.id === i.productId)?.name ?? t("n/a")}</span>
                {i.backfillDone ? <Badge tone="ok">{t("History imported")}</Badge> : <Badge tone="muted">{t("History import pending")}</Badge>}
              </li>
            ))}
          </ul>
        </EmptyState>
      ) : (
        <>
          <p className="mb-4 text-xs text-muted">
            {t("{start} to {end}, compared with {prevStart} to {prevEnd}. Latest day with data: {last}.", { start: range.start, end: range.end, prevStart: previousPeriod(range).start, prevEnd: previousPeriod(range).end, last: state.lastDay ?? t("n/a") })}{" "}
            {lastSync && t("Last successful sync: {date}", { date: when(lastSync)! })}
          </p>
          <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
            {[
              { label: t("Clicks"), value: count(insights.totals.now.clicks), prev: count(insights.totals.prev.clicks), d: insights.totals.delta.clicks },
              { label: t("Impressions"), value: count(insights.totals.now.impressions), prev: count(insights.totals.prev.impressions), d: insights.totals.delta.impressions },
              { label: t("CTR"), value: pct(insights.totals.now.ctr), prev: pct(insights.totals.prev.ctr), d: null },
              { label: t("Average position (weighted)"), value: pos(insights.totals.now.position), prev: pos(insights.totals.prev.position), d: null },
            ].map((k) => (
              <div key={k.label} className="border border-line bg-panel p-4">
                <div className="eyebrow">{k.label}</div>
                <div className="num mt-2 text-2xl text-platinum">{k.value}</div>
                <div className="num mt-1 text-[11px] text-muted">
                  {t("Previous: {value}", { value: k.prev })}
                  {k.d !== null && <span className={k.d > 0 ? "ml-2 text-ok" : k.d < 0 ? "ml-2 text-crit" : "ml-2"}>{formatValue(k.d, "percent", undefined, intl)}</span>}
                </div>
              </div>
            ))}
          </div>
          <p className="mb-6 text-[11px] text-muted">{t("Lists only include queries and pages with at least {n} impressions in one of the two periods.", { n: insights.minImpressions })}</p>
          <div className="grid gap-6 xl:grid-cols-2">
            <Panel title={t("Top growing queries")} eyebrow={t("Movement")} pad={false}>
              <DataList rows={insights.growingQueries} cols={movementCols(t("Query"))} rowKey={movementKey} empty={t("No growing queries in this period.")} />
            </Panel>
            <Panel title={t("Top declining queries")} eyebrow={t("Movement")} pad={false}>
              <DataList rows={insights.decliningQueries} cols={movementCols(t("Query"))} rowKey={movementKey} empty={t("No declining queries in this period.")} />
            </Panel>
            <Panel title={t("High impressions, low CTR")} eyebrow={t("CTR")} pad={false}>
              <p className="border-b border-line p-3 text-[11px] text-muted">{t(insights.lowCtrMethod)}</p>
              <DataList rows={insights.lowCtr} cols={lowCtrCols} rowKey={statKey} empty={t("No query below the expected CTR, or not enough queries per position bucket to compute it.")} />
            </Panel>
            <Panel title={t("Positions 4 to 15")} eyebrow={t("Striking distance")} pad={false}>
              <DataList rows={insights.strikingDistance} cols={strikingCols} rowKey={statKey} empty={t("No query with an average position between 4 and 15.")} />
            </Panel>
            <Panel title={t("New queries")} eyebrow={t("Present now, absent before")} pad={false}>
              <DataList rows={insights.newQueries} cols={statCols(t("Query"))} rowKey={movementKey} empty={t("No new queries in this period.")} />
            </Panel>
            <Panel title={t("Lost queries")} eyebrow={t("Present before, absent now")} pad={false}>
              <DataList rows={insights.lostQueries} cols={statCols(t("Query"), "prev")} rowKey={movementKey} empty={t("No lost queries in this period.")} />
            </Panel>
            <Panel title={t("New pages")} eyebrow={t("Pages")} pad={false}>
              <DataList rows={insights.newPages} cols={statCols(t("Page"))} rowKey={movementKey} empty={t("No new pages in this period.")} />
            </Panel>
            <Panel title={t("Declining pages")} eyebrow={t("Pages")} pad={false}>
              <DataList rows={insights.decliningPages} cols={movementCols(t("Page"))} rowKey={movementKey} empty={t("No declining pages in this period.")} />
            </Panel>
          </div>
        </>
      )}
    </>
  );
}
