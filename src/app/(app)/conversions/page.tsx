import type { Metadata } from "next";
import Link from "next/link";
import { eq, sql } from "drizzle-orm";
import { Badge, EmptyState, Flash, KV, PageHeader, Panel, Table, Td, Th, formatValue, ResponsiveTable } from "@/components/ui";
import { FunnelBars } from "@/components/charts/bars";
import { FilterBar, SelectFilter } from "@/components/shell/filters";
import { RangePicker } from "@/components/shell/product-tabs";
import { buildFunnel, type FunnelStep } from "@/core/conversions/funnel";
import { ATTRIBUTION_MODELS, DEFAULT_ATTRIBUTION, MODEL_RULES, type AttributionModel } from "@/core/attribution/attribution";
import { CANONICAL_EVENTS, LEGACY_ALIASES } from "@/core/conversions/events";
import { channelEnum, products } from "@/db/schema";
import { availability, contentPerformance, conversionsByChannel, funnelCounts, hasConversionEvents } from "@/services/metrics";
import { conversionList, creditedTotals } from "@/services/attribution";
import { journey, type LinkLabel } from "@/services/journey";
import { daysParam, pageData, sp1, type SP } from "@/lib/page";
import { enumLabel, type Locale, type T } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Conversions") };
}

const CHANNELS = channelEnum.enumValues;
type ChannelValue = (typeof CHANNELS)[number];

const CLASSIFICATION_ORDER = [
  "Referral code → AFFILIATE if the code is owned by an affiliate, otherwise REFERRAL",
  "utm_source=beacon-cross-sell → CROSS_SELL",
  "utm_medium in (cpc, ppc, paid, paid_social, display) → PAID",
  "utm_medium=email or utm_source=newsletter → EMAIL",
  "Referrer is a known AI assistant (or utm_source names one) → AI_REFERRAL",
  "Referrer is a known search engine → ORGANIC_SEARCH",
  "Referrer or utm_medium is social → SOCIAL",
  "No referrer and no UTM → DIRECT; anything else → OTHER",
  "No touch at all in the lookback window → UNATTRIBUTED (distinct from DIRECT)",
];

const EVENT_HELP: Record<string, string> = {
  PAGE_VIEW: "Browser tracker, automatic on every page load and SPA navigation.",
  CTA_CLICK: "Browser tracker, on links marked with data-beacon-cta.",
  PRODUCT_VIEWED: "Browser or server event when a product or pricing page is viewed.",
  SIGNUP_STARTED: "Browser or server event when the signup form is started.",
  SIGNUP_COMPLETED: "Server event when an account is created.",
  TRIAL_STARTED: "Server event when a trial begins.",
  ACTIVATION_COMPLETED: "Server event when the user reaches the product’s activation milestone.",
  CHECKOUT_STARTED: "Server event when checkout is opened.",
  SUBSCRIPTION_STARTED: "Server event when a paid subscription starts.",
  SUBSCRIPTION_UPGRADED: "Server event on plan upgrade (not part of the acquisition funnel).",
  SUBSCRIPTION_CANCELLED: "Server event on cancellation (not part of the acquisition funnel).",
};

const MODEL_LABEL: Record<AttributionModel, string> = { FIRST_TOUCH: "First touch", LAST_TOUCH: "Last non-direct touch", LINEAR: "Linear", POSITION_BASED: "Position-based (40/20/40)" };
const PAGE_SIZE = 25;

const rate = (a: number, b: number) => (b > 0 ? a / b : null);

/** Channel label; PAID is the acquisition channel here, not the commission status. */
function channelLabel(t: T, locale: Locale, c: string) {
  return c === "PAID" && locale !== "en" ? t("PAID ADS") : enumLabel(t, c);
}

