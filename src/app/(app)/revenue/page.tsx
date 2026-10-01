import Link from "next/link";
import { desc, eq, sql } from "drizzle-orm";
import { Badge, EmptyState, LinkButton, PageHeader, Panel, Stat, Table, Td, Th, formatValue } from "@/components/ui";
import { BarList } from "@/components/charts/bars";
import { RangePicker } from "@/components/shell/product-tabs";
import { products, revenueEvents } from "@/db/schema";
import { BEACON_CHANNELS, kpis, mrrByDimension, revenueByDimension } from "@/services/metrics";
import { daysParam, pageData, type SP } from "@/lib/page";

export const metadata = { title: "Revenue" };

const BEACON = new Set<string>(BEACON_CHANNELS);
const label = (k: string) => k.replace(/_/g, " ");

export default async function RevenuePage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const days = daysParam(sp);
  const { data } = await pageData(async (tx, ctx) => {
    const org = ctx.org.id;
    const [k, mrrChannel, mrrProduct, revChannel, revProduct] = await Promise.all([
      kpis(tx, org, { days }),
      mrrByDimension(tx, org, "channel"),
      mrrByDimension(tx, org, "product"),
      revenueByDimension(tx, org, "channel", days),
      revenueByDimension(tx, org, "product", days),
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
  const money = (v: number, c = currency) => formatValue(v, "money", c);
  const connected = k.revenue.revenue.now !== null;
  const mixed = data.currencies.length > 1;
  const trackingHref = data.firstSlug ? `/products/${data.firstSlug}/tracking` : "/products";

  return (
    <>
      <PageHeader
        eyebrow="11 / Revenue"
        title="Revenue attribution"
        description="MRR, subscriptions and revenue by acquisition channel and product, from provider webhooks and the revenue API. Amounts are recorded in each event’s own currency."
        actions={<RangePicker base="/revenue" days={days} />}
      />

      <div className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat label="MRR" value={k.revenue.mrr.now} fmt="money" currency={currency} source={k.revenue.mrr.source} />
        <Stat label="MRR attributable to Beacon" value={k.revenue.beaconMrr.now} fmt="money" currency={currency} source="Beacon channels" />
        <Stat label="ARR" value={k.revenue.arr.now} fmt="money" currency={currency} source={k.revenue.arr.source} />
        <Stat label="New subscriptions" value={k.revenue.newSubscriptions.now} prev={k.revenue.newSubscriptions.prev} source={`Last ${days} days`} />
        <Stat label="Revenue in period" value={k.revenue.revenue.now} prev={k.revenue.revenue.prev} fmt="money" currency={currency} source={`Last ${days} days`} />
        <Stat label="New MRR via Beacon" value={k.revenue.beaconNewMrr.now} prev={k.revenue.beaconNewMrr.prev} fmt="money" currency={currency} source={`Last ${days} days`} />
      </div>

      {mixed && (
        <div role="status" className="mb-6 border border-warn/40 px-4 py-3 text-sm text-warn">
          Multiple currencies recorded ({data.currencies.join(", ")}). The tiles and per-channel/per-product totals above add amounts without conversion and label them in {currency}; use the per-event table below for exact per-currency figures.
        </div>
      )}

      {!connected ? (
        <EmptyState
          title="No revenue data connected"
          action={
            <div className="flex flex-wrap gap-2">
              <LinkButton variant="gold" href="/settings/integrations">
                Connect Stripe webhook →
              </LinkButton>
              <LinkButton href={trackingHref}>Revenue API on the Tracking tab</LinkButton>
            </div>
          }
        >
          Beacon has not received any revenue events. Connect a Stripe webhook in Settings → Integrations, or post invoices and subscription changes to <code className="text-platinum">/api/v1/revenue</code> with a secret key (documented on each product’s Tracking tab). Nothing on this page is estimated.
        </EmptyState>
      ) : (
        <>
          <div className="grid gap-6 xl:grid-cols-2">
            <Panel eyebrow="Current MRR" title="MRR by acquisition channel">
              <BarList
                rows={data.mrrChannel.map((r) => ({ key: `${r.key}:${r.currency}`, label: label(r.key), value: r.mrr, hint: `${money(r.mrr, r.currency)} · ${r.subs} subscription(s)${BEACON.has(r.key) ? " · Beacon channel" : ""}` }))}
                format={(v) => money(v)}
                empty="No active subscriptions."
              />
              <DimTable rows={data.mrrChannel.map((r) => ({ key: `${r.key}:${r.currency}`, name: label(r.key), a: money(r.mrr, r.currency), b: String(r.subs), beacon: BEACON.has(r.key) }))} head={["Channel", "MRR", "Subs"]} caption="MRR by channel (table view)" />
            </Panel>
            <Panel eyebrow="Current MRR" title="MRR by product">
              <BarList rows={data.mrrProduct.map((r) => ({ key: `${r.key}:${r.currency}`, label: r.key, value: r.mrr, hint: `${money(r.mrr, r.currency)} · ${r.subs} subscription(s)` }))} format={(v) => money(v)} empty="No active subscriptions." />
              <DimTable rows={data.mrrProduct.map((r) => ({ key: `${r.key}:${r.currency}`, name: r.key, a: money(r.mrr, r.currency), b: String(r.subs) }))} head={["Product", "MRR", "Subs"]} caption="MRR by product (table view)" />
            </Panel>
            <Panel eyebrow={`Last ${days} days`} title="Revenue by acquisition channel">
              <BarList
                rows={data.revChannel.map((r) => ({ key: `${r.key}:${r.currency}`, label: label(r.key), value: r.revenue, hint: `${money(r.revenue, r.currency)} · ${r.events} event(s)` }))}
                format={(v) => money(v)}
                empty="No revenue events in this period."
              />
              <DimTable rows={data.revChannel.map((r) => ({ key: `${r.key}:${r.currency}`, name: label(r.key), a: money(r.revenue, r.currency), b: money(r.newMrr, r.currency), c: r.currency, beacon: BEACON.has(r.key) }))} head={["Channel", "Revenue", "MRR Δ", "Currency"]} caption="Revenue by channel (table view)" />
            </Panel>
            <Panel eyebrow={`Last ${days} days`} title="Revenue by product">
              <BarList rows={data.revProduct.map((r) => ({ key: `${r.key}:${r.currency}`, label: r.key, value: r.revenue, hint: `${money(r.revenue, r.currency)} · ${r.events} event(s)` }))} format={(v) => money(v)} empty="No revenue events in this period." />
              <DimTable rows={data.revProduct.map((r) => ({ key: `${r.key}:${r.currency}`, name: r.key, a: money(r.revenue, r.currency), b: money(r.newMrr, r.currency), c: r.currency }))} head={["Product", "Revenue", "MRR Δ", "Currency"]} caption="Revenue by product (table view)" />
            </Panel>
          </div>

          <Panel eyebrow="Ledger" title="Latest 50 revenue events" className="mt-6" pad={false}>
            <Table>
              <thead>
                <tr>
                  <Th>Occurred</Th>
                  <Th>Product</Th>
                  <Th>Type</Th>
                  <Th className="text-right">Amount</Th>
                  <Th className="text-right">MRR Δ</Th>
                  <Th>Currency</Th>
                  <Th>Channel</Th>
                  <Th>Provider</Th>
                  <Th>External ID</Th>
                </tr>
              </thead>
              <tbody>
                {data.recent.map(({ e, productName }) => (
                  <tr key={e.id}>
                    <Td className="num text-xs">{e.occurredAt.toISOString().slice(0, 16).replace("T", " ")}</Td>
                    <Td className="text-xs">{productName ?? "—"}</Td>
                    <Td>
                      <Badge tone={e.type === "CHURN" || e.type === "REFUND" ? "crit" : e.type === "NEW" ? "ok" : "neutral"}>{e.type}</Badge>
                    </Td>
                    <Td className="num text-right text-platinum">{money(e.amountCents, e.currency)}</Td>
                    <Td className={`num text-right text-xs ${e.mrrDeltaCents > 0 ? "text-ok" : e.mrrDeltaCents < 0 ? "text-crit" : "text-muted"}`}>
                      {e.mrrDeltaCents === 0 ? "—" : `${e.mrrDeltaCents > 0 ? "+" : ""}${money(e.mrrDeltaCents, e.currency)}`}
                    </Td>
                    <Td className="num text-xs">{e.currency}</Td>
                    <Td>
                      <Badge tone={BEACON.has(e.channel) ? "gold" : "neutral"}>{label(e.channel)}</Badge>
                    </Td>
                    <Td className="text-xs">{e.provider}</Td>
                    <Td className="num max-w-48 truncate text-xs">
                      <span title={e.externalId}>{e.externalId}</span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>
        </>
      )}

      <Panel eyebrow="Definitions" title="How revenue is attributed" className="mt-6">
        <Table>
          <tbody>
            <tr>
              <Th>Attributable to Beacon</Th>
              <Td>
                MRR of active and past-due subscriptions whose acquisition channel is one Beacon operates: {BEACON_CHANNELS.map((c) => label(c).toLowerCase()).join(", ")}. The channel is fixed at acquisition using the organisation’s attribution rules (see{" "}
                <Link href="/conversions" className="text-gold hover:text-gold-bright">
                  Conversions
                </Link>
                ). Paid, social, email, direct and other channels are not counted.
              </Td>
            </tr>
            <tr>
              <Th>New MRR via Beacon</Th>
              <Td>Sum of MRR deltas of revenue events in the period on Beacon channels (new, upgrades, downgrades and churn net out).</Td>
            </tr>
            <tr>
              <Th>ARR</Th>
              <Td>Current MRR × 12.</Td>
            </tr>
            <tr>
              <Th>Currencies</Th>
              <Td>Money is stored in minor units (cents) in each event’s own currency and is never converted. Totals are labelled in the organisation’s primary currency ({currency}); check the currency column when more than one currency is recorded.</Td>
            </tr>
          </tbody>
        </Table>
      </Panel>
    </>
  );
}

function DimTable({ rows, head, caption }: { rows: { key: string; name: string; a: string; b: string; c?: string; beacon?: boolean }[]; head: string[]; caption: string }) {
  if (!rows.length) return null;
  return (
    <details className="mt-4 border-t border-line pt-3">
      <summary className="eyebrow cursor-pointer text-chrome">Table view</summary>
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
