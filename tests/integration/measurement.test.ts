import { createHmac, generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { closeDb, db, withOrg, type Tx } from "@/db";
import {
  analyticsDaily,
  apiKeys,
  rateLimitBuckets,
  attributionCredits,
  attributionEvents,
  campaigns,
  conversionEvents,
  crossSellEvents,
  crossSellRules,
  identities,
  integrations,
  productRelationships,
  products,
  revenueEvents,
  searchDaily,
  subscriptions,
  webhookInbox,
} from "@/db/schema";
import { POST as eventsPOST } from "@/app/api/v1/events/route";
import { LIMITS } from "@/app/api/v1/events/ingest";
import { POST as batchPOST } from "@/app/api/v1/events/batch/route";
import { POST as identifyPOST } from "@/app/api/v1/identify/route";
import { POST as stripePOST } from "@/app/api/webhooks/stripe/[integrationId]/route";
import { purgeTrackingIpHashes, recordRevenue } from "@/services/tracking";
import { inboxSummary, reprocessInbox } from "@/services/stripe";
import { kpis } from "@/services/metrics";
import { creditedTotals, conversionList } from "@/services/attribution";
import { journey, upsertAnalyticsDaily } from "@/services/journey";
import { addRelationship, ruleFunnels } from "@/services/ecosystem";
import { saveIntegration } from "@/services/visibility";
import { createGa4Adapter, GA4_PAGE_SIZE } from "@/integrations/ga4";
import { createKey, jsonRequest, newOrg, params, seedCompleteProduct, uid } from "./helpers";

let ctx: Awaited<ReturnType<typeof newOrg>>;
let orgId: string;
let product: Awaited<ReturnType<typeof seedCompleteProduct>>["product"];
let domain: string;
let pk: string;
let sk: string;
const q = <T,>(fn: (tx: Tx) => Promise<T>) => withOrg(orgId, fn);
const vid = () => `v_${uid()}${uid()}`;
const ORIGIN = () => `https://${domain}`;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const send = (body: Record<string, unknown>, opts: { key?: string; origin?: string | null } = {}) => {
  const headers: Record<string, string> = { authorization: `Bearer ${opts.key ?? pk}` };
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN();
  return eventsPOST(jsonRequest("http://localhost/api/v1/events", body, headers));
};
const server = (body: Record<string, unknown>) => send(body, { key: sk, origin: null });

beforeAll(async () => {
  ctx = await newOrg("measure");
  orgId = ctx.org.id;
  const slug = `meas-${uid()}`;
  ({ product } = await seedCompleteProduct(orgId, { name: "Measure App", slug, domain: `${slug}.example` }));
  domain = product.domain!;
  pk = await createKey(orgId, "PUBLISHABLE", { productId: product.id });
  sk = await createKey(orgId, "SECRET", { productId: product.id, scopes: ["revenue:write", "identity:write"] });
});
afterAll(closeDb);

describe("tracking API: publishable keys, consent, idempotency", () => {
  it("rejects identityRef, emailHashInput, consent and traits sent with a publishable key (403), storing nothing", async () => {
    const v = vid();
    for (const extra of [{ identityRef: "hijack" }, { emailHashInput: "a@b.example" }, { consent: { analytics: true, marketing: true, crossProduct: true } }, { traits: ["agency"] }]) {
      const res = await send({ type: "PAGE_VIEW", visitorId: v, url: `${ORIGIN()}/`, ...extra });
      expect(res.status).toBe(403);
      expect((await res.json()).error).toMatch(/publishable key/);
    }
    expect(await q((tx) => tx.select().from(conversionEvents).where(eq(conversionEvents.visitorId, v)))).toHaveLength(0);
    expect(await q((tx) => tx.select().from(identities).where(eq(identities.externalRef, "hijack")))).toHaveLength(0);
    // Lifecycle events still need a secret key; browser-observable Phase 2 events are allowed.
    expect((await send({ type: "SIGNUP_COMPLETED", visitorId: v })).status).toBe(403);
    expect((await send({ type: "SIGNUP_STARTED", visitorId: v, url: `${ORIGIN()}/signup` })).status).toBe(202);
  });

  it("an idempotent replay returns early: no duplicate conversion, touch, credit or identity write", async () => {
    const v = vid();
    const ref = `idem-${uid()}`;
    const key = `signup:${ref}`;
    await send({ type: "PAGE_VIEW", visitorId: v, sessionId: `s_${uid()}${uid()}`, url: `${ORIGIN()}/?utm_source=newsletter&utm_medium=email`, occurredAt: minutesAgo(30) });
    const first = await (await server({ type: "SIGNUP_COMPLETED", visitorId: v, identityRef: ref, idempotencyKey: key })).json();
    const replay = await (await server({ type: "SIGNUP_COMPLETED", visitorId: v, identityRef: ref, idempotencyKey: key, emailHashInput: "late@example.test", url: `${ORIGIN()}/?utm_source=google&utm_medium=cpc` })).json();
    expect(first.duplicate).toBe(false);
    expect(replay).toMatchObject({ duplicate: true, id: first.id });
    expect(await q((tx) => tx.select().from(conversionEvents).where(eq(conversionEvents.idempotencyKey, key)))).toHaveLength(1);
    expect(await q((tx) => tx.select().from(attributionEvents).where(eq(attributionEvents.visitorId, v)))).toHaveLength(1);
    expect(await q((tx) => tx.select().from(attributionCredits).where(eq(attributionCredits.conversionEventId, first.id)))).toHaveLength(4);
    const ident = await q((tx) => tx.query.identities.findFirst({ where: and(eq(identities.organizationId, orgId), eq(identities.externalRef, ref)) }));
    expect(ident!.emailHash).toBeNull();
  });

  it("refused analytics consent: the event is counted without visitor, identity, session or touch linkage", async () => {
    const ref = `noconsent-${uid()}`;
    const res = await identifyPOST(jsonRequest("http://localhost/api/v1/identify", { identityRef: ref, consent: { analytics: false, marketing: false, crossProduct: false } }, { authorization: `Bearer ${sk}` }));
    expect(res.status).toBe(200);
    const v = vid();
    const out = await (await server({ type: "SIGNUP_COMPLETED", visitorId: v, sessionId: `s_${uid()}${uid()}`, identityRef: ref })).json();
    expect(out).toMatchObject({ consent: "denied", rule: "consent-denied", channel: "UNATTRIBUTED" });
    const row = await q((tx) => tx.query.conversionEvents.findFirst({ where: eq(conversionEvents.id, out.id) }));
    expect(row).toMatchObject({ type: "SIGNUP_COMPLETED", visitorId: null, identityId: null, sessionId: null, attributionRule: "consent-denied" });
    expect(await q((tx) => tx.select().from(attributionCredits).where(eq(attributionCredits.conversionEventId, out.id)))).toHaveLength(0);
    // Consent granted later with the event itself (secret key) restores linkage.
    const ok = await (await server({ type: "TRIAL_STARTED", visitorId: v, identityRef: ref, consent: { analytics: true, marketing: false, crossProduct: false } })).json();
    expect(ok.consent).toBe("granted");
  });

  it("stores legacy names under their canonical value", async () => {
    const out = await (await server({ type: "SUBSCRIBED", identityRef: `legacy-${uid()}` })).json();
    const row = await q((tx) => tx.query.conversionEvents.findFirst({ where: eq(conversionEvents.id, out.id) }));
    expect(row!.type).toBe("SUBSCRIPTION_STARTED");
  });
});

describe("sessions, UTM, campaigns and attribution credits", () => {
  it("records one touch per session (a measured DIRECT visit without signal); no touch at all is UNATTRIBUTED", async () => {
    const v = vid();
    const s = `s_${uid()}${uid()}`;
    await send({ type: "PAGE_VIEW", visitorId: v, sessionId: s, url: `${ORIGIN()}/`, occurredAt: minutesAgo(10) });
    await send({ type: "PAGE_VIEW", visitorId: v, sessionId: s, url: `${ORIGIN()}/pricing`, referrer: `${ORIGIN()}/`, occurredAt: minutesAgo(9) });
    const touches = await q((tx) => tx.select().from(attributionEvents).where(eq(attributionEvents.visitorId, v)));
    expect(touches).toHaveLength(1);
    expect(touches[0]).toMatchObject({ channel: "DIRECT", sessionId: s });
    const conv = await (await server({ type: "SIGNUP_COMPLETED", visitorId: v, identityRef: `direct-${uid()}` })).json();
    expect(conv.channel).toBe("DIRECT");
    const none = await (await server({ type: "SIGNUP_COMPLETED", identityRef: `nobody-${uid()}` })).json();
    expect(none).toMatchObject({ channel: "UNATTRIBUTED", rule: "no-touch-in-window" });
  });

  it("stores UTM, referrer, landing page and session on conversions and matches utm_campaign to a campaign", async () => {
    const [camp] = await q((tx) => tx.insert(campaigns).values({ organizationId: orgId, productId: product.id, name: "Spring", channel: "EMAIL", utmSource: "newsletter", utmMedium: "email", utmCampaign: "spring-launch" }).returning());
    const v = vid();
    const s = `s_${uid()}${uid()}`;
    const land = `${ORIGIN()}/launch?utm_source=newsletter&utm_medium=email&utm_campaign=Spring-Launch`;
    const pv = await (await send({ type: "PAGE_VIEW", visitorId: v, sessionId: s, url: land, referrer: "https://mail.example/inbox", occurredAt: minutesAgo(5) })).json();
    expect(pv.channel).toBe("EMAIL");
    // The tracker re-sends the session's UTM and landing page with later events.
    const later = await (await send({ type: "CTA_CLICK", visitorId: v, sessionId: s, url: `${ORIGIN()}/pricing`, landingUrl: land, utm: { source: "newsletter", medium: "email", campaign: "Spring-Launch" }, ctaId: "buy" })).json();
    const row = await q((tx) => tx.query.conversionEvents.findFirst({ where: eq(conversionEvents.id, later.id) }));
    expect(row).toMatchObject({ sessionId: s, campaignId: camp.id, landingUrl: `${ORIGIN()}/launch`, utm: { source: "newsletter", medium: "email", campaign: "Spring-Launch" }, channel: "EMAIL" });
    expect(row!.firstTouchId).toBeTruthy();
    const touch = await q((tx) => tx.query.attributionEvents.findFirst({ where: eq(attributionEvents.visitorId, v) }));
    expect(touch).toMatchObject({ campaignId: camp.id, referrerHost: "mail.example", landingUrl: `${ORIGIN()}/launch` });
  });

  it("stores credits for every model (weights sum to 1) and credited revenue that adds up to the amount", async () => {
    const v = vid();
    const ref = `multi-${uid()}`;
    await send({ type: "PAGE_VIEW", visitorId: v, url: `${ORIGIN()}/a`, referrer: "https://www.google.com/", occurredAt: minutesAgo(300) });
    await send({ type: "PAGE_VIEW", visitorId: v, url: `${ORIGIN()}/b`, referrer: "https://www.linkedin.com/feed", occurredAt: minutesAgo(200) });
    await send({ type: "PAGE_VIEW", visitorId: v, url: `${ORIGIN()}/c`, referrer: "https://chatgpt.com/", occurredAt: minutesAgo(100) });
    const conv = await (await server({ type: "SIGNUP_COMPLETED", visitorId: v, identityRef: ref, occurredAt: minutesAgo(50) })).json();
    expect(conv).toMatchObject({ channel: "AI_REFERRAL", rule: "last-non-direct-touch" });
    const credits = await q((tx) => tx.select().from(attributionCredits).where(eq(attributionCredits.conversionEventId, conv.id)));
    const by = (m: string) => credits.filter((c) => c.model === m);
    for (const m of ["FIRST_TOUCH", "LAST_TOUCH", "LINEAR", "POSITION_BASED"]) expect(by(m).reduce((s, c) => s + c.weight, 0)).toBeCloseTo(1, 10);
    expect(by("FIRST_TOUCH").map((c) => c.channel)).toEqual(["ORGANIC_SEARCH"]);
    expect(by("LAST_TOUCH").map((c) => c.channel)).toEqual(["AI_REFERRAL"]);
    expect(by("LINEAR")).toHaveLength(3);
    expect(by("POSITION_BASED").map((c) => [c.channel, c.weight]).sort()).toEqual([
      ["AI_REFERRAL", 0.4],
      ["ORGANIC_SEARCH", 0.4],
      ["SOCIAL", 0.2],
    ]);
    const rev = await q((tx) => recordRevenue(tx, orgId, product.id, { provider: "api", externalId: `inv-${uid()}`, type: "NEW", amountCents: 1000, mrrDeltaCents: 1000, currency: "EUR", identityRef: ref }));
    const revCredits = await q((tx) => tx.select().from(attributionCredits).where(and(eq(attributionCredits.revenueEventId, rev.id!), eq(attributionCredits.model, "LINEAR"))));
    expect(revCredits.reduce((s, c) => s + (c.valueCents ?? 0), 0)).toBe(1000);
    expect(revCredits.every((c) => c.currency === "EUR")).toBe(true);

    const totals = await q((tx) => creditedTotals(tx, orgId, { days: 7, productId: product.id, model: "POSITION_BASED" }));
    expect(totals.find((x) => x.channel === "SOCIAL")!.conversions).toBeGreaterThan(0);
    const list = await q((tx) => conversionList(tx, orgId, { days: 7, productId: product.id, model: "LINEAR", page: 1, pageSize: 5 }));
    expect(list.total).toBeGreaterThan(5);
    expect(list.items).toHaveLength(5);
    expect(list.pages).toBeGreaterThan(1);
    const mine = (await q((tx) => conversionList(tx, orgId, { days: 7, productId: product.id, model: "LINEAR", page: 1, pageSize: 200 }))).items.find((i) => i.id === conv.id)!;
    expect(mine).toMatchObject({ channel: "AI_REFERRAL", rule: "last-non-direct-touch", firstTouch: { channel: "ORGANIC_SEARCH" }, lastTouch: { channel: "AI_REFERRAL" }, value: [{ currency: "EUR", cents: 1000 }] });
    expect(mine.credits).toHaveLength(3);
  });

  it("POST /api/v1/events/batch ingests up to 100 events with per-event results and the same publishable restrictions", async () => {
    const v = vid();
    const res = await batchPOST(
      jsonRequest(
        "http://localhost/api/v1/events/batch",
        { events: [{ type: "PAGE_VIEW", visitorId: v, url: `${ORIGIN()}/` }, { type: "PAGE_VIEW", visitorId: v, identityRef: "x" }, { type: "BOGUS" }] },
        { authorization: `Bearer ${pk}`, origin: ORIGIN() },
      ),
    );
    expect(res.status).toBe(207);
    const body = await res.json();
    expect(body).toMatchObject({ accepted: 1, rejected: 2 });
    expect(body.results.map((r: { status: number }) => r.status)).toEqual([202, 403, 400]);
    const tooMany = await batchPOST(jsonRequest("http://localhost/api/v1/events/batch", { events: Array.from({ length: 101 }, () => ({ type: "PAGE_VIEW", visitorId: v })) }, { authorization: `Bearer ${pk}`, origin: ORIGIN() }));
    expect(tooMany.status).toBe(413);
  });

  it("rate limits per key (not only per IP) and keeps CORS headers on the 429", async () => {
    const key = await createKey(orgId, "PUBLISHABLE", { productId: product.id });
    const row = await q((tx) => tx.query.apiKeys.findFirst({ where: eq(apiKeys.prefix, key.split("_")[1]) }));
    const windowStart = new Date(Math.floor(Date.now() / 60_000) * 60_000);
    await db().insert(rateLimitBuckets).values({ key: `events:key:${row!.id}`, windowStart, count: LIMITS.key }).onConflictDoUpdate({ target: [rateLimitBuckets.key, rateLimitBuckets.windowStart], set: { count: LIMITS.key } });
    const res = await send({ type: "PAGE_VIEW", visitorId: vid() }, { key });
    expect(res.status).toBe(429);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN());
    expect(res.headers.get("retry-after")).toBeTruthy();
  });

  it("clears IP hashes on touches older than the retention window", async () => {
    const v = vid();
    await q((tx) =>
      tx.insert(attributionEvents).values([
        { organizationId: orgId, productId: product.id, visitorId: v, channel: "SOCIAL", ipHash: "old-hash", occurredAt: new Date(Date.now() - 100 * 86_400_000) },
        { organizationId: orgId, productId: product.id, visitorId: v, channel: "SOCIAL", ipHash: "new-hash", occurredAt: new Date() },
      ]),
    );
    expect(await purgeTrackingIpHashes()).toBeGreaterThanOrEqual(1);
    const rows = await q((tx) => tx.select({ ip: attributionEvents.ipHash }).from(attributionEvents).where(eq(attributionEvents.visitorId, v)));
    expect(rows.map((r) => r.ip).sort()).toEqual(["new-hash", null].sort());
  });
});

