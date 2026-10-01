import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, withOrg, type Tx } from "@/db";
import { aiVisibilityPrompts, aiVisibilityTests, conversionEvents, identities, integrations, opportunities, revenueEvents, searchDaily } from "@/db/schema";
import { addQuery } from "@/services/queries";
import { recordLearning } from "@/services/autopilot-learning";
import { loadEstimationContext } from "@/services/estimates";
import { generateProductOpportunities } from "@/services/opportunities";
import { estimateImpact, estimationPower, MISSING } from "@/core/estimate/impact";
import { newOrg, seedCompleteProduct, uid } from "./helpers";

let orgId: string;
let otherOrgId: string;
let productId: string;
let queryId: string;
let competitorId: string;
const q = <T,>(fn: (tx: Tx) => Promise<T>) => withOrg(orgId, fn);
const DAY = 86_400_000;
const day = (ago: number) => new Date(Date.now() - ago * DAY).toISOString().slice(0, 10);
const QUERY = "tiktok live moderation tool";

/** Org-wide CTR by position: one query per bucket, 1,000 impressions each (position, clicks). */
const CURVE: [number, number][] = [
  [1, 300],
  [2, 150],
  [3, 100],
  [4.5, 60],
  [8, 20],
  [15, 5],
  [30, 1],
];

beforeAll(async () => {
  orgId = (await newOrg("est")).org.id;
  otherOrgId = (await newOrg("est-other")).org.id;
  const seeded = await seedCompleteProduct(orgId, { name: `Estimate Product ${uid()}` });
  productId = seeded.product.id;
  competitorId = seeded.competitor.id;
  queryId = (await q((tx) => addQuery(tx, orgId, { query: QUERY, productId, importance: 5, status: "ACTIVE" })))!.id;

  await q(async (tx) => {
    const [integ] = await tx.insert(integrations).values({ organizationId: orgId, productId, provider: "GOOGLE_SEARCH_CONSOLE", status: "CONNECTED", config: { siteUrl: "sc-domain:est.example" } }).returning();
    const base = { organizationId: orgId, productId, integrationId: integ.id, provider: "GOOGLE_SEARCH_CONSOLE" as const };
    const rows: (typeof searchDaily.$inferInsert)[] = CURVE.map(([position, clicks], i) => ({ ...base, day: day(40), query: `curve query ${i}`, clicks, impressions: 1000, position }));
    // The tracked query: 10 days in the last 30, 100 impressions and 1 click a day at position 8.
    for (let d = 1; d <= 10; d++) rows.push({ ...base, day: day(d), query: QUERY, clicks: 1, impressions: 100, position: 8 });
    // Older than the 30-day query window: not counted for the query (still in the 90-day curve).
    rows.push({ ...base, day: day(60), query: QUERY, clicks: 50, impressions: 500, position: 8 });
    await tx.insert(searchDaily).values(rows);

    // 100 tracked visitors (80 organic search, 20 direct); 10 organic visitors sign up with an identity.
    const ids = await tx
      .insert(identities)
      .values(Array.from({ length: 12 }, (_, i) => ({ organizationId: orgId, externalRef: `user-${i}` })))
      .returning();
    const events: (typeof conversionEvents.$inferInsert)[] = [];
    for (let v = 0; v < 100; v++) {
      const visitorId = `v-${v}`;
      const channel = v < 80 ? ("ORGANIC_SEARCH" as const) : ("DIRECT" as const);
      events.push({ organizationId: orgId, productId, type: "PAGE_VIEW", visitorId, channel, occurredAt: new Date(Date.now() - 5 * DAY) });
      if (v < 10) events.push({ organizationId: orgId, productId, type: "SIGNUP_COMPLETED", visitorId, identityId: ids[v].id, channel, occurredAt: new Date(Date.now() - 4 * DAY) });
    }
    // A server signup that only carries an identity (joined to that identity's first visitor, not a new person).
    events.push({ organizationId: orgId, productId, type: "SIGNUP", identityId: ids[11].id, occurredAt: new Date(Date.now() - 3 * DAY) });
    await tx.insert(conversionEvents).values(events);

    // Revenue: 6 identities pay in EUR (one is partly refunded), 2 pay in USD; one payer never signed up (ignored).
    const rev = (i: number, type: "NEW" | "RENEWAL" | "REFUND", amountCents: number, currency: string) => ({
      organizationId: orgId,
      productId,
      identityId: ids[i].id,
      type,
      amountCents,
      currency,
      provider: "test",
      externalId: `rev-${uid()}`,
      occurredAt: new Date(Date.now() - 2 * DAY),
    });
    await tx
      .insert(revenueEvents)
      .values([
        rev(0, "NEW", 2900, "EUR"),
        rev(1, "NEW", 2900, "EUR"),
        rev(2, "NEW", 2900, "EUR"),
        rev(2, "RENEWAL", 2900, "EUR"),
        rev(3, "NEW", 2900, "EUR"),
        rev(4, "NEW", 2900, "EUR"),
        rev(5, "NEW", 2900, "EUR"),
        rev(5, "REFUND", -900, "EUR"),
        rev(6, "NEW", 4900, "USD"),
        rev(7, "NEW", 4900, "USD"),
        rev(10, "NEW", 9900, "EUR"),
      ]);

    // AI visibility: 12 sampled answers, 4 mention the product, 9 mention the competitor.
    const [prompt] = await tx.insert(aiVisibilityPrompts).values({ organizationId: orgId, productId, prompt: "best tiktok live moderation tool" }).returning();
    await tx.insert(aiVisibilityTests).values(
      Array.from({ length: 12 }, (_, i) => ({
        organizationId: orgId,
        promptId: prompt.id,
        provider: "anthropic",
        model: "m",
        response: "answer",
        productsMentioned: i < 4 ? [{ productId, name: "Estimate Product", position: 1 }] : [],
        competitorsMentioned: i < 9 ? [{ competitorId, name: seeded.competitor.name, position: 2 }] : [],
        orgMentioned: i < 4,
      })),
    );
  });
  for (const label of ["IMPROVED", "IMPROVED", "IMPROVED", "IMPROVED", "NO_CHANGE", "INSUFFICIENT_DATA"] as const) await q((tx) => recordLearning(tx, orgId, "CONTENT_GAP", label));
});
afterAll(closeDb);

