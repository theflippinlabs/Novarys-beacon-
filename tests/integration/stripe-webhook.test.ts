import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, withOrg } from "@/db";
import { identities, integrations, revenueEvents, subscriptions } from "@/db/schema";
import { POST } from "@/app/api/webhooks/stripe/[integrationId]/route";
import { saveIntegration } from "@/services/visibility";
import { newOrg, params, seedCompleteProduct, uid } from "./helpers";

const SECRET = `whsec_${uid()}${uid()}`;
let orgId: string;
let integrationId: string;
let productId: string;

const sign = (body: string, t = Math.floor(Date.now() / 1000), secret = SECRET) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
const deliver = (body: string, signature: string | null, id = integrationId) =>
  POST(new Request(`http://localhost/api/webhooks/stripe/${id}`, { method: "POST", headers: signature ? { "stripe-signature": signature } : {}, body }), params({ integrationId: id }));

const invoicePaid = (eventId: string, customer: string, sub: string) =>
  JSON.stringify({
    id: eventId,
    type: "invoice.paid",
    created: Math.floor(Date.now() / 1000) - 5,
    data: {
      object: {
        id: `in_${uid()}`,
        customer,
        subscription: sub,
        billing_reason: "subscription_create",
        amount_paid: 2900,
        currency: "eur",
        lines: { data: [{ price: { unit_amount: 2900, recurring: { interval: "month", interval_count: 1 } }, quantity: 1 }] },
      },
    },
  });

beforeAll(async () => {
  const ctx = await newOrg("stripe");
  orgId = ctx.org.id;
  const slug = `pay-${uid()}`;
  productId = (await seedCompleteProduct(orgId, { name: "Pay App", slug })).product.id;
  const integ = await withOrg(orgId, (tx) => saveIntegration(tx, ctx.actor, { provider: "STRIPE", productId: null, config: { defaultProduct: slug }, secret: { webhookSecret: SECRET } }));
  integrationId = integ.id;
  await withOrg(orgId, (tx) => tx.update(integrations).set({ lastSyncAt: null }).where(eq(integrations.id, integrationId)));
});
afterAll(closeDb);

describe("Stripe webhook", () => {
  const eventId = `evt_${uid()}`;
  const sub = `sub_${uid()}`;
  const customer = `cus_${uid()}`;

  it("records revenue for a correctly signed invoice.paid event", async () => {
    const body = invoicePaid(eventId, customer, sub);
    const res = await deliver(body, sign(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: false });
    const evs = await withOrg(orgId, (tx) => tx.select().from(revenueEvents).where(and(eq(revenueEvents.provider, "stripe"), eq(revenueEvents.externalId, eventId))));
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({ productId, type: "NEW", amountCents: 2900, mrrDeltaCents: 2900, currency: "EUR", channel: "DIRECT" });
    const s = await withOrg(orgId, (tx) => tx.query.subscriptions.findFirst({ where: and(eq(subscriptions.provider, "stripe"), eq(subscriptions.externalId, sub)) }));
    expect(s).toMatchObject({ status: "ACTIVE", mrrCents: 2900, productId });
    const ident = await withOrg(orgId, (tx) => tx.query.identities.findFirst({ where: and(eq(identities.organizationId, orgId), eq(identities.externalRef, `stripe:${customer}`)) }));
    expect(ident).toBeDefined();
    const integ = await withOrg(orgId, (tx) => tx.query.integrations.findFirst({ where: eq(integrations.id, integrationId) }));
    expect(integ!.status).toBe("CONNECTED");
    expect(integ!.lastSyncAt).toBeInstanceOf(Date);
  });

  it("a replayed event id is idempotent", async () => {
    const body = invoicePaid(eventId, customer, sub);
    const res = await deliver(body, sign(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, duplicate: true });
    const evs = await withOrg(orgId, (tx) => tx.select().from(revenueEvents).where(eq(revenueEvents.externalId, eventId)));
    expect(evs).toHaveLength(1);
  });

  it("rejects bad, missing, stale or wrong-secret signatures with 400 and stores nothing", async () => {
    const id = `evt_${uid()}`;
    const body = invoicePaid(id, customer, `sub_${uid()}`);
    expect((await deliver(body, "t=123,v1=deadbeef")).status).toBe(400);
    expect((await deliver(body, null)).status).toBe(400);
    expect((await deliver(body, sign(body, Math.floor(Date.now() / 1000) - 3600))).status).toBe(400);
    expect((await deliver(body, sign(body, undefined, "whsec_wrong"))).status).toBe(400);
    // Signature over a different body (tampering).
    expect((await deliver(body.replace("2900", "1"), sign(body))).status).toBe(400);
    const evs = await withOrg(orgId, (tx) => tx.select().from(revenueEvents).where(eq(revenueEvents.externalId, id)));
    expect(evs).toHaveLength(0);
  });

  it("unknown or malformed integration ids return 404", async () => {
    const body = invoicePaid(`evt_${uid()}`, customer, sub);
    expect((await deliver(body, sign(body), randomUUID())).status).toBe(404);
    expect((await deliver(body, sign(body), "not-a-uuid")).status).toBe(404);
  });

  it("ignores unmapped event types", async () => {
    const body = JSON.stringify({ id: `evt_${uid()}`, type: "customer.created", created: Math.floor(Date.now() / 1000), data: { object: { id: "cus_x" } } });
    const res = await deliver(body, sign(body));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, ignored: "customer.created" });
  });
});