describe("Stripe: webhook inbox, ordering guard, refunds", () => {
  const SECRET = `whsec_${uid()}${uid()}`;
  let integrationId: string;
  const sign = (body: string) => {
    const t = Math.floor(Date.now() / 1000);
    return `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`;
  };
  const deliver = async (event: Record<string, unknown>) => {
    const body = JSON.stringify(event);
    return stripePOST(new Request(`http://localhost/api/webhooks/stripe/${integrationId}`, { method: "POST", headers: { "stripe-signature": sign(body) }, body }), params({ integrationId }));
  };
  const at = (secAgo: number) => Math.floor(Date.now() / 1000) - secAgo;

  beforeAll(async () => {
    const integ = await withOrg(orgId, (tx) => saveIntegration(tx, ctx.actor, { provider: "STRIPE", productId: null, config: {}, secret: { webhookSecret: SECRET } }));
    integrationId = integ.id;
  });

  it("keeps unmapped events in the inbox, sets the integration error, and reprocesses them once mapped", async () => {
    const evtId = `evt_${uid()}`;
    const res = await deliver({ id: evtId, type: "invoice.paid", created: at(60), data: { object: { id: `in_${uid()}`, customer: "cus_unmapped", amount_paid: 500, currency: "usd", lines: { data: [] } } } });
    expect(res.status).toBe(200);
    expect((await res.json()).unmapped).toMatch(/beacon_product/);
    const row = await q((tx) => tx.query.webhookInbox.findFirst({ where: eq(webhookInbox.externalId, evtId) }));
    expect(row).toMatchObject({ status: "UNMAPPED", eventType: "invoice.paid", attempts: 1 });
    const integ = await q((tx) => tx.query.integrations.findFirst({ where: eq(integrations.id, integrationId) }));
    expect(integ!.lastError).toMatch(/invoice\.paid/);
    expect(await q((tx) => tx.select().from(revenueEvents).where(eq(revenueEvents.externalId, evtId)))).toHaveLength(0);

    await q((tx) => tx.update(integrations).set({ config: { defaultProduct: product.slug } }).where(eq(integrations.id, integrationId)));
    const r = await q((tx) => reprocessInbox(tx, integrationId));
    expect(r).toMatchObject({ PROCESSED: 1, UNMAPPED: 0 });
    const summary = (await q((tx) => inboxSummary(tx, orgId))).get(integrationId)!;
    expect(summary.PROCESSED.n).toBeGreaterThanOrEqual(1);
    expect(summary.UNMAPPED).toBeUndefined();
    expect(await q((tx) => tx.select().from(revenueEvents).where(eq(revenueEvents.externalId, evtId)))).toHaveLength(1);
    expect((await q((tx) => tx.query.webhookInbox.findFirst({ where: eq(webhookInbox.externalId, evtId) })))!.status).toBe("PROCESSED");
    // A redelivery of a processed event is a duplicate.
    const again = await deliver({ id: evtId, type: "invoice.paid", created: at(60), data: { object: { id: "in_x", amount_paid: 500, currency: "usd" } } });
    expect(await again.json()).toEqual({ received: true, duplicate: true });
  });

  it("ignores subscription events older than the last applied one", async () => {
    const sub = `sub_${uid()}`;
    const items = (amount: number) => ({ data: [{ price: { unit_amount: amount, currency: "eur", recurring: { interval: "month" } }, quantity: 1 }] });
    await deliver({ id: `evt_${uid()}`, type: "customer.subscription.updated", created: at(10), data: { object: { id: sub, customer: "cus_o", status: "past_due", currency: "eur", items: items(2000) }, previous_attributes: { status: "active" } } });
    const late = await deliver({ id: `evt_${uid()}`, type: "customer.subscription.updated", created: at(3600), data: { object: { id: sub, customer: "cus_o", status: "active", currency: "eur", items: items(1000) }, previous_attributes: { status: "trialing" } } });
    expect(late.status).toBe(200);
    const s = await q((tx) => tx.query.subscriptions.findFirst({ where: and(eq(subscriptions.organizationId, orgId), eq(subscriptions.externalId, sub)) }));
    expect(s).toMatchObject({ status: "PAST_DUE", mrrCents: 2000 });
    expect(await q((tx) => tx.select().from(revenueEvents).where(eq(revenueEvents.subscriptionId, s!.id)))).toHaveLength(1);
  });

  it("customer.subscription.created records the subscription without revenue; checkout links the identity", async () => {
    const sub = `sub_${uid()}`;
    const ref = `user-${uid()}`;
    await deliver({ id: `evt_${uid()}`, type: "checkout.session.completed", created: at(30), data: { object: { id: `cs_${uid()}`, mode: "subscription", subscription: sub, customer: "cus_c", client_reference_id: ref } } });
    await deliver({ id: `evt_${uid()}`, type: "customer.subscription.created", created: at(20), data: { object: { id: sub, customer: "cus_c", status: "trialing", currency: "eur", items: { data: [{ price: { unit_amount: 1500, recurring: { interval: "month" } }, quantity: 1 }] } } } });
    const s = await q((tx) => tx.query.subscriptions.findFirst({ where: and(eq(subscriptions.organizationId, orgId), eq(subscriptions.externalId, sub)) }));
    expect(s).toMatchObject({ status: "TRIALING", mrrCents: 1500 });
    const ident = await q((tx) => tx.query.identities.findFirst({ where: eq(identities.id, s!.identityId!) }));
    expect(ident!.externalRef).toBe(ref);
    expect(await q((tx) => tx.select().from(revenueEvents).where(eq(revenueEvents.subscriptionId, s!.id)))).toHaveLength(0);
  });

  it("counts each refund once (per-refund ids), never the cumulative total again", async () => {
    const charge = `ch_${uid()}`;
    const refunded = (evt: string, refunds: { id: string; amount: number }[]) =>
      deliver({ id: evt, type: "charge.refunded", created: at(5), data: { object: { id: charge, customer: "cus_r", currency: "eur", amount_refunded: refunds.reduce((s, r) => s + r.amount, 0), refunds: { data: refunds.map((r) => ({ ...r, status: "succeeded" })) } } } });
    const re1 = `re_${uid()}`;
    const re2 = `re_${uid()}`;
    await refunded(`evt_${uid()}`, [{ id: re1, amount: 300 }]);
    await refunded(`evt_${uid()}`, [
      { id: re1, amount: 300 },
      { id: re2, amount: 400 },
    ]);
    await deliver({ id: `evt_${uid()}`, type: "refund.created", created: at(4), data: { object: { id: re2, amount: 400, currency: "eur", charge, status: "succeeded" } } });
    // A charge.refunded without the refund list only records what is not recorded yet.
    await deliver({ id: `evt_${uid()}`, type: "charge.refunded", created: at(3), data: { object: { id: charge, customer: "cus_r", currency: "eur", amount_refunded: 900 } } });
    const rows = await q((tx) => tx.select().from(revenueEvents).where(and(eq(revenueEvents.organizationId, orgId), eq(revenueEvents.sourceRef, charge))));
    expect(rows.reduce((s, r) => s + r.amountCents, 0)).toBe(-900);
  });
});