describe("loadEstimationContext", () => {
  it("loads every estimator input from the organisation's measured data", async () => {
    const ctx = await q((tx) => loadEstimationContext(tx, orgId));
    expect(ctx.search.connected).toBe(true);
    const bucket = (k: string) => ctx.search.curve.find((b) => b.bucket === k);
    expect(bucket("1")).toEqual({ bucket: "1", clicks: 300, impressions: 1000 });
    expect(bucket("3")).toEqual({ bucket: "3", clicks: 100, impressions: 1000 });
    // 6-10: the curve query (1,000 impressions) plus the tracked query (1,000 recent + 500 older).
    expect(bucket("6-10")).toEqual({ bucket: "6-10", clicks: 20 + 10 + 50, impressions: 2500 });
    expect(ctx.search.queries[queryId]).toEqual({ productId, query: QUERY, clicks: 10, impressions: 1000, position: 8 });

    expect(ctx.conversion.tracked).toBe(true);
    expect(ctx.conversion.byScope[productId].all).toEqual({ visitors: 100, converters: 10 });
    expect(ctx.conversion.byScope[productId].byChannel.ORGANIC_SEARCH).toEqual({ visitors: 80, converters: 10 });
    expect(ctx.conversion.byScope[productId].byChannel.DIRECT).toEqual({ visitors: 20, converters: 0 });
    expect(ctx.conversion.byScope.org.all).toEqual({ visitors: 100, converters: 10 });

    expect(ctx.value.connected).toBe(true);
    // 11 converting identities (10 tracked signups and one server signup).
    expect(ctx.value.byScope[productId].converters).toBe(11);
    expect(ctx.value.byScope[productId].byCurrency.EUR).toEqual([2000, 2900, 2900, 2900, 2900, 5800]);
    expect(ctx.value.byScope[productId].byCurrency.USD).toEqual([4900, 4900]);
    expect(ctx.value.byScope.org.byCurrency.EUR).toEqual([2000, 2900, 2900, 2900, 2900, 5800]);

    expect(ctx.learning.CONTENT_GAP).toEqual({ improved: 4, noChange: 1, declined: 0, insufficient: 1 });
    expect(ctx.ai.tested).toBe(true);
    expect(ctx.ai.byScope[productId]).toMatchObject({ samples: 12, mentioned: 4, competitors: [{ id: competitorId, mentioned: 9 }] });
    expect(ctx.ai.byScope.org).toMatchObject({ samples: 12, mentioned: 4 });
  });

  it("sees nothing of another organisation", async () => {
    const ctx = await withOrg(otherOrgId, (tx) => loadEstimationContext(tx, otherOrgId));
    expect(ctx.search).toMatchObject({ connected: false, curve: [], queries: {} });
    expect(ctx.conversion.tracked).toBe(false);
    expect(ctx.value.connected).toBe(false);
    expect(ctx.learning).toEqual({});
    expect(ctx.ai.tested).toBe(false);
  });
});