export default async function ConversionsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { t, intl, locale } = await getI18n();
  const pct = (v: number | null) => (v === null ? t("n/a") : formatValue(v, "percent", undefined, intl));
  const ch = (c: string) => channelLabel(t, locale, c);
  const num = (v: number) => formatValue(v, "count", undefined, intl);
  const days = daysParam(sp);
  const rawChannel = sp1(sp, "channel");
  const f = { product: sp1(sp, "product"), channel: CHANNELS.includes(rawChannel as ChannelValue) ? (rawChannel as ChannelValue) : undefined };
  const rawModel = sp1(sp, "model");
  const page = Math.max(1, Math.min(10_000, Number(sp1(sp, "page")) || 1));

  const { data, ctx } = await pageData(async (tx, ctx) => {
    const org = ctx.org.id;
    const prods = await tx.select({ id: products.id, slug: products.slug, name: products.name }).from(products).where(eq(products.organizationId, org)).orderBy(products.name);
    const product = f.product ? prods.find((p) => p.slug === f.product) : undefined;
    const productFilter = product ? sql`and product_id = ${product.id}` : sql``;
    const channelFilter = f.channel ? sql`and channel = ${f.channel}` : sql``;

    const anyEvents = await hasConversionEvents(tx, org);
    const hasKey = anyEvents ? true : (await availability(tx, org, null)).trackerKey;
    const counts = await funnelCounts(tx, org, days, product?.id ?? null, f.channel ?? null);
    const byChannel = await conversionsByChannel(tx, org, days, product?.id ?? null);
    const ctas = (
      await tx.execute<{ cta_id: string | null; page_path: string | null; clicks: number }>(sql`
      select cta_id, page_path, count(*)::int as clicks
      from conversion_events
      where organization_id = ${org} and type = 'CTA_CLICK' and occurred_at >= now() - make_interval(days => ${days}) ${productFilter} ${channelFilter}
      group by 1, 2 order by 3 desc limit 20`)
    ).rows.map((r) => ({ ...r, clicks: Number(r.clicks) }));
    const content = (await contentPerformance(tx, org, days)).filter((c) => !product || c.product === product.slug);
    const model: AttributionModel = ATTRIBUTION_MODELS.includes(rawModel as AttributionModel) ? (rawModel as AttributionModel) : (ctx.org.settings.attribution?.model ?? DEFAULT_ATTRIBUTION.model);
    const credited = await creditedTotals(tx, org, { days, productId: product?.id ?? null, model });
    const list = await conversionList(tx, org, { days, productId: product?.id ?? null, model, page, pageSize: PAGE_SIZE });
    const paths = await journey(tx, org, { days, productId: product?.id ?? null, limit: 20 });
    return { paths, prods, product, anyEvents, hasKey, funnel: buildFunnel(counts as Partial<Record<FunnelStep, number>>), byChannel, ctas, content, model, credited, list };
  });

  const qs = new URLSearchParams(Object.entries({ product: f.product, channel: f.channel }).filter(([, v]) => v) as [string, string][]).toString();
  const base = qs ? `/conversions?${qs}` : "/conversions";
  const rules = ctx.org.settings.attribution ?? DEFAULT_ATTRIBUTION;
  const model = data.model;
  const withParams = (extra: Record<string, string | number | undefined>) => {
    const q = new URLSearchParams(Object.entries({ product: f.product, channel: f.channel, days: String(days), model, ...extra }).filter(([, v]) => v !== undefined && v !== "").map(([k, v]) => [k, String(v)]));
    return `/conversions?${q.toString()}`;
  };
  const money = (cents: number, currency: string) => formatValue(cents, "money", currency, intl);
  const when = (iso: string) => new Date(iso).toLocaleString(intl, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const linkLabel = (l: LinkLabel) => t(l);
  const touchLabel = (x: { channel: string; referrerHost: string | null; source: string | null } | null) => (x ? [ch(x.channel), x.source ?? x.referrerHost].filter(Boolean).join(" · ") : t("n/a"));
  const trackingHref = data.product ? `/products/${data.product.slug}/tracking` : data.prods[0] ? `/products/${data.prods[0].slug}/tracking` : "/products";

  const best = data.content.reduce<(typeof data.content)[number] | null>((b, c) => (c.views > 0 && (!b || c.signups > b.signups || (c.signups === b.signups && c.cta > b.cta)) ? c : b), null);
  const isUnder = (c: { views: number; cta: number }) => c.views >= 100 && c.cta === 0;

  return (
    <>
      <PageHeader
        eyebrow={t("09 / Conversions")}
        title={t("Conversion engine")}
        description={t("From first page view to paid subscription, measured from first-party Beacon events. Rates without a denominator are shown as n/a, never 0%.")}
        actions={<RangePicker base={base} days={days} />}
      />
      <Flash searchParams={sp} />

      <FilterBar action="/conversions">
        <input type="hidden" name="days" value={days} />
        <SelectFilter name="product" label={t("Product")} all={t("All")} value={f.product} options={data.prods.map((p) => ({ value: p.slug, label: p.name }))} />
        <SelectFilter name="channel" label={t("Channel")} all={t("All")} value={f.channel} options={CHANNELS.map((c) => ({ value: c, label: ch(c) }))} />
      </FilterBar>

      {!data.anyEvents ? (
        <EmptyState
          variant={data.hasKey === false ? "not_connected" : "no_data_yet"}
          what={t("No conversion events yet")}
          why={data.hasKey ? t("A tracking key exists but no event has arrived yet. Check that the snippet is installed on the product site.") : t("No tracking key yet: Beacon cannot receive first-party events.")}
          action={{ label: t("Open Tracking setup →"), href: trackingHref }}
        >
          {t("Beacon has not received any first-party events. Install the browser tracker (page views and CTA clicks) and send lifecycle events (signup → subscription) from your server using the snippets on a product’s Tracking tab. Nothing on this page is estimated.")}
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
            <Panel eyebrow={t("Funnel · last {days} days", { days })} title={`${data.product?.name ?? t("All products")} · ${f.channel ? ch(f.channel) : t("all channels")}`}>
              <FunnelBars steps={data.funnel.map((s) => ({ ...s, step: enumLabel(t, s.step) }))} />
              <p className="mt-4 text-[11px] text-muted">{t("Cohort: people first seen in the last {days} days, and how many of them reached each step since. With a channel filter, the cohort is people whose first event came from that channel.", { days })}</p>
            </Panel>
            <Panel eyebrow={t("Funnel")} title={t("Conversion from first page view")} pad={false}>
              <ResponsiveTable>
                <thead>
                  <tr>
                    <Th>{t("Step")}</Th>
                    <Th className="text-right">{t("Unique")}</Th>
                    <Th className="text-right">{t("From start")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.funnel.map((s) => (
                    <tr key={s.step}>
                      <Td primary className="text-xs">{enumLabel(t, s.step)}</Td>
                      <Td label={t("Unique")} className="num text-right text-platinum">{num(s.visitors)}</Td>
                      <Td label={t("From start")} className="num text-right text-xs">{pct(s.conversionFromStart)}</Td>
                    </tr>
                  ))}
                </tbody>
              </ResponsiveTable>
            </Panel>
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-2">
            <Panel eyebrow={t("Acquisition · last {days} days", { days })} title={t("Conversions by channel")} pad={false}>
              {data.byChannel.length ? (
                <ResponsiveTable>
                  <thead>
                    <tr>
                      <Th>{t("Channel")}</Th>
                      <Th className="text-right">{t("Visitors")}</Th>
                      <Th className="text-right">{t("Signups")}</Th>
                      <Th className="text-right">{t("Subscriptions")}</Th>
                      <Th className="text-right">{t("Signup rate")}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byChannel.map((r) => (
                      <tr key={r.channel}>
                        <Td primary>
                          <Badge tone={r.channel === "UNCLASSIFIED" ? "muted" : "neutral"}>{ch(r.channel)}</Badge>
                        </Td>
                        <Td label={t("Visitors")} className="num text-right text-platinum">{num(r.visitors)}</Td>
                        <Td label={t("Signups")} className="num text-right">{num(r.signups)}</Td>
                        <Td label={t("Subscriptions")} className="num text-right">{num(r.subs)}</Td>
                        <Td label={t("Signup rate")} className="num text-right text-xs">{pct(rate(r.signups, r.visitors))}</Td>
                      </tr>
                    ))}
                  </tbody>
                </ResponsiveTable>
              ) : (
                <p className="p-4 text-sm text-muted">{t("No events in this period.")}</p>
              )}
              <p className="border-t border-line px-4 py-2 text-[11px] text-muted">{t("Product filter applies; the channel filter does not (this table is the channel breakdown).")}</p>
            </Panel>

            <Panel eyebrow={t("CTA performance · last {days} days", { days })} title={t("Top 20 calls to action")} pad={false}>
              {data.ctas.length ? (
                <ResponsiveTable>
                  <thead>
                    <tr>
                      <Th>{t("CTA")}</Th>
                      <Th>{t("Page")}</Th>
                      <Th className="text-right">{t("Clicks")}</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.ctas.map((c, i) => (
                      <tr key={`${c.cta_id ?? ""}|${c.page_path ?? ""}|${i}`}>
                        <Td primary className="num text-xs text-platinum">{c.cta_id ?? <span className="text-muted">{t("unnamed")}</span>}</Td>
                        <Td label={t("Page")} className="num text-xs">{c.page_path ?? t("n/a")}</Td>
                        <Td label={t("Clicks")} className="num text-right text-platinum">{num(c.clicks)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </ResponsiveTable>
              ) : (
                <p className="p-4 text-sm text-muted">
                  {t("No CTA clicks recorded. Mark conversion links with")} <code className="text-chrome">data-beacon-cta</code> {t("(see the")} <Link href={trackingHref} className="text-blue-bright hover:text-cyan">{t("Tracking tab")}</Link>).
                </p>
              )}
            </Panel>
          </div>
        </>
      )}

      {data.anyEvents && (
        <>
          <Panel
            eyebrow={t("Attribution model: {model}", { model: t(MODEL_LABEL[model]) })}
            title={t("Credited conversions and revenue by channel · last {days} days", { days })}
            className="mt-6"
            pad={false}
            actions={
              <nav aria-label={t("Attribution model")} className="flex flex-wrap gap-1">
                {ATTRIBUTION_MODELS.map((m) => (
                  <Link key={m} href={withParams({ model: m, page: undefined })} aria-current={m === model ? "page" : undefined} className={`inline-flex min-h-10 items-center border px-2 py-1 text-[11px] md:min-h-0 ${m === model ? "border-blue-bright text-platinum" : "border-line text-muted hover:text-chrome"}`}>
                    {t(MODEL_LABEL[m])}
                  </Link>
                ))}
              </nav>
            }
          >
            {data.credited.length ? (
              <ResponsiveTable>
                <thead>
                  <tr>
                    <Th>{t("Channel")}</Th>
                    <Th className="text-right">{t("Credited conversions")}</Th>
                    <Th className="text-right">{t("Credited revenue")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.credited.map((r) => (
                    <tr key={r.channel}>
                      <Td primary>
                        <Badge tone={r.channel === "UNATTRIBUTED" ? "muted" : "neutral"}>{ch(r.channel)}</Badge>
                      </Td>
                      <Td label={t("Credited conversions")} className="num text-right text-platinum">{formatValue(r.conversions, "count", undefined, intl)}</Td>
                      <Td label={t("Credited revenue")} className="num text-right text-xs">{r.revenue.length ? r.revenue.map((v) => money(v.cents, v.currency)).join(" · ") : t("n/a")}</Td>
                    </tr>
                  ))}
                </tbody>
              </ResponsiveTable>
            ) : (
              <p className="p-4 text-sm text-muted">{t("No conversion credited in this period.")}</p>
            )}
            <p className="border-t border-line px-4 py-2 text-[11px] text-muted">
              {t(MODEL_RULES[model])} {t("Fractional values are shares of conversions split across touches. Attribution shows which touches preceded a conversion: correlation, not causation.")}
            </p>
          </Panel>

          <Panel eyebrow={t("Attribution model: {model}", { model: t(MODEL_LABEL[model]) })} title={t("Conversions · {n} in the last {days} days", { n: data.list.total, days })} className="mt-6" pad={false}>
            {data.list.items.length ? (
              <ResponsiveTable>
                <thead>
                  <tr>
                    <Th>{t("When")}</Th>
                    <Th>{t("Event")}</Th>
                    <Th>{t("Source / medium / campaign")}</Th>
                    <Th>{t("Landing page")}</Th>
                    <Th>{t("First touch")}</Th>
                    <Th>{t("Credited touch (rule)")}</Th>
                    <Th>{t("Model credit")}</Th>
                    <Th className="text-right">{t("Value")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.list.items.map((r) => (
                    <tr key={r.id}>
                      <Td primary className="num text-xs">{when(r.occurredAt)}</Td>
                      <Td label={t("Event")} className="text-xs">
                        {enumLabel(t, r.type)}
                        <div className="text-[11px] text-muted">{r.product ?? t("n/a")}</div>
                      </Td>
                      <Td label={t("Source / medium / campaign")} className="num text-xs">
                        {[r.source, r.medium, r.campaign].some(Boolean) ? [r.source ?? "-", r.medium ?? "-", r.campaign ?? "-"].join(" / ") : (r.referrerHost ?? t("n/a"))}
                        {r.campaignName && <div className="text-[11px] text-muted">{t("Campaign: {name}", { name: r.campaignName })}</div>}
                      </Td>
                      <Td label={t("Landing page")} className="num max-w-56 truncate text-xs" title={r.landingUrl ?? undefined}>
                        {r.landingUrl ? r.landingUrl.replace(/^https?:\/\//, "") : t("n/a")}
                      </Td>
                      <Td label={t("First touch")} className="text-xs">
                        {touchLabel(r.firstTouch)}
                        {r.firstTouch && <div className="text-[11px] text-muted">{when(r.firstTouch.at)}</div>}
                      </Td>
                      <Td label={t("Credited touch (rule)")} className="text-xs">
                        {r.channel ? ch(r.channel) : t("n/a")}
                        <div className="text-[11px] text-muted">{r.rule ? t(r.rule) : t("n/a")}</div>
                      </Td>
                      <Td label={t("Model credit")} className="text-[11px]">{r.credits.length ? r.credits.map((c) => `${ch(c.channel)} ${formatValue(c.weight, "percent", undefined, intl)}`).join(", ") : t("n/a")}</Td>
                      <Td label={t("Value")} className="num text-right text-xs">{r.value.length ? r.value.map((v) => money(v.cents, v.currency)).join(" · ") : t("n/a")}</Td>
                    </tr>
                  ))}
                </tbody>
              </ResponsiveTable>
            ) : (
              <p className="p-4 text-sm text-muted">{t("No conversion (signup, trial, activation, checkout or subscription) in this period.")}</p>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line px-4 py-2 text-[11px] text-muted">
              <span>{t("Value: measured revenue of the same customer in the same product, per currency. Credited touch: the persisted single-touch decision (organisation model and referral precedence).")}</span>
              {data.list.pages > 1 && (
                <span className="flex items-center gap-3">
                  {page > 1 && (
                    <Link href={withParams({ page: page - 1 })} className="text-blue-bright hover:text-cyan">
                      {t("← Newer")}
                    </Link>
                  )}
                  <span className="num">{t("Page {page} of {pages}", { page, pages: data.list.pages })}</span>
                  {page < data.list.pages && (
                    <Link href={withParams({ page: page + 1 })} className="text-blue-bright hover:text-cyan">
                      {t("Older →")}
                    </Link>
                  )}
                </span>
              )}
            </div>
          </Panel>
        </>
      )}

      {data.paths.length > 0 && (
        <Panel eyebrow={t("Journey · last {days} days", { days })} title={t("Search → visit → conversion, by landing page")} className="mt-6" pad={false}>
          <ResponsiveTable>
            <thead>
              <tr>
                <Th>{t("Landing page")}</Th>
                <Th className="text-right">{t("Search clicks")}</Th>
                <Th className="text-right">{t("GA4 sessions")}</Th>
                <Th className="text-right">{t("Beacon visitors")}</Th>
                <Th className="text-right">{t("Signups")}</Th>
                <Th>{t("Links")}</Th>
              </tr>
            </thead>
            <tbody>
              {data.paths.map((r) => (
                <tr key={r.path}>
                  <Td primary className="num max-w-56 truncate text-xs" title={r.path}>
                    {r.path}
                  </Td>
                  <Td label={t("Search clicks")} className="num text-right text-xs">{r.search ? num(r.search.clicks) : t("n/a")}</Td>
                  <Td label={t("GA4 sessions")} className="num text-right text-xs">{r.analytics ? num(r.analytics.sessions) : t("n/a")}</Td>
                  <Td label={t("Beacon visitors")} className="num text-right text-xs">{r.beacon ? num(r.beacon.visitors) : t("n/a")}</Td>
                  <Td label={t("Signups")} className="num text-right text-xs">{r.beacon ? num(r.beacon.signups) : t("n/a")}</Td>
                  <Td label={t("Links")} className="text-[11px]">
                    <span title={t("Search Console page ↔ GA4 landing page")}>{t("Search ↔ GA4: {label}", { label: linkLabel(r.links.searchToAnalytics) })}</span>
                    <span className="block" title={t("Beacon landing page → Beacon conversion of the same visitor")}>
                      {t("Visit → conversion: {label}", { label: linkLabel(r.links.beaconToConversion) })}
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
          <p className="border-t border-line px-4 py-2 text-[11px] text-muted">
            {t("MEASURED: same system and same visitor. MODELLED: joined on the page path only (the people behind the numbers may differ). UNKNOWN: one side has no data. Search Console, GA4 and Beacon count differently; their numbers are shown side by side, never added.")}
          </p>
        </Panel>
      )}

      <Panel eyebrow={t("Content performance · last {days} days", { days })} title={t("Published content → CTA clicks → signups")} className="mt-6" pad={false}>
        {data.content.length ? (
          <ResponsiveTable>
            <thead>
              <tr>
                <Th>{t("Asset")}</Th>
                <Th>{t("Path")}</Th>
                <Th className="text-right">{t("Views")}</Th>
                <Th className="text-right">{t("CTA clicks")}</Th>
                <Th className="text-right">{t("Signups")}</Th>
                <Th className="text-right">{t("CTA rate")}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {data.content.map((c) => (
                <tr key={c.id}>
                  <Td primary>
                    <Link href={`/content/${c.id}`} className="text-platinum hover:text-blue-bright">
                      {c.title}
                    </Link>
                    <div className="text-[11px] text-muted">
                      {enumLabel(t, c.type).toLocaleLowerCase(intl)} · {c.product ?? t("ecosystem")}
                    </div>
                  </Td>
                  <Td label={t("Path")} className="num text-xs">{c.path ?? t("n/a")}</Td>
                  <Td label={t("Views")} className="num text-right text-platinum">{num(c.views)}</Td>
                  <Td label={t("CTA clicks")} className="num text-right">{num(c.cta)}</Td>
                  <Td label={t("Signups")} className="num text-right">{num(c.signups)}</Td>
                  <Td label={t("CTA rate")} className="num text-right text-xs">{pct(rate(c.cta, c.views))}</Td>
                  <Td>
                    {best?.id === c.id && <Badge tone="gold">{t("Best")}</Badge>}
                    {isUnder(c) && (
                      <Badge tone="warn" title={t("≥ 100 views and no CTA clicks in this period")}>
                        {t("Underperforming")}
                      </Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        ) : (
          <div className="p-4">
            <EmptyState variant="no_data_yet" what={t("No published content")} why={t("Once content assets are published on a tracked page, their views, CTA clicks and signups appear here.")} action={{ label: t("Open content"), href: "/content" }} />
          </div>
        )}
        <p className="border-t border-line px-4 py-2 text-[11px] text-muted">{t("Best = most signups (then CTA clicks). Underperforming = ≥ 100 views and 0 CTA clicks in the period.")}</p>
      </Panel>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Panel eyebrow={t("Attribution rules")} title={t("How conversions are credited")}>
          <KV
            items={[
              [t("Model"), t(MODEL_LABEL[rules.model])],
              [t("Lookback window"), t("{n} days", { n: rules.lookbackDays })],
              [t("Referral precedence"), rules.referralPrecedence ? t("On: the most recent referral/affiliate touch wins") : t("Off")],
              [t("Source"), ctx.org.settings.attribution ? t("Organisation settings") : t("Default rules (not customised)")],
            ]}
          />
          <div className="eyebrow mb-2 mt-5">{t("Channel classification (first match wins)")}</div>
          <ol className="flex flex-col gap-1 text-xs text-chrome">
            {CLASSIFICATION_ORDER.map((r, i) => (
              <li key={r} className="flex gap-2">
                <span className="num w-4 text-muted">{i + 1}.</span>
                <span>{t(r)}</span>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-[11px] text-muted">{t("Only touches inside the lookback window count. DIRECT touches never override a non-direct touch under last-touch. No qualifying touch → UNATTRIBUTED.")}</p>
        </Panel>
        <Panel eyebrow={t("Setup")} title={t("Supported event types")} pad={false}>
          <Table>
            <tbody>
              {CANONICAL_EVENTS.map((ev) => (
                <tr key={ev}>
                  <Th>{ev}</Th>
                  <Td className="text-xs">
                    {EVENT_HELP[ev] ? t(EVENT_HELP[ev]) : t("n/a")}
                    {Object.entries(LEGACY_ALIASES)
                      .filter(([, c]) => c === ev)
                      .map(([l]) => (
                        <span key={l} className="ml-1 text-muted">
                          {t("(also accepted as {alias})", { alias: l })}
                        </span>
                      ))}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="border-t border-line px-4 py-3 text-xs text-muted">
            {t("Install snippets and API keys live on each product’s")}{" "}
            <Link href={trackingHref} className="text-blue-bright hover:text-cyan">
              {t("Tracking tab")}
            </Link>
            .
          </p>
        </Panel>
      </div>
    </>
  );
}