describe("GA4 analytics_daily and the journey", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serviceAccountJson = JSON.stringify({ client_email: "beacon@test.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });

  it("imports every page of each report (offset pagination) and re-imports idempotently", async () => {
    const LANDING_ROWS = GA4_PAGE_SIZE + 5;
    const ymd = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10).replace(/-/g, "");
    const offsets: Record<string, number[]> = {};
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      if (url.includes("oauth2")) return new Response(JSON.stringify({ access_token: "tok" }), { status: 200 });
      const body = JSON.parse(String(init?.body));
      const report = body.dimensions.some((d: { name: string }) => d.name === "landingPage") ? "landing" : "geo_device";
      (offsets[report] ??= []).push(body.offset);
      const total = report === "landing" ? LANDING_ROWS : 2;
      const n = Math.max(0, Math.min(body.limit, total - body.offset));
      const rows = Array.from({ length: n }, (_, i) => {
        const k = body.offset + i;
        return report === "landing"
          ? { dimensionValues: [{ value: ymd }, { value: `/p${k}` }, { value: "google" }, { value: "organic" }, { value: "(organic)" }], metricValues: [{ value: "2" }, { value: "1" }, { value: "1" }, { value: "0.5" }] }
          : { dimensionValues: [{ value: ymd }, { value: k ? "FR" : "US" }, { value: "mobile" }], metricValues: [{ value: "3" }, { value: "3" }, { value: "2" }, { value: "1" }] };
      });
      return new Response(JSON.stringify({ rows, rowCount: total }), { status: 200 });
    }) as typeof fetch;
    const adapter = createGa4Adapter(fakeFetch);
    const rows = await adapter.fetchAnalyticsDaily!({ propertyId: "123" }, { serviceAccountJson }, { start: "2026-09-01", end: "2026-09-01" });
    expect(offsets.landing).toEqual([0, GA4_PAGE_SIZE]);
    expect(offsets.geo_device).toEqual([0]);
    expect(rows.filter((r) => r.report === "landing")).toHaveLength(LANDING_ROWS);
    expect(rows.find((r) => r.report === "geo_device" && r.country === "FR")).toMatchObject({ device: "mobile", sessions: 3, landingPage: "" });

    const [integ] = await q((tx) => tx.insert(integrations).values({ organizationId: orgId, productId: product.id, provider: "GOOGLE_ANALYTICS", status: "CONNECTED", config: { propertyId: "123" } }).returning());
    const target = { organizationId: orgId, productId: product.id, integrationId: integ.id };
    await q((tx) => upsertAnalyticsDaily(tx, target, rows));
    await q((tx) => upsertAnalyticsDaily(tx, target, rows));
    const count = await q((tx) => tx.select({ n: sql<number>`count(*)::int` }).from(analyticsDaily).where(eq(analyticsDaily.integrationId, integ.id)));
    expect(count[0].n).toBe(LANDING_ROWS + 2);
  });

  it("correlates Search Console pages, GA4 landing pages and Beacon conversions, labelling every link", async () => {
    const [integ] = await q((tx) => tx.insert(integrations).values({ organizationId: orgId, productId: product.id, provider: "GOOGLE_SEARCH_CONSOLE", status: "CONNECTED", config: { siteUrl: `sc-domain:${domain}` } }).returning());
    const today = new Date().toISOString().slice(0, 10);
    await q((tx) => tx.insert(searchDaily).values({ organizationId: orgId, productId: product.id, integrationId: integ.id, provider: "GOOGLE_SEARCH_CONSOLE", day: today, page: `${ORIGIN()}/journey/`, clicks: 7, impressions: 90 }));
    const ga = await q((tx) => tx.query.integrations.findFirst({ where: and(eq(integrations.organizationId, orgId), eq(integrations.provider, "GOOGLE_ANALYTICS")) }));
    await q((tx) => upsertAnalyticsDaily(tx, { organizationId: orgId, productId: product.id, integrationId: ga!.id }, [{ report: "landing", day: today, landingPage: "/journey", source: "google", medium: "organic", campaign: "", country: "", device: "", sessions: 5, users: 4, engagedSessions: 3, keyEvents: 1 }]));
    const v = vid();
    await send({ type: "PAGE_VIEW", visitorId: v, sessionId: `s_${uid()}${uid()}`, url: `${ORIGIN()}/journey?x=1`, referrer: "https://www.google.com/" });
    await server({ type: "SIGNUP_COMPLETED", visitorId: v, identityRef: `j-${uid()}` });
    const rows = await q((tx) => journey(tx, orgId, { days: 7, productId: product.id, limit: 20_000 }));
    const j = rows.find((r) => r.path === "/journey")!;
    expect(j).toMatchObject({ search: { clicks: 7, impressions: 90 }, analytics: { sessions: 5, organicSessions: 5 }, beacon: { visitors: 1, signups: 1 } });
    expect(j.links).toEqual({ searchToAnalytics: "MODELLED", analyticsToBeacon: "MODELLED", searchToBeacon: "MODELLED", beaconToConversion: "MEASURED" });
    const onlyGa = rows.find((r) => r.path === "/p1");
    expect(onlyGa?.links.searchToAnalytics).toBe("UNKNOWN");
  });
});

