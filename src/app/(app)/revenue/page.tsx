import type { Metadata } from "next";
import { inSequence } from "@/db";
import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { Badge, EmptyState, PageHeader, Panel, Stat, Table, Td, Th, formatValue, ResponsiveTable } from "@/components/ui";
import { BarList } from "@/components/charts/bars";
import { RangePicker } from "@/components/shell/product-tabs";
import { products, revenueEvents } from "@/db/schema";
import { BEACON_CHANNELS, kpis, mrrByDimension, revenueByDimension } from "@/services/metrics";
import { daysParam, pageData, type SP } from "@/lib/page";
import { enumLabel, type T } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Revenue") };
}

const BEACON = new Set<string>(BEACON_CHANNELS);
const label = (k: string) => k.replace(/_/g, " ");

export default async function RevenuePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { t, intl, locale } = await getI18n();
  /** Acquisition channel label; PAID is the paid-ads channel here, not the commission status. */
  const ch = (c: string) => (c === "PAID" && locale !== "en" ? t("PAID ADS") : enumLabel(t, c));
  /** Revenue event type, shown with its raw enum value in English. */
  const evType = (v: string) => (locale === "en" ? v : enumLabel(t, v));
  const days = daysParam(sp);
  const { data } = await pageData(async (tx, ctx) => {
    const org = ctx.org.id;
    const [k, mrrChannel, mrrProduct, revChannel, revProduct] = await inSequence([
      () => kpis(tx, org, { days }),
      () => mrrByDimension(tx, org, "channel"),
      () => mrrByDimension(tx, org, "product"),
      () => revenueByDimension(tx, org, "channel", days),
      () => revenueByDimension(tx, org, "product", days),
    ]);
    const recent = await tx
      .select({ e: revenueEvents, productName: products.name })
      .from(revenueEvents)
      .leftJoin(products, eq(products.id, revenueEvents.productId))
      .where(eq(revenueEvents.organizationId, org))
      .orderBy(desc(revenueEvents.occurredAt))
      .limit(50);
    const cur = (
      await tx.execute<{ currency: string }>(sql`
      select currency from revenue_events where organization_id = ${org}
      union select currency from subscriptions where organization_id = ${org} and status in ('ACTIVE','PAST_DUE')
      order by 1`)
    ).rows.map((r) => r.currency);
    const slug = (await tx.select({ slug: products.slug }).from(products).where(eq(products.organizationId, org)).orderBy(products.name).limit(1))[0]?.slug ?? null;
    return { k, mrrChannel, mrrProduct, revChannel, revProduct, recent, currencies: cur, firstSlug: slug };
  });

  const { k } = data;
  const currency = k.currency;
  const money = (v: number, c = currency) => formatValue(v, "money", c, intl);
  const subsHint = (amount: string, n: number, beacon = false) => [t("{amount} · {n} subscription(s)", { amount, n }), ...(beacon ? [t("Beacon channel")] : [])].join(" · ");
  const eventsHint = (amount: string, n: number) => t("{amount} · {n} event(s)", { amount, n });
  const connected = k.revenue.revenue.state === "OK";
  const mixed = data.currencies.length > 1;
  const trackingHref = data.firstSlug ? `/products/${data.firstSlug}/tracking` : "/products";

  return (
    <>
      <PageHeader
        eyebrow={t("11 / Revenue")}
        title={t("Revenue attribution")}
        description={t("MRR, subscriptions and revenue by acquisition channel and product, from provider webhooks and the revenue API. Amounts are recorded in each event’s own currency.")}
        actions={<RangePicker base="/revenue" days={days} />}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label={t("MRR")} kpi={k.revenue.mrr} fmt="money" />
        <Stat label={t("MRR attributable to Beacon")} kpi={k.revenue.beaconMrr} fmt="money" source={t("Beacon channels")} />
        <Stat label={t("ARR")} kpi={k.revenue.arr} fmt="money" />
        <Stat label={t("New subscriptions")} kpi={k.revenue.newSubscriptions} source={t("Last {days} days", { days })} />
        <Stat label={t("Revenue in period")} kpi={k.revenue.revenue} fmt="money" source={t("Last {days} days", { days })} />
        <Stat label={t("New MRR via Beacon")} kpi={k.revenue.beaconNewMrr} fmt="money" source={t("Last {days} days", { days })} />
      </div>

      {mixed && (
        <div role="status" className="mb-6 border border-warn/40 px-4 py-3 text-sm text-warn">
          {t("Multiple currencies recorded ({currencies}). Every amount is shown in its own currency; amounts in different currencies are never converted or added together.", { currencies: data.currencies.join(", ") })}
        </div>
      )}

      {!connected ? (
        <EmptyState
          variant={k.revenue.revenue.state === "NO_DATA_YET" ? "no_data_yet" : "not_connected"}
          what={k.revenue.revenue.state === "NO_DATA_YET" ? t("Revenue source connected, no revenue received yet") : t("No revenue data connected")}
          why={
            <>
              {t("Beacon has not received any revenue events. Connect a Stripe webhook in Settings → Integrations, or post invoices and subscription changes to")} <code className="text-platinum">/api/v1/revenue</code>{" "}
              {t("with a secret key (documented on each product’s Tracking tab). Nothing on this page is estimated.")}
            </>
          }
          action={{ label: t("Connect Stripe webhook →"), href: "/settings/integrations" }}
          secondary={{ label: t("Revenue API on the Tracking tab"), href: trackingHref }}
        />
      ) : (
        <>
          <div className="grid gap-6 xl:grid-cols-2">
            <Panel eyebrow={t("Current MRR")} title={t("MRR by acquisition channel")}>
              <BarList
                rows={data.mrrChannel.map((r) => ({ key: `${r.key}:${r.currency}`, label: ch(r.key), value: r.mrr, hint: subsHint(money(r.mrr, r.currency), r.subs, BEACON.has(r.key)) }))}
                format={(v) => money(v)}
                empty={t("No active subscriptions.")}
              />
              <DimTable t={t} rows={data.mrrChannel.map((r) => ({ key: `${r.key}:${r.currency}`, name: ch(r.key), a: money(r.mrr, r.currency), b: String(r.subs), beacon: BEACON.has(r.key) }))} head={[t("Channel"), t("MRR"), t("Subs")]} caption={t("MRR by channel (table view)")} />
            </Panel>
            <Panel eyebrow={t("Current MRR")} title={t("MRR by product")}>
              <BarList rows={data.mrrProduct.map((r) => ({ key: `${r.key}:${r.currency}`, label: r.key, value: r.mrr, hint: subsHint(money(r.mrr, r.currency), r.subs) }))} format={(v) => money(v)} empty={t("No active subscriptions.")} />
              <DimTable t={t} rows={data.mrrProduct.map((r) => ({ key: `${r.key}:${r.currency}`, name: r.key, a: money(r.mrr, r.currency), b: String(r.subs) }))} head={[t("Product"), t("MRR"), t("Subs")]} caption={t("MRR by product (table view)")} />
            </Panel>
            <Panel eyebrow={t("Last {days} days", { days })} title={t("Revenue by acquisition channel")}>
              <BarList
                rows={data.revChannel.map((r) => ({ key: `${r.key}:${r.currency}`, label: ch(r.key), value: r.revenue, hint: eventsHint(money(r.revenue, r.currency), r.events) }))}
                format={(v) => money(v)}
                empty={t("No revenue events in this period.")}
              />
              <DimTable t={t} rows={data.revChannel.map((r) => ({ key: `${r.key}:${r.currency}`, name: ch(r.key), a: money(r.revenue, r.currency), b: money(r.newMrr, r.currency), c: r.currency, beacon: BEACON.has(r.key) }))} head={[t("Channel"), t("Revenue"), t("MRR Δ"), t("Currency")]} caption={t("Revenue by channel (table view)")} />
            </Panel>
            <Panel eyebrow={t("Last {days} days", { days })} title={t("Revenue by product")}>
              <BarList rows={data.revProduct.map((r) => ({ key: `${r.key}:${r.currency}`, label: r.key, value: r.revenue, hint: eventsHint(money(r.revenue, r.currency), r.events) }))} format={(v) => money(v)} empty={t("No revenue events in this period.")} />
              <DimTable t={t} rows={data.revProduct.map((r) => ({ key: `${r.key}:${r.currency}`, name: r.key, a: money(r.revenue, r.currency), b: money(r.newMrr, r.currency), c: r.currency }))} head={[t("Product"), t("Revenue"), t("MRR Δ"), t("Currency")]} caption={t("Revenue by product (table view)")} />
            </Panel>
          </div>

          <Panel eyebrow={t("Ledger")} title={t("Latest 50 revenue events")} className="mt-6" pad={false}>
            <ResponsiveTable>
              <thead>
                <tr>
                  <Th>{t("Occurred")}</Th>
                  <Th>{t("Product")}</Th>
                  <Th>{t("Type")}</Th>
                  <Th className="text-right">{t("Amount")}</Th>
                  <Th className="text-right">{t("MRR Δ")}</Th>
                  <Th>{t("Currency")}</Th>
                  <Th>{t("Channel")}</Th>
                  <Th>{t("Provider")}</Th>
                  <Th>{t("External ID")}</Th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map(({ e, productName }) => (
                  <tr key={e.id}>
                    <Td primary className="num text-xs">{e.occurredAt.toISOString().slice(0, 16).replace("T", " ")}</Td>
                    <Td label={t("Product")} className="text-xs">{productName ?? t("n/a")}</Td>
                    <Td label={t("Type")}>
                      <Badge tone={e.type === "CHURN" || e.type === "REFUND" ? "crit" : e.type === "NEW" ? "ok" : "neutral"}>{evType(e.type)}</Badge>
                    </Td>
                    <Td label={t("Amount")} className="num text-right text-platinum">{money(e.amountCents, e.currency)}</Td>
                    <Td label={t("MRR Δ")} className={`num text-right text-xs ${e.mrrDeltaCents > 0 ? "text-ok" : e.mrrDeltaCents < 0 ? "text-crit" : "text-muted"}`}>
                      {e.mrrDeltaCents === 0 ? t("n/a") : `${e.mrrDeltaCents > 0 ? "+" : ""}${money(e.mrrDeltaCents, e.currency)}`}
                    </Td>
                    <Td label={t("Currency")} className="num text-xs">{e.currency}</Td>
                    <Td label={t("Channel")}>
                      <Badge tone={BEACON.has(e.channel) ? "gold" : "neutral"}>{ch(e.channel)}</Badge>
                    </Td>
                    <Td label={t("Provider")} className="text-xs">{e.provider}</Td>
                    <Td label={t("External ID")} className="num max-w-48 truncate text-xs">
                      <span title={e.externalId}>{e.externalId}</span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </ResponsiveTable>
          </Panel>
        </>
      )}

      <Panel eyebrow={t("Definitions")} title={t("How revenue is attributed")} className="mt-6">
        <Table>
          <tbody>
            <tr>
              <Th>{t("Attributable to Beacon")}</Th>
              <Td>
                {t("MRR of active and past-due subscriptions whose acquisition channel is one Beacon operates: {channels}. The channel is fixed at acquisition using the organisation’s attribution rules (see", {
                  channels: BEACON_CHANNELS.map((c) => t(label(c).toLowerCase())).join(", "),
                })}{" "}
                <Link href="/conversions" className="text-blue-bright hover:text-cyan">
                  {t("Conversions")}
                </Link>
                {t("). Paid, social, email, direct and other channels are not counted.")}
              </Td>
            </tr>
            <tr>
              <Th>{t("New MRR via Beacon")}</Th>
              <Td>{t("Sum of MRR deltas of revenue events in the period on Beacon channels (new, upgrades, downgrades and churn net out).")}</Td>
            </tr>
            <tr>
              <Th>{t("ARR")}</Th>
              <Td>{t("Current MRR × 12.")}</Td>
            </tr>
            <tr>
              <Th>{t("Currencies")}</Th>
              <Td>{t("Money is stored in minor units (cents) in each event’s own currency and is never converted. Totals are computed per currency; tiles list each currency separately when more than one is recorded.")}</Td>
            </tr>
          </tbody>
        </Table>
      </Panel>
    </>
  );
}

function DimTable({ t, rows, head, caption }: { t: T; rows: { key: string; name: string; a: string; b: string; c?: string; beacon?: boolean }[]; head: string[]; caption: string }) {
  if (!rows.length) return null;
  return (
    <details className="mt-4 border-t border-line pt-3">
      <summary className="eyebrow cursor-pointer text-chrome">{t("Table view")}</summary>
      <Table>
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {head.map((h, i) => (
              <Th key={h} className={i > 0 && i < 3 ? "text-right" : undefined}>
                {h}
              </Th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <Td className="text-xs">
                {r.name} {r.beacon && <Badge tone="gold">Beacon</Badge>}
              </Td>
              <Td className="num text-right text-platinum">{r.a}</Td>
              <Td className="num text-right text-xs">{r.b}</Td>
              {r.c !== undefined && <Td className="num text-xs">{r.c}</Td>}
            </tr>
          ))}
        </tbody>
      </Table>
    </details>
  );
}
