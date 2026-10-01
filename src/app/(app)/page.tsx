import Link from "next/link";
import { EmptyState, HiddenBack, PageHeader, Panel, Stat, formatValue } from "@/components/ui";
import { LineChart } from "@/components/charts/line-chart";
import { LatestBriefing } from "@/components/briefing/latest-briefing";
import { LatestBrain } from "@/components/brain/latest-brain";
import { RangePicker } from "@/components/shell/product-tabs";
import { prioritizeAttention, type AttentionItem } from "@/core/command/attention";
import { BEACON_CHANNELS } from "@/services/metrics";
import { attentionItems, commandCenterData } from "@/services/overview";
import { daysParam, pageData, type SP } from "@/lib/page";
import { recomputeScoreAction } from "@/app/actions/knowledge";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Command center") };
}

export default async function CommandCenter({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const days = daysParam(sp);
  const { data, ctx, can } = await pageData((tx, ctx) => commandCenterData(tx, ctx.org.id, days));
  const { t, intl, locale } = await getI18n();
  const c = data.counts;
  const n = (v: unknown) => Number(v ?? 0);
  const k = data.k;

  const items: AttentionItem[] = attentionItems(data, t);
  const attention = prioritizeAttention(items);
  const channelLabel = (v: string) => (locale === "fr" ? enumLabel(t, v) : v).toLocaleLowerCase(intl);
  const today = new Date().toLocaleDateString(intl, { weekday: "long", day: "numeric", month: "long" });

  return (
    <>
      <PageHeader eyebrow={t("01 / Overview · {date}", { date: today })} title={t("What needs my attention today?")} description={t("{org} ecosystem: {n} product(s). Everything below is measured; unconnected sources are shown as such, never estimated.", { org: ctx.org.branding.displayName ?? ctx.org.name, n: n(c.products) })} actions={<RangePicker base="/" days={days} />} />

      {n(c.products) > 0 && <LatestBriefing />}
      {n(c.products) > 0 && <LatestBrain />}

      {n(c.products) === 0 ? (
        <EmptyState
          variant="not_generated"
          what={t("Start here")}
          why={t("Beacon has no products yet. Onboard a Novarys application: describe it once, connect its data sources, and Beacon builds its query universe, discovery plan, audits and opportunities.")}
          action={{ label: t("Add your first product →"), href: "/products" }}
        />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
          <Panel eyebrow={t("Priority queue")} title={attention.length ? t("{n} item(s), ranked by impact · confidence · effort · urgency", { n: attention.length }) : t("Nothing needs attention")} pad={false}>
            {attention.length ? (
              <ol>
                {attention.map((a, i) => (
                  <li key={a.key} className="border-b border-line/60 last:border-0">
                    <Link href={a.href} className="flex items-start gap-4 px-4 py-3 hover:bg-panel-2">
                      <span className="num w-6 pt-0.5 text-xs text-muted">{String(i + 1).padStart(2, "0")}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-platinum">{a.title}</span>
                        <span className="block truncate text-xs text-muted">{a.detail}</span>
                      </span>
                      <span className="num hidden text-[10px] text-muted sm:block" title={t("impact · confidence · effort · urgency")}>
                        I{a.impact} C{a.confidence} E{a.effort} U{a.urgency}
                      </span>
                      <span className="num w-10 text-right text-xs text-gold">{a.priority}</span>
                    </Link>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="p-4 text-sm text-muted">{t("All clear. Run audits, sync data sources and generate opportunities to surface work.")}</p>
            )}
          </Panel>
          <div className="flex flex-col gap-3">
            <Stat label={t("New attributed MRR · {days}d", { days })} kpi={k.revenue.beaconNewMrr} fmt="money" source={t("Beacon channels")} href="/revenue" />
            <Stat label={t("MRR attributable to Beacon")} kpi={k.revenue.beaconMrr} fmt="money" href="/revenue" />
            <Panel eyebrow={t("Products")} title={t("Beacon scores")} pad={false}>
              <ul>
                {data.products.map((p) => (
                  <li key={p.id} className="flex items-center justify-between border-b border-line/60 px-4 py-2.5 last:border-0">
                    <Link href={`/products/${p.slug}`} className="text-sm text-chrome hover:text-platinum">
                      {p.name}
                    </Link>
                    <span className="flex items-center gap-2">
                      {data.scores.has(p.id) ? (
                        <>
                          <span className="num text-[10px] text-muted">{t("computed {date}", { date: new Date(data.scores.get(p.id)!.computedAt).toISOString().slice(0, 10) })}</span>
                          <span className="num text-sm text-platinum">{Math.round(data.scores.get(p.id)!.total)}</span>
                        </>
                      ) : (
                        <span className="text-xs text-muted">{t("Not computed yet")}</span>
                      )}
                      {can("job:run") && (
                        <form action={recomputeScoreAction}>
                          <HiddenBack path="/" />
                          <input type="hidden" name="productId" value={p.id} />
                          <button className="eyebrow hover:text-chrome" title={t("Recompute")} aria-label={t("Recompute the Beacon Score of {name}", { name: p.name })}>
                            ↻
                          </button>
                        </form>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          </div>
        </div>
      )}

      <section className="mt-10">
        <div className="eyebrow mb-3">{t("Discovery · last {days} days vs previous {days}", { days })}</div>
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label={t("Organic impressions")} kpi={k.discovery.organicImpressions} />
          <Stat label={t("Organic clicks")} kpi={k.discovery.organicClicks} />
          <Stat label={t("Indexable pages")} kpi={k.discovery.indexedPages} />
          <Stat label={t("Covered queries")} kpi={k.discovery.coveredQueries} href="/queries" />
          <Stat label={t("Branded impressions")} kpi={k.discovery.brandedImpressions} />
          <Stat label={t("AI referrals (Beacon tracker)")} kpi={k.discovery.aiReferrals} />
          <Stat label={t("AI referral sessions (GA4)")} kpi={k.discovery.aiReferralSessionsGa4} />
          <Stat label={t("Observed AI mentions")} kpi={k.discovery.aiMentions} href="/ai-visibility" />
        </div>
      </section>

      <section className="mt-8 grid gap-6 xl:grid-cols-2">
        <div>
          <div className="eyebrow mb-3">{t("Acquisition")}</div>
          <div className="grid grid-cols-2 gap-3">
            <Stat label={t("Visitors")} kpi={k.acquisition.visitors} href="/conversions" />
            <Stat label={t("Signups")} kpi={k.acquisition.signups} />
            <Stat label={t("Trials")} kpi={k.acquisition.trials} />
            <Stat label={t("Activations")} kpi={k.acquisition.activations} />
          </div>
        </div>
        <div>
          <div className="eyebrow mb-3">{t("Revenue")}</div>
          <div className="grid grid-cols-2 gap-3">
            <Stat label={t("New subscriptions")} kpi={k.revenue.newSubscriptions} href="/revenue" />
            <Stat label={t("ARR")} kpi={k.revenue.arr} fmt="money" />
            <Stat label={t("Conversion rate")} kpi={k.revenue.conversionRate} fmt="percent" />
            <Stat label={t("Revenue in period")} kpi={k.revenue.revenue} fmt="money" />
          </div>
        </div>
      </section>

      <section className="mt-8 grid gap-6 xl:grid-cols-2">
        <div>
          <div className="eyebrow mb-3">{t("Ecosystem")}</div>
          <div className="grid grid-cols-2 gap-3">
            <Stat label={t("Cross-sell conversion")} kpi={k.ecosystem.crossSellRate} fmt="percent" href="/autopilot#cross-sell" />
            <Stat label={t("Multi-product users")} kpi={k.ecosystem.multiProductUsers} />
            <Stat label={t("Referral conversions")} kpi={k.ecosystem.referralConversions} href="/referrals" />
            <Stat label={t("Affiliate revenue")} kpi={k.ecosystem.affiliateRevenue} fmt="money" />
          </div>
        </div>
        <div>
          <div className="eyebrow mb-3">{t("Content")}</div>
          <div className="grid grid-cols-2 gap-3">
            <Stat label={t("Published assets")} kpi={k.content.published} href="/content" />
            <Stat label={t("Published this period")} kpi={k.content.publishedInPeriod} />
          </div>
        </div>
      </section>

      <Panel eyebrow={t("Trend")} title={t("Visitors, signups & AI referrals · last {days} days", { days })} className="mt-8">
        {k.acquisition.visitors.now === null ? (
          <p className="text-sm text-muted">{t("No first-party events yet. Install the Beacon tracker from a product’s Tracking tab.")}</p>
        ) : (
          <LineChart
            title={t("Daily visitors, signups and AI referrals")}
            series={[
              { key: "v", label: t("Visitors"), color: "var(--color-s1)", points: data.series.map((d) => ({ x: d.day, y: d.visitors })) },
              { key: "s", label: t("Signups"), color: "var(--color-s3)", points: data.series.map((d) => ({ x: d.day, y: d.signups })) },
              { key: "a", label: t("AI referrals"), color: "var(--color-s2)", points: data.series.map((d) => ({ x: d.day, y: d.ai })) },
            ]}
          />
        )}
      </Panel>

      <Panel eyebrow={t("Definitions")} title={t("How these numbers are defined")} className="mt-8">
        <dl className="grid gap-4 text-sm md:grid-cols-[14rem_1fr] md:gap-x-6">
          <dt className="eyebrow pt-0.5">{t("Attributable to Beacon")}</dt>
          <dd className="text-chrome">{t("Revenue whose acquisition channel is {channels} under the organisation’s attribution rules (default: last non-direct touch, 30-day lookback, referral precedence).", { channels: BEACON_CHANNELS.map(channelLabel).join(", ") })}</dd>
          <dt className="eyebrow pt-0.5">{t("AI mentions")}</dt>
          <dd className="text-chrome">{t("Sampled observations from AI-visibility tests run through official APIs. They do not represent every user’s AI response.")}</dd>
          <dt className="eyebrow pt-0.5">{t("Deltas")}</dt>
          <dd className="text-chrome">{t("Current window vs the immediately preceding window of equal length. Example: {value} vs previous shows ▲/▼ percentage.", { value: formatValue(1234, "count", undefined, intl) })}</dd>
        </dl>
      </Panel>
    </>
  );
}