describe("KPI states", () => {
  it("NOT_CONNECTED, NO_DATA_YET and OK come from integrations, keys and all-time data, per product", async () => {
    const o = await newOrg("kpistate");
    const org = o.org.id;
    const [a, b] = await withOrg(org, (tx) => tx.insert(products).values([{ organizationId: org, slug: `a-${uid()}`, name: "Alpha", domain: "alpha.example" }, { organizationId: org, slug: `b-${uid()}`, name: "Beta", domain: "beta.example" }]).returning());
    const k0 = await withOrg(org, (tx) => kpis(tx, org, { days: 28 }));
    expect(k0.acquisition.visitors).toMatchObject({ state: "NOT_CONNECTED", now: null, href: `/products/${a.slug}/tracking` });
    expect(k0.discovery.organicClicks.state).toBe("NOT_CONNECTED");

    const keyA = await createKey(org, "SECRET", { productId: a.id, scopes: ["revenue:write"] });
    void keyA;
    const k1 = await withOrg(org, (tx) => kpis(tx, org, { days: 28, productId: a.id }));
    expect(k1.acquisition.visitors.state).toBe("NO_DATA_YET");
    expect(k1.revenue.revenue.state).toBe("NO_DATA_YET");
    // Product B has no key of its own (the key is scoped to A).
    const kb = await withOrg(org, (tx) => kpis(tx, org, { days: 28, productId: b.id }));
    expect(kb.acquisition.visitors.state).toBe("NOT_CONNECTED");

    // An old event (outside the window) makes the source OK: a measured zero is a real zero.
    await withOrg(org, (tx) => tx.insert(conversionEvents).values({ organizationId: org, productId: a.id, type: "PAGE_VIEW", visitorId: "old_visitor_1", occurredAt: new Date(Date.now() - 200 * 86_400_000) }));
    const k2 = await withOrg(org, (tx) => kpis(tx, org, { days: 28, productId: a.id }));
    expect(k2.acquisition.visitors).toMatchObject({ state: "OK", now: 0, prev: 0 });
    expect(k2.revenue.conversionRate).toMatchObject({ state: "OK", now: null }); // n/a, not "not connected"

    // Revenue in two currencies: per-currency amounts, never a sum; product B unaffected (product-scoped availability).
    await withOrg(org, (tx) => recordRevenue(tx, org, a.id, { provider: "api", externalId: `e-${uid()}`, type: "ONE_TIME", amountCents: 1000, mrrDeltaCents: 0, currency: "EUR" }));
    await withOrg(org, (tx) => recordRevenue(tx, org, a.id, { provider: "api", externalId: `u-${uid()}`, type: "ONE_TIME", amountCents: 500, mrrDeltaCents: 0, currency: "USD" }));
    const k3 = await withOrg(org, (tx) => kpis(tx, org, { days: 28, productId: a.id }));
    expect(k3.revenue.revenue).toMatchObject({ state: "OK", now: null, currency: null });
    expect(k3.revenue.revenue.byCurrency).toEqual([
      { currency: "EUR", now: 1000, prev: 0 },
      { currency: "USD", now: 500, prev: 0 },
    ]);
    expect(k3.currency).toBeNull();
    const kb2 = await withOrg(org, (tx) => kpis(tx, org, { days: 28, productId: b.id }));
    expect(kb2.revenue.revenue.state).toBe("NOT_CONNECTED"); // the only revenue key is scoped to A; A's revenue is not B's
    expect(kb2.revenue.revenue.now).toBeNull();

    // GA4 and Beacon AI referrals are separate KPIs, never added.
    expect(k3.discovery.aiReferralSessionsGa4.state).toBe("NOT_CONNECTED");
  });
});

