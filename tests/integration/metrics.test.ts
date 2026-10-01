import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withOrg, type Tx } from "@/db";
import { products } from "@/db/schema";
import { kpis } from "@/services/metrics";
import { ingestEvent, recordRevenue, resolveApiKey } from "@/services/tracking";
import { upsertMetrics } from "@/services/visibility";
import { addDays, isoDay } from "@/core/util/text";
import { createKey, newOrg, uid } from "./helpers";

let orgId: string;
let productId: string;
const q = <T,>(fn: (tx: Tx) => Promise<T>) => withOrg(orgId, fn);

beforeAll(async () => {
  orgId = (await newOrg("kpi")).org.id;
  productId = (await q((tx) => tx.insert(products).values({ organizationId: orgId, slug: `kpi-${uid()}`, name: "Kpi Product", domain: "kpi.example" }).returning()))[0].id;
});
afterAll(closeDb);

describe("kpis", () => {
  it("returns now: null for disconnected sources instead of fabricated zeros", async () => {
    const k = await q((tx) => kpis(tx, orgId, { days: 30 }));
    for (const v of [
      k.discovery.organicImpressions,
      k.discovery.organicClicks,
      k.discovery.indexedPages,
      k.discovery.brandedImpressions,
      k.discovery.aiReferrals,
      k.discovery.aiMentions,
      k.acquisition.visitors,
      k.acquisition.signups,
      k.acquisition.trials,
      k.acquisition.activations,
      k.revenue.newSubscriptions,
      k.revenue.revenue,
      k.revenue.beaconNewMrr,
      k.revenue.mrr,
      k.revenue.beaconMrr,
      k.revenue.arr,
      k.revenue.conversionRate,
      k.ecosystem.crossSellRate,
      k.ecosystem.multiProductUsers,
      k.ecosystem.referralConversions,
      k.ecosystem.affiliateRevenue,
    ])
      expect(v.now, v.source).toBeNull();
    // Internal counts are real zeros.
    expect(k.discovery.coveredQueries.now).toBe(0);
    expect(k.content.published.now).toBe(0);
    // No currency is ever assumed; nothing connected means NOT_CONNECTED, not a zero.
    expect(k.currency).toBeNull();
    expect(k.acquisition.visitors.state).toBe("NOT_CONNECTED");
    expect(k.revenue.revenue.state).toBe("NOT_CONNECTED");
    expect(k.discovery.coveredQueries.state).toBe("OK");
  });

  it("returns real counts once events, revenue and search data exist", async () => {
    const sk = await createKey(orgId, "SECRET", { productId, scopes: ["revenue:write"] });
    // One transaction per call, as in production (each event is its own request).
    const meta = { origin: null, ipHash: "iphash-kpi" };
    const send = (ev: Parameters<typeof ingestEvent>[2]) => q(async (tx) => ingestEvent(tx, (await resolveApiKey(tx, sk))!, ev, meta));
    await send({ type: "PAGE_VIEW", visitorId: "visitor_ai_0001", url: "https://kpi.example/", referrer: "https://chatgpt.com/" });
    await send({ type: "PAGE_VIEW", visitorId: "visitor_ai_0001", url: "https://kpi.example/pricing" });
    await send({ type: "PAGE_VIEW", visitorId: "visitor_web_0002", url: "https://kpi.example/" });
    await send({ type: "SIGNUP", visitorId: "visitor_ai_0001", identityRef: "kpi-user-1" });
    await send({ type: "SUBSCRIBED", identityRef: "kpi-user-1" });
    // An event in the previous window.
    await send({ type: "PAGE_VIEW", visitorId: "visitor_old_0003", url: "https://kpi.example/", occurredAt: addDays(new Date(), -40).toISOString() });
    await q((tx) => recordRevenue(tx, orgId, productId, { provider: "api", externalId: `inv-${uid()}`, type: "NEW", amountCents: 4900, mrrDeltaCents: 4900, currency: "EUR", identityRef: "kpi-user-1", subscription: { externalId: `sub-${uid()}`, status: "ACTIVE", mrrCents: 4900 } }));
    await q((tx) =>
      upsertMetrics(tx, orgId, productId, "GOOGLE_SEARCH_CONSOLE", [
        { metric: "search_impressions", day: isoDay(addDays(new Date(), -3)), value: 120 },
        { metric: "search_clicks", day: isoDay(addDays(new Date(), -3)), value: 9 },
        { metric: "search_impressions", day: isoDay(addDays(new Date(), -45)), value: 80 },
      ]),
    );
    const k = await q((tx) => kpis(tx, orgId, { days: 30 }));
    expect(k.acquisition.visitors).toMatchObject({ now: 2, prev: 1 });
    expect(k.acquisition.signups).toMatchObject({ now: 1, prev: 0 });
    expect(k.acquisition.trials).toMatchObject({ now: 0, prev: 0 });
    expect(k.discovery.aiReferrals.now).toBe(1);
    expect(k.discovery.organicImpressions).toMatchObject({ now: 120, prev: 80 });
    expect(k.discovery.organicClicks).toMatchObject({ now: 9, prev: 0 });
    expect(k.revenue.newSubscriptions).toMatchObject({ now: 1, prev: 0 });
    expect(k.revenue.revenue).toMatchObject({ now: 4900, prev: 0 });
    expect(k.revenue.mrr.now).toBe(4900);
    expect(k.revenue.arr.now).toBe(4900 * 12);
    // Acquired via an AI referral → counted as Beacon-attributable MRR.
    expect(k.revenue.beaconMrr.now).toBe(4900);
    expect(k.revenue.beaconNewMrr.now).toBe(4900);
    expect(k.revenue.conversionRate.now).toBeCloseTo(1 / 2);
    expect(k.ecosystem.multiProductUsers.now).toBe(0);
    // Still not connected: no audit, no AI tests, no cross-sell events.
    expect(k.discovery.indexedPages.now).toBeNull();
    expect(k.discovery.aiMentions.now).toBeNull();
    expect(k.ecosystem.crossSellRate.now).toBeNull();

    // Product filter and tenant isolation.
    const pk = await q((tx) => kpis(tx, orgId, { days: 30, productId: "00000000-0000-4000-8000-000000000000" }));
    expect(pk.acquisition.visitors.now).toBeNull();
    const other = await newOrg("kpi-other");
    const ok = await withOrg(other.org.id, (tx) => kpis(tx, orgId, { days: 30 }));
    expect(ok.acquisition.visitors.now).toBeNull();
    expect(ok.revenue.revenue.now).toBeNull();
  });
});
