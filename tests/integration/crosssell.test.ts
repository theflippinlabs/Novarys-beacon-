import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, withOrg, type Tx } from "@/db";
import { crossSellEvents, crossSellRules, identityProducts, products } from "@/db/schema";
import { crossSellFor, recordCrossSellEvent } from "@/services/crosssell";
import { upsertIdentity } from "@/services/tracking";
import { GET as crossSellGET } from "@/app/api/v1/cross-sell/route";
import { POST as crossSellEventPOST } from "@/app/api/v1/cross-sell/event/route";
import { createKey, ipHeader, jsonRequest, newOrg, uid } from "./helpers";

let orgId: string;
let source: typeof products.$inferSelect;
let dest: typeof products.$inferSelect;
let rule: typeof crossSellRules.$inferSelect;
const q = <T,>(fn: (tx: Tx) => Promise<T>) => withOrg(orgId, fn);

async function identityUsing(opts: { consent: boolean; productIds: { id: string; status?: "ACTIVE" | "CANCELLED" | "TRIALING" }[] }) {
  const ref = `xs-${uid()}`;
  return q(async (tx) => {
    const i = await upsertIdentity(tx, orgId, ref, { consent: { analytics: true, marketing: false, crossProduct: opts.consent } });
    for (const p of opts.productIds) await tx.insert(identityProducts).values({ organizationId: orgId, identityId: i.id, productId: p.id, status: p.status ?? "ACTIVE", firstSeenAt: new Date(Date.now() - 60 * 86_400_000) });
    return { ref, identity: i };
  });
}

beforeAll(async () => {
  orgId = (await newOrg("xsell")).org.id;
  [source, dest] = await q(async (tx) => {
    const [a] = await tx.insert(products).values({ organizationId: orgId, slug: `src-${uid()}`, name: "Source App" }).returning();
    const [b] = await tx.insert(products).values({ organizationId: orgId, slug: `dst-${uid()}`, name: "Dest App" }).returning();
    return [a, b];
  });
  [rule] = await q((tx) =>
    tx
      .insert(crossSellRules)
      .values({ organizationId: orgId, sourceProductId: source.id, destinationProductId: dest.id, name: "Src→Dst", message: "Try Dest App", ctaUrl: "https://dest.example/start", frequencyCapDays: 14, maxImpressions: 3 })
      .returning(),
  );
});
afterAll(closeDb);