describe("expected_impact end to end", () => {
  it("estimates clicks, signups and revenue per currency from the seeded rows", async () => {
    const ctx = await q((tx) => loadEstimationContext(tx, orgId));
    const r = estimateImpact(ctx, { productId, queryIds: [queryId], opportunityType: "CONTENT_GAP" });
    expect(r.reached).toBe("revenue");
    const [traffic, conv, success] = r.parts;
    if (traffic.state !== "ESTIMATED" || conv.state !== "ESTIMATED" || success.state !== "ESTIMATED" || r.signups.state !== "ESTIMATED") throw new Error("chain not estimated");
    // CTR at position 3 ~ 101/1002, impressions 1,000, current clicks 10: about 91 extra clicks per 30 days.
    expect(traffic.p50).toBeGreaterThan(80);
    expect(traffic.p50).toBeLessThan(100);
    expect(conv.inputs.find((i) => i.name === "Channel")?.value).toBe("ORGANIC_SEARCH");
    expect(success.inputs.find((i) => i.name === "Measured outcomes")?.value).toBe(5);
    expect(r.signups.p50).toBeGreaterThan(0);
    expect(r.signups.p10).toBeLessThanOrEqual(r.signups.p50);
    expect(r.signups.p90).toBeGreaterThanOrEqual(r.signups.p50);
    expect(r.revenue.map((e) => [e.currency, e.state])).toEqual([
      ["EUR", "ESTIMATED"],
      ["USD", "NOT_ESTIMABLE"],
    ]);
    expect(r.missing).toEqual([MISSING.payers]);
    const power = estimationPower(ctx, [{ productId, queryIds: [queryId], opportunityType: "CONTENT_GAP" }, { productId, queryIds: [queryId], opportunityType: "LOW_CTR" }]);
    expect(power.measured).toEqual(["Traffic potential", "Conversion rate", "Value per conversion", "Success probability", "AI mention rate"]);
    expect(power.bestNextConnection).toEqual({ connect: MISSING.outcomes, unlocks: 1, completes: 1 });
  });

  it("stores the estimate on opportunities when they are generated", async () => {
    await q((tx) => generateProductOpportunities(tx, orgId, productId));
    const rows = await q((tx) => tx.select().from(opportunities).where(eq(opportunities.productId, productId)));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((o) => o.impactEstimate !== null)).toBe(true);
    const gap = rows.find((o) => o.type === "CONTENT_GAP" && o.sources.queryIds?.includes(queryId));
    expect(gap).toBeDefined();
    expect(gap!.impactEstimate!.signups.state).toBe("ESTIMATED");
    expect(gap!.impactEstimate!.reached).toBe("revenue");
    // An opportunity without search queries is not estimable and lists nothing to connect.
    const noQuery = rows.find((o) => !o.sources.queryIds?.length && !o.queryId);
    if (noQuery) {
      expect(noQuery.impactEstimate!.signups.state).toBe("NOT_ESTIMABLE");
      expect(noQuery.impactEstimate!.missing).toEqual([]);
    }
    // Regenerating keeps a stored estimate (idempotent).
    await q((tx) => generateProductOpportunities(tx, orgId, productId));
    const again = await q((tx) => tx.select().from(opportunities).where(eq(opportunities.id, gap!.id)));
    expect(JSON.stringify(again[0].impactEstimate)).toBe(JSON.stringify(gap!.impactEstimate));
  });
});