describe("ecosystem graph and cross-sell funnels", () => {
  it("links rules to typed relationships and measures impressions → clicks → signups → subscriptions → revenue", async () => {
    const [dest] = await q((tx) => tx.insert(products).values({ organizationId: orgId, slug: `dest-${uid()}`, name: "Dest App", domain: `dest-${uid()}.example` }).returning());
    const rel = await q((tx) => addRelationship(tx, ctx.actor, { fromProductId: product.id, toProductId: dest.id, type: "COMPLEMENTARY", rationale: "Moderation teams also need stream analytics." }));
    await expect(q((tx) => addRelationship(tx, ctx.actor, { fromProductId: product.id, toProductId: product.id, type: "UPSELL", rationale: "Self relationship is invalid." }))).rejects.toThrow();
    const [rule] = await q((tx) => tx.insert(crossSellRules).values({ organizationId: orgId, sourceProductId: product.id, destinationProductId: dest.id, name: "To dest", message: "Try Dest App for analytics.", ctaUrl: `https://${dest.domain}/`, relationshipId: rel.id }).returning());
    const ref = `xs-${uid()}`;
    const ident = await q(async (tx) => (await tx.insert(identities).values({ organizationId: orgId, externalRef: ref }).returning())[0]);
    await q((tx) => tx.insert(crossSellEvents).values([
      { organizationId: orgId, ruleId: rule.id, identityId: ident.id, type: "IMPRESSION" },
      { organizationId: orgId, ruleId: rule.id, identityId: ident.id, type: "CLICK" },
      { organizationId: orgId, ruleId: rule.id, identityId: ident.id, type: "CONVERSION", revenueCents: 999 },
    ]));
    const destKey = await createKey(orgId, "SECRET", { productId: dest.id, scopes: ["revenue:write"] });
    const v = vid();
    await send({ type: "PAGE_VIEW", visitorId: v, url: `https://${dest.domain}/?utm_source=beacon-cross-sell&utm_medium=in-product&utm_campaign=${rule.id}`, occurredAt: minutesAgo(20) }, { key: destKey, origin: null });
    await send({ type: "SIGNUP_COMPLETED", visitorId: v, identityRef: ref, occurredAt: minutesAgo(10) }, { key: destKey, origin: null });
    await send({ type: "SUBSCRIPTION_STARTED", identityRef: ref, occurredAt: minutesAgo(5) }, { key: destKey, origin: null });
    await q((tx) => recordRevenue(tx, orgId, dest.id, { provider: "api", externalId: `xs-${uid()}`, type: "NEW", amountCents: 2500, mrrDeltaCents: 2500, currency: "EUR", identityRef: ref }));
    const f = (await q((tx) => ruleFunnels(tx, orgId))).get(rule.id)!;
    expect(f).toMatchObject({ impressions: 1, clicks: 1, signups: 1, subscriptions: 1, revenue: [{ currency: "EUR", cents: 2500 }], reportedRevenueCents: 999 });
    // Deleting the relationship keeps the rule (link set null).
    await q((tx) => tx.delete(productRelationships).where(eq(productRelationships.id, rel.id)));
    expect((await q((tx) => tx.query.crossSellRules.findFirst({ where: eq(crossSellRules.id, rule.id) })))!.relationshipId).toBeNull();
  });
});

