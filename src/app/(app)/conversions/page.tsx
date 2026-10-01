import Link from "next/link";
import { eq, sql } from "drizzle-orm";
import { Badge, EmptyState, Flash, KV, LinkButton, PageHeader, Panel, Table, Td, Th, formatValue } from "@/components/ui";
import { FunnelBars } from "@/components/charts/bars";
import { FilterBar, SelectFilter } from "@/components/shell/filters";
import { RangePicker } from "@/components/shell/product-tabs";
import { buildFunnel, type FunnelStep } from "@/core/conversions/funnel";
import { DEFAULT_ATTRIBUTION } from "@/core/attribution/attribution";
import { channelEnum, conversionEventEnum, products } from "@/db/schema";
import { contentPerformance, funnelCounts } from "@/services/metrics";
import { daysParam, pageData, sp1, type SP } from "@/lib/page";

export const metadata = { title: "Conversions" };

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
const pct = (v: number | null) => (v === null ? "—" : formatValue(v, "percent"));

export default async function ConversionsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const days = daysParam(sp);
  const rawChannel = sp1(sp, "channel");
  const f = { product: sp1(sp, "product"), channel: CHANNELS.includes(rawChannel as ChannelValue) ? (rawChannel as ChannelValue) : undefined };

  const { data, ctx } = await pageData(async (tx, ctx) => {
    const org = ctx.org.id;
    const prods = await tx.select({ id: products.id, slug: products.slug, name: products.name }).from(products).where(eq(products.organizationId, org)).orderBy(products.name);
    const product = f.product ? prods.find((p) => p.slug === f.product) : undefined;
    const productFilter = product ? sql`and product_id = ${product.id}` : sql``;
    const channelFilter = f.channel ? sql`and channel = ${f.channel}` : sql``;

    const anyEvents = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from (select 1 from conversion_events where organization_id = ${org} limit 1) x`)).rows[0];
    const counts = await funnelCounts(tx, org, days, product?.id ?? null, f.channel ?? null);
    const byChannel = (
      await tx.execute<{ channel: string; visitors: number; signups: number; subs: number }>(sql`
      select coalesce(channel::text, 'UNCLASSIFIED') as channel,
        count(distinct visitor_id) filter (where type = 'PAGE_VIEW')::int as visitors,
        count(*) filter (where type = 'SIGNUP')::int as signups,
        count(*) filter (where type = 'SUBSCRIBED')::int as subs
      from conversion_events
      where organization_id = ${org} and occurred_at >= now() - make_interval(days => ${days}) ${productFilter}
      group by 1 order by 2 desc, 3 desc`)
    ).rows.map((r) => ({ channel: r.channel, visitors: Number(r.visitors), signups: Number(r.signups), subs: Number(r.subs) }));
    const ctas = (
      await tx.execute<{ cta_id: string | null; page_path: string | null; clicks: number }>(sql`
      select cta_id, page_path, count(*)::int as clicks
      from conversion_events
      where organization_id = ${org} and type = 'CTA_CLICK' and occurred_at >= now() - make_interval(days => ${days}) ${productFilter} ${channelFilter}
      group by 1, 2 order by 3 desc limit 20`)
    ).rows.map((r) => ({ ...r, clicks: Number(r.clicks) }));
    const content = (await contentPerformance(tx, org, days)).filter((c) => !product || c.product === product.slug);
    return { prods, product, anyEvents: Number(anyEvents?.n ?? 0) > 0, funnel: buildFunnel(counts as Partial<Record<FunnelStep, number>>), byChannel, ctas, content };
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
        eyebrow="09 / Conversions"
        title="Conversion engine"
        description="From first page view to paid subscription, measured from first-party Beacon events. Rates without a denominator are shown as —, never 0%."
        actions={<RangePicker base={base} days={days} />}
      />
      <Flash searchParams={sp} />

      <FilterBar action="/conversions">
        <input type="hidden" name="days" value={days} />
        <SelectFilter name="product" label="Product" value={f.product} options={data.prods.map((p) => ({ value: p.slug, label: p.name }))} />
        <SelectFilter name="channel" label="Channel" value={f.channel} options={CHANNELS.map((c) => ({ value: c, label: c.replace(/_/g, " ") }))} />
      </FilterBar>

      {!data.anyEvents ? (
        <EmptyState title="No conversion events yet" action={<LinkButton variant="gold" href={trackingHref}>Open Tracking setup →</LinkButton>}>
          Beacon has not received any first-party events. Install the browser tracker (page views and CTA clicks) and send lifecycle events (signup → subscription) from your server using the snippets on a product’s Tracking tab. Nothing on this page is estimated.
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
            <Panel eyebrow={`Funnel · last ${days} days`} title={`${data.product?.name ?? "All products"} · ${f.channel ? f.channel.replace(/_/g, " ") : "all channels"}`}>
              <FunnelBars steps={data.funnel} />
              <p className="mt-4 text-[11px] text-muted">Unique people per step (identity when known, otherwise visitor). Right column: conversion from the previous step.</p>
            </Panel>
            <Panel eyebrow="Funnel" title="Conversion from first page view" pad={false}>
              <Table>
                <thead>
                  <tr>
                    <Th>Step</Th>
                    <Th className="text-right">Unique</Th>
                    <Th className="text-right">From start</Th>
                  </tr>
                </thead>
                <tbody>
                  {data.funnel.map((s) => (
                    <tr key={s.step}>
                      <Td className="text-xs">{s.step.replace(/_/g, " ")}</Td>
                      <Td className="num text-right text-platinum">{formatValue(s.visitors)}</Td>
                      <Td className="num text-right text-xs">{pct(s.conversionFromStart)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Panel>
          </div>

          <div className="mt-6 grid gap-6 xl:grid-cols-2">
            <Panel eyebrow={`Acquisition · last ${days} days`} title="Conversions by channel" pad={false}>
              {data.byChannel.length ? (
                <Table>
                  <thead>
                    <tr>
                      <Th>Channel</Th>
                      <Th className="text-right">Visitors</Th>
                      <Th className="text-right">Signups</Th>
                      <Th className="text-right">Subscriptions</Th>
                      <Th className="text-right">Signup rate</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.byChannel.map((r) => (
                      <tr key={r.channel}>
                        <Td>
                          <Badge tone={r.channel === "UNCLASSIFIED" ? "muted" : "neutral"}>{r.channel.replace(/_/g, " ")}</Badge>
                        </Td>
                        <Td className="num text-right text-platinum">{formatValue(r.visitors)}</Td>
                        <Td className="num text-right">{formatValue(r.signups)}</Td>
                        <Td className="num text-right">{formatValue(r.subs)}</Td>
                        <Td className="num text-right text-xs">{pct(rate(r.signups, r.visitors))}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <p className="p-4 text-sm text-muted">No events in this period.</p>
              )}
              <p className="border-t border-line px-4 py-2 text-[11px] text-muted">Product filter applies; the channel filter does not (this table is the channel breakdown).</p>
            </Panel>

            <Panel eyebrow={`CTA performance · last ${days} days`} title="Top 20 calls to action" pad={false}>
              {data.ctas.length ? (
                <Table>
                  <thead>
                    <tr>
                      <Th>CTA</Th>
                      <Th>Page</Th>
                      <Th className="text-right">Clicks</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.ctas.map((c, i) => (
                      <tr key={`${c.cta_id ?? ""}|${c.page_path ?? ""}|${i}`}>
                        <Td className="num text-xs text-platinum">{c.cta_id ?? <span className="text-muted">unnamed</span>}</Td>
                        <Td className="num text-xs">{c.page_path ?? "—"}</Td>
                        <Td className="num text-right text-platinum">{formatValue(c.clicks)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              ) : (
                <p className="p-4 text-sm text-muted">
                  No CTA clicks recorded. Mark conversion links with <code className="text-chrome">data-beacon-cta</code> — see the <Link href={trackingHref} className="text-gold hover:text-gold-bright">Tracking tab</Link>.
                </p>
              )}
            </Panel>
          </div>
        </>
      )}

      <Panel eyebrow={`Content performance · last ${days} days`} title="Published content → CTA clicks → signups" className="mt-6" pad={false}>
        {data.content.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Asset</Th>
                <Th>Path</Th>
                <Th className="text-right">Views</Th>
                <Th className="text-right">CTA clicks</Th>
                <Th className="text-right">Signups</Th>
                <Th className="text-right">CTA rate</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {data.content.map((c) => (
                <tr key={c.id}>
                  <Td>
                    <Link href={`/content/${c.id}`} className="text-platinum hover:text-gold-bright">
                      {c.title}
                    </Link>
                    <div className="text-[11px] text-muted">
                      {c.type.replace(/_/g, " ").toLowerCase()} · {c.product ?? "ecosystem"}
                    </div>
                  </Td>
                  <Td className="num text-xs">{c.path ?? "—"}</Td>
                  <Td className="num text-right text-platinum">{formatValue(c.views)}</Td>
                  <Td className="num text-right">{formatValue(c.cta)}</Td>
                  <Td className="num text-right">{formatValue(c.signups)}</Td>
                  <Td className="num text-right text-xs">{pct(rate(c.cta, c.views))}</Td>
                  <Td>
                    {best?.id === c.id && <Badge tone="gold">Best</Badge>}
                    {isUnder(c) && (
                      <Badge tone="warn" title="≥ 100 views and no CTA clicks in this period">
                        Underperforming
                      </Badge>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <div className="p-4">
            <EmptyState title="No published content">Once content assets are published on a tracked page, their views, CTA clicks and signups appear here.</EmptyState>
          </div>
        )}
        <p className="border-t border-line px-4 py-2 text-[11px] text-muted">Best = most signups (then CTA clicks). Underperforming = ≥ 100 views and 0 CTA clicks in the period.</p>
      </Panel>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Panel eyebrow="Attribution rules" title="How conversions are credited">
          <KV
            items={[
              ["Model", rules.model === "LAST_TOUCH" ? "Last non-direct touch" : "First touch"],
              ["Lookback window", `${rules.lookbackDays} days`],
              ["Referral precedence", rules.referralPrecedence ? "On — the most recent referral/affiliate touch wins" : "Off"],
              ["Source", ctx.org.settings.attribution ? "Organisation settings" : "Default rules (not customised)"],
            ]}
          />
          <div className="eyebrow mb-2 mt-5">Channel classification (first match wins)</div>
          <ol className="flex flex-col gap-1 text-xs text-chrome">
            {CLASSIFICATION_ORDER.map((r, i) => (
              <li key={r} className="flex gap-2">
                <span className="num w-4 text-muted">{i + 1}.</span>
                <span>{r}</span>
              </li>
            ))}
          </ol>
          <p className="mt-3 text-[11px] text-muted">Only touches inside the lookback window count. DIRECT touches never override a non-direct touch under last-touch. No qualifying touch → DIRECT.</p>
        </Panel>
        <Panel eyebrow="Setup" title="Supported event types" pad={false}>
          <Table>
            <tbody>
              {conversionEventEnum.enumValues.map((t) => (
                <tr key={t}>
                  <Th>{t}</Th>
                  <Td className="text-xs">{EVENT_HELP[t] ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <p className="border-t border-line px-4 py-3 text-xs text-muted">
            Install snippets and API keys live on each product’s{" "}
            <Link href={trackingHref} className="text-gold hover:text-gold-bright">
              Tracking tab
            </Link>
            .
          </p>
        </Panel>
      </div>
    </>
  );
}