describe("cross-sell", () => {
  it("requires explicit cross-product consent", async () => {
    const { ref } = await identityUsing({ consent: false, productIds: [{ id: source.id }] });
    const r = await q((tx) => crossSellFor(tx, orgId, ref, source.id, { recordImpression: true }));
    expect(r.recommendations).toEqual([]);
    expect(r.reasons[rule.id]).toBe("no-consent");
    const ev = await q((tx) => tx.select().from(crossSellEvents).where(eq(crossSellEvents.ruleId, rule.id)));
    expect(ev).toHaveLength(0);
  });

  it("unknown identity → no recommendations", async () => {
    const r = await q((tx) => crossSellFor(tx, orgId, "nobody", source.id));
    expect(r).toEqual({ recommendations: [], reasons: { identity: "unknown" } });
  });

  it("records an impression, then the frequency cap suppresses the rule", async () => {
    const { ref, identity } = await identityUsing({ consent: true, productIds: [{ id: source.id }] });
    const first = await q((tx) => crossSellFor(tx, orgId, ref, source.id, { recordImpression: true }));
    expect(first.reasons[rule.id]).toBe("eligible");
    expect(first.recommendations).toHaveLength(1);
    expect(first.recommendations[0]).toMatchObject({ ruleId: rule.id, destinationProductId: dest.id, message: "Try Dest App" });
    const cta = new URL(first.recommendations[0].cta.url);
    expect(cta.searchParams.get("utm_source")).toBe("beacon-cross-sell");
    expect(cta.searchParams.get("utm_campaign")).toBe(rule.id);
    const ev = await q((tx) => tx.select().from(crossSellEvents).where(and(eq(crossSellEvents.ruleId, rule.id), eq(crossSellEvents.identityId, identity.id))));
    expect(ev.map((e) => e.type)).toEqual(["IMPRESSION"]);

    const second = await q((tx) => crossSellFor(tx, orgId, ref, source.id, { recordImpression: true }));
    expect(second.recommendations).toEqual([]);
    expect(second.reasons[rule.id]).toBe("frequency-cap");
    const ev2 = await q((tx) => tx.select().from(crossSellEvents).where(eq(crossSellEvents.identityId, identity.id)));
    expect(ev2).toHaveLength(1);
  });

  it("lifetime impression cap", async () => {
    const { ref, identity } = await identityUsing({ consent: true, productIds: [{ id: source.id }] });
    await q((tx) =>
      tx.insert(crossSellEvents).values([30, 60, 90].map((d) => ({ organizationId: orgId, ruleId: rule.id, identityId: identity.id, type: "IMPRESSION" as const, occurredAt: new Date(Date.now() - d * 86_400_000) }))),
    );
    const r = await q((tx) => crossSellFor(tx, orgId, ref, source.id));
    expect(r.reasons[rule.id]).toBe("lifetime-cap");
  });

  it("excludes identities already using the destination product (unless cancelled)", async () => {
    const using = await identityUsing({ consent: true, productIds: [{ id: source.id }, { id: dest.id, status: "ACTIVE" }] });
    const r = await q((tx) => crossSellFor(tx, orgId, using.ref, source.id, { recordImpression: true }));
    expect(r.recommendations).toEqual([]);
    expect(r.reasons[rule.id]).toBe("already-uses-destination");
    const cancelled = await identityUsing({ consent: true, productIds: [{ id: source.id }, { id: dest.id, status: "CANCELLED" }] });
    const r2 = await q((tx) => crossSellFor(tx, orgId, cancelled.ref, source.id));
    expect(r2.reasons[rule.id]).toBe("eligible");
  });

  it("an identity that does not use the source product is not eligible", async () => {
    const { ref } = await identityUsing({ consent: true, productIds: [] });
    const r = await q((tx) => crossSellFor(tx, orgId, ref, source.id));
    expect(r.reasons[rule.id]).toBe("not-using-source");
  });

  it("a DISMISS event suppresses the rule; events for unknown rules/identities are refused", async () => {
    const { ref } = await identityUsing({ consent: true, productIds: [{ id: source.id }] });
    expect(await q((tx) => recordCrossSellEvent(tx, orgId, ref, rule.id, "DISMISS"))).toBe(true);
    const r = await q((tx) => crossSellFor(tx, orgId, ref, source.id));
    expect(r.reasons[rule.id]).toBe("dismissed-or-converted");
    expect(await q((tx) => recordCrossSellEvent(tx, orgId, "nobody", rule.id, "CLICK"))).toBe(false);
    expect(await q((tx) => recordCrossSellEvent(tx, orgId, ref, "00000000-0000-4000-8000-000000000000", "CLICK"))).toBe(false);
  });

  it("GET /api/v1/cross-sell requires a product-scoped secret key with crosssell:read", async () => {
    const { ref } = await identityUsing({ consent: true, productIds: [{ id: source.id }] });
    const good = await createKey(orgId, "SECRET", { productId: source.id, scopes: ["crosssell:read"] });
    const noScope = await createKey(orgId, "SECRET", { productId: source.id, scopes: [] });
    const call = (key: string, record = "1") =>
      crossSellGET(new Request(`http://localhost/api/v1/cross-sell?identityRef=${encodeURIComponent(ref)}&record=${record}`, { headers: { authorization: `Bearer ${key}`, ...ipHeader() } }));
    expect((await call(noScope)).status).toBe(401);
    const res = await call(good);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.recommendations.map((r: { ruleId: string }) => r.ruleId)).toEqual([rule.id]);
    const again = await (await call(good)).json();
    expect(again.reasons[rule.id]).toBe("frequency-cap");
    expect((await crossSellGET(new Request("http://localhost/api/v1/cross-sell", { headers: { authorization: `Bearer ${good}`, ...ipHeader() } }))).status).toBe(400);

    const click = await crossSellEventPOST(jsonRequest("http://localhost/api/v1/cross-sell/event", { identityRef: ref, ruleId: rule.id, type: "CONVERSION", revenueCents: 1500 }, { authorization: `Bearer ${good}` }));
    expect(click.status).toBe(201);
    const conv = await q((tx) => tx.select().from(crossSellEvents).where(and(eq(crossSellEvents.ruleId, rule.id), eq(crossSellEvents.type, "CONVERSION"))));
    expect(conv.map((c) => c.revenueCents)).toEqual([1500]);
  });
});
