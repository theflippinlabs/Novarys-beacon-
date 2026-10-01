import type { Metadata } from "next";
import Link from "next/link";
import { eq, sql } from "drizzle-orm";
import { Badge, EmptyState, Flash, KV, LinkButton, PageHeader, Panel, Table, Td, Th, formatValue } from "@/components/ui";
import { FunnelBars } from "@/components/charts/bars";
import { FilterBar, SelectFilter } from "@/components/shell/filters";
import { RangePicker } from "@/components/shell/product-tabs";
import { buildFunnel, type FunnelStep } from "@/core/conversions/funnel";
import { DEFAULT_ATTRIBUTION } from "@/core/attribution/attribution";
import { channelEnum, conversionEventEnum, products } from "@/db/schema";
import { contentPerformance, conversionsByChannel, funnelCounts, hasConversionEvents } from "@/services/metrics";
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
];

const EVENT_HELP: Record<string, string> = {
  PAGE_VIEW: "Browser tracker, automatic on every page load.",
  CTA_CLICK: "Browser tracker, on links marked with data-beacon-cta.",
  SIGNUP: "Server event when an account is created.",
  TRIAL_STARTED: "Server event when a trial begins.",
  ACTIVATED: "Server event when the user reaches the product’s activation milestone.",
  CHECKOUT_STARTED: "Server event when checkout is opened.",
  SUBSCRIBED: "Server event when a paid subscription starts.",
  UPGRADED: "Server event on plan upgrade (not part of the acquisition funnel).",
  CANCELLED: "Server event on cancellation (not part of the acquisition funnel).",
};

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

  const { data, ctx } = await pageData(async (tx, ctx) => {
    const org = ctx.org.id;
    const prods = await tx.select({ id: products.id, slug: products.slug, name: products.name }).from(products).where(eq(products.organizationId, org)).orderBy(products.name);
    const product = f.product ? prods.find((p) => p.slug === f.product) : undefined;
    const productFilter = product ? sql`and product_id = ${product.id}` : sql``;
    const channelFilter = f.channel ? sql`and channel = ${f.channel}` : sql``;

    const anyEvents = await hasConversionEvents(tx, org);
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
    return { prods, product, anyEvents, funnel: buildFunnel(counts as Partial<Record<FunnelStep, number>>), byChannel, ctas, content };
  });

  const qs = new URLSearchParams(Object.entries({ product: f.product, channel: f.channel }).filter(([, v]) => v) as [string, string][]).toString();
  const base = qs ? `/conversions?${qs}` : "/conversions";
  const rules = ctx.org.settings.attribution ?? DEFAULT_ATTRIBUTION;
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
        <EmptyState title={t("No conversion events yet")} action={<LinkButton variant="gold" href={trackingHref}>{t("Open Tracking setup →")}</LinkButton>}>
          {t("Beacon has not received any first-party events. Install the browser tracker (page views and CTA clicks) and send lifecycle events (signup → subscription) from your server using the snippets on a product’s Tracking tab. Nothing on this page is estimated.")}
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
            <Panel eyebrow={t("Funnel · last {days} days", { days })} title={`${data.product?.name ?? t("All products")} · ${f.channel ? ch(f.channel) : t("all channels")}`}>
              <FunnelBars steps={data.funnel.map((s) => ({ ...s, step: enumLabel(t, s.step) }))} />
              <p className="mt-4 text-[11px] text-muted">{t("Unique people per step (identity when known, otherwise visitor). Right column: conversion from the previous step.")}</p>
            </Panel>
            <Panel eyebrow={t("Funnel")} title={t("Conversion from first page view")} pad={false}>
              <Table>
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
                      <Td className="text-xs">{enumLabel(t, s.step)}</Td>
                      <Td className="num text-right text-platinum">{num(s.visitors)}</Td>
                      <Td className="num text-right text-xs">{pct(s.conversionFromStart)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Panel>
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-2">
            <Panel eyebrow={t("Acquisition · last {days} days", { days })} title={t("Conversions by channel")} pad={false}>
              {data.byChannel.length ? (
                <Table>
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
                        <Td>
                          <Badge tone={r.channel === "UNCLASSIFIED" ? "muted" : "neutral"}>{ch(r.channel)}</Badge>
                        </Td>
                        <Td className="num text-right text-platinum">{num(r.visitors)}</Td>
                        <Td className="num text-right">{num(r.signups)}</Td>
                        <Td className="num text-right">{num(r.subs)}</Td>
                        <Td className="num text-right text-xs">{pct(rate(r.signups, r.visitors))}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <p className="p-4 text-sm text-muted">{t("No events in this period.")}</p>
              )}
              <p className="border-t border-line px-4 py-2 text-[11px] text-muted">{t("Product filter applies; the channel filter does not (this table is the channel breakdown).")}</p>
            </Panel>

            <Panel eyebrow={t("CTA performance · last {days} days", { days })} title={t("Top 20 calls to action")} pad={false}>
              {data.ctas.length ? (
                <Table>
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
                        <Td className="num text-xs text-platinum">{c.cta_id ?? <span className="text-muted">{t("unnamed")}</span>}</Td>
                        <Td className="num text-xs">{c.page_path ?? t("n/a")}</Td>
                        <Td className="num text-right text-platinum">{num(c.clicks)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <p className="p-4 text-sm text-muted">
                  {t("No CTA clicks recorded. Mark conversion links with")} <code className="text-chrome">data-beacon-cta</code> {t("(see the")} <Link href={trackingHref} className="text-blue-bright hover:text-cyan">{t("Tracking tab")}</Link>).
                </p>
              )}
            </Panel>
          </div>
        </>
      )}

      <Panel eyebrow={t("Content performance · last {days} days", { days })} title={t("Published content → CTA clicks → signups")} className="mt-6" pad={false}>
        {data.content.length ? (
          <Table>
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
                  <Td>
                    <Link href={`/content/${c.id}`} className="text-platinum hover:text-blue-bright">
                      {c.title}
                    </Link>
                    <div className="text-[11px] text-muted">
                      {enumLabel(t, c.type).toLocaleLowerCase(intl)} · {c.product ?? t("ecosystem")}
                    </div>
                  </Td>
                  <Td className="num text-xs">{c.path ?? t("n/a")}</Td>
                  <Td className="num text-right text-platinum">{num(c.views)}</Td>
                  <Td className="num text-right">{num(c.cta)}</Td>
                  <Td className="num text-right">{num(c.signups)}</Td>
                  <Td className="num text-right text-xs">{pct(rate(c.cta, c.views))}</Td>
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
          </Table>
        ) : (
          <div className="p-4">
            <EmptyState title={t("No published content")}>{t("Once content assets are published on a tracked page, their views, CTA clicks and signups appear here.")}</EmptyState>
          </div>
        )}
        <p className="border-t border-line px-4 py-2 text-[11px] text-muted">{t("Best = most signups (then CTA clicks). Underperforming = ≥ 100 views and 0 CTA clicks in the period.")}</p>
      </Panel>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Panel eyebrow={t("Attribution rules")} title={t("How conversions are credited")}>
          <KV
            items={[
              [t("Model"), rules.model === "LAST_TOUCH" ? t("Last non-direct touch") : t("First touch")],
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
          <p className="mt-3 text-[11px] text-muted">{t("Only touches inside the lookback window count. DIRECT touches never override a non-direct touch under last-touch. No qualifying touch → DIRECT.")}</p>
        </Panel>
        <Panel eyebrow={t("Setup")} title={t("Supported event types")} pad={false}>
          <Table>
            <tbody>
              {conversionEventEnum.enumValues.map((ev) => (
                <tr key={ev}>
                  <Th>{ev}</Th>
                  <Td className="text-xs">{EVENT_HELP[ev] ? t(EVENT_HELP[ev]) : t("n/a")}</Td>
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