describe("tenant isolation of the new tables", () => {
  it("attribution_credits, webhook_inbox, analytics_daily and product_relationships are invisible to another organisation", async () => {
    const other = await newOrg("measure-other");
    const counts = async (id: string) =>
      withOrg(id, async (tx) => ({
        credits: (await tx.select().from(attributionCredits)).length,
        inbox: (await tx.select().from(webhookInbox)).length,
        analytics: (await tx.select().from(analyticsDaily)).length,
        relationships: (await tx.select().from(productRelationships)).length,
      }));
    const mine = await counts(orgId);
    expect(mine.credits).toBeGreaterThan(0);
    expect(mine.inbox).toBeGreaterThan(0);
    expect(mine.analytics).toBeGreaterThan(0);
    expect(await counts(other.org.id)).toEqual({ credits: 0, inbox: 0, analytics: 0, relationships: 0 });
    const [p2] = await withOrg(other.org.id, (tx) => tx.insert(products).values({ organizationId: other.org.id, slug: `o-${uid()}`, name: "Other" }).returning());
    // Writing a row for another organisation is rejected by RLS.
    await expect(withOrg(other.org.id, (tx) => tx.insert(productRelationships).values({ organizationId: orgId, fromProductId: p2.id, toProductId: product.id, type: "UPSELL", rationale: "cross tenant attempt" }))).rejects.toThrow();
  });
});
