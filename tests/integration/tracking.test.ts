import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, withOrg, type Tx } from "@/db";
import { affiliates, attributionEvents, commissions, conversionEvents, identities, identityProducts, referralCodes, revenueEvents, subscriptions } from "@/db/schema";
import { hmac } from "@/lib/security/crypto";
import { POST as eventsPOST, OPTIONS as eventsOPTIONS } from "@/app/api/v1/events/route";
import { POST as revenuePOST } from "@/app/api/v1/revenue/route";
import { GET as referralGET } from "@/app/r/[code]/route";
import { generateApiKey } from "@/services/tracking";
import { createKey, ipHeader, jsonRequest, newOrg, params, seedCompleteProduct, uid } from "./helpers";

let ctx: Awaited<ReturnType<typeof newOrg>>;
let orgId: string;
let product: Awaited<ReturnType<typeof seedCompleteProduct>>["product"];
let domain: string;
let pk: string;
let sk: string;
let skNoRevenue: string;

const ORIGIN = () => `https://${domain}`;
const sendEvent = (body: Record<string, unknown>, opts: { key?: string | null; origin?: string | null } = {}) => {
  const headers: Record<string, string> = {};
  if (opts.key !== null) headers.authorization = `Bearer ${opts.key ?? pk}`;
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN();
  return eventsPOST(jsonRequest("http://localhost/api/v1/events", body, headers));
};
const sendRevenue = (body: Record<string, unknown>, key = sk) => revenuePOST(jsonRequest("http://localhost/api/v1/revenue", body, { authorization: `Bearer ${key}` }));
const vid = () => `v_${uid()}${uid()}`;
const q = <T,>(fn: (tx: Tx) => Promise<T>) => withOrg(orgId, fn);

beforeAll(async () => {
  ctx = await newOrg("track");
  orgId = ctx.org.id;
  const slug = `shop-${uid()}`;
  ({ product } = await seedCompleteProduct(orgId, { name: "Shop App", slug, domain: `${slug}.example` }));
  domain = product.domain!;
  pk = await createKey(orgId, "PUBLISHABLE", { productId: product.id, allowedOrigins: ["https://partner.example"] });
  sk = await createKey(orgId, "SECRET", { productId: product.id, scopes: ["revenue:write", "identity:write"] });
  skNoRevenue = await createKey(orgId, "SECRET", { productId: product.id, scopes: [] });
});
afterAll(closeDb);

describe("POST /api/v1/events", () => {
  it("OPTIONS answers the CORS preflight", async () => {
    const res = await eventsOPTIONS(new Request("http://localhost/api/v1/events", { method: "OPTIONS", headers: { origin: ORIGIN() } }));
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN());
  });

  it("PAGE_VIEW from an allowed origin with an AI referrer records an AI_REFERRAL touch", async () => {
    const v = vid();
    const res = await sendEvent({ type: "PAGE_VIEW", visitorId: v, url: `${ORIGIN()}/pricing?x=1`, referrer: "https://chatgpt.com/" });
    expect(res.status).toBe(202);
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN());
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, duplicate: false, channel: "AI_REFERRAL" });
    const touches = await q((tx) => tx.select().from(attributionEvents).where(and(eq(attributionEvents.organizationId, orgId), eq(attributionEvents.visitorId, v))));
    expect(touches).toHaveLength(1);
    expect(touches[0]).toMatchObject({ channel: "AI_REFERRAL", referrerHost: "chatgpt.com", landingUrl: `${ORIGIN()}/pricing`, productId: product.id, identityId: null });
    expect(touches[0].ipHash).toMatch(/^[0-9a-f]{64}$/);
    const ev = await q((tx) => tx.query.conversionEvents.findFirst({ where: eq(conversionEvents.id, body.id) }));
    expect(ev).toMatchObject({ type: "PAGE_VIEW", channel: "AI_REFERRAL", pagePath: "/pricing", visitorId: v });
  });

  it("UTM parameters classify the channel and are stored on the touch", async () => {
    const v = vid();
    const res = await sendEvent({ type: "PAGE_VIEW", visitorId: v, url: `${ORIGIN()}/?utm_source=google&utm_medium=cpc&utm_campaign=spring` }, { origin: "https://partner.example" });
    expect(res.status).toBe(202);
    expect((await res.json()).channel).toBe("PAID");
    const t = await q((tx) => tx.query.attributionEvents.findFirst({ where: eq(attributionEvents.visitorId, v) }));
    expect(t).toMatchObject({ channel: "PAID", utm: { utm_source: "google", utm_medium: "cpc", utm_campaign: "spring" } });
    // Internal navigation (own domain referrer, no UTM) is not a touch.
    const v2 = vid();
    await sendEvent({ type: "PAGE_VIEW", visitorId: v2, url: `${ORIGIN()}/docs`, referrer: `${ORIGIN()}/` });
    expect(await q((tx) => tx.select().from(attributionEvents).where(eq(attributionEvents.visitorId, v2)))).toHaveLength(0);
  });

  it("accepts a publishable key in the body (sendBeacon)", async () => {
    const res = await sendEvent({ type: "CTA_CLICK", key: pk, visitorId: vid(), ctaId: "hero" }, { key: null });
    expect(res.status).toBe(202);
  });

  it("publishable keys cannot send lifecycle events (403)", async () => {
    const res = await sendEvent({ type: "SIGNUP", visitorId: vid(), identityRef: `u-${uid()}` });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/secret key/);
  });

  it("rejects a publishable key from a foreign or missing origin (403)", async () => {
    expect((await sendEvent({ type: "PAGE_VIEW", visitorId: vid() }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await sendEvent({ type: "PAGE_VIEW", visitorId: vid() }, { origin: `https://${domain}.evil.example` })).status).toBe(403);
    expect((await sendEvent({ type: "PAGE_VIEW", visitorId: vid() }, { origin: null })).status).toBe(403);
    // Subdomains of the product domain are allowed.
    expect((await sendEvent({ type: "PAGE_VIEW", visitorId: vid() }, { origin: `https://app.${domain}` })).status).toBe(202);
  });

  it("rejects invalid, unknown and revoked keys (401) and bad payloads (400)", async () => {
    expect((await sendEvent({ type: "PAGE_VIEW", visitorId: vid() }, { key: "not-a-key" })).status).toBe(401);
    expect((await sendEvent({ type: "PAGE_VIEW", visitorId: vid() }, { key: generateApiKey("PUBLISHABLE").key })).status).toBe(401);
    expect((await sendEvent({ type: "PAGE_VIEW", visitorId: vid() }, { key: null })).status).toBe(401);
    expect((await sendEvent({ type: "NOT_A_TYPE", visitorId: vid() })).status).toBe(400);
    expect((await eventsPOST(jsonRequest("http://localhost/api/v1/events", "{not json", { authorization: `Bearer ${pk}`, origin: ORIGIN() }))).status).toBe(400);
    expect((await sendEvent({ type: "PAGE_VIEW" })).status).toBe(400); // no visitorId / identityRef
  });

  it("a key of another organisation cannot ingest into this product", async () => {
    const other = await newOrg("track-other");
    const otherSk = await createKey(other.org.id, "SECRET", { scopes: ["revenue:write"] });
    const res = await sendEvent({ type: "SIGNUP", product: product.slug, identityRef: `x-${uid()}` }, { key: otherSk });
    expect(res.status).toBe(404);
  });

  it("deduplicates on idempotencyKey", async () => {
    const key = `idem-${uid()}`;
    const v = vid();
    const a = await (await sendEvent({ type: "CTA_CLICK", visitorId: v, idempotencyKey: key })).json();
    const b = await (await sendEvent({ type: "CTA_CLICK", visitorId: v, idempotencyKey: key })).json();
    expect(a.duplicate).toBe(false);
    // A replay returns the stored event (same id) and writes nothing.
    expect(b).toMatchObject({ ok: true, duplicate: true, id: a.id });
    const rows = await q((tx) => tx.select().from(conversionEvents).where(and(eq(conversionEvents.organizationId, orgId), eq(conversionEvents.idempotencyKey, key))));
    expect(rows).toHaveLength(1);
  });
});

describe("identity linking, revenue attribution and commissions", () => {
  const visitor = vid();
  const identityRef = `user-${uid()}`;

  it("secret-key SIGNUP links earlier anonymous touches to the identity and records acquisition", async () => {
    await sendEvent({ type: "PAGE_VIEW", visitorId: visitor, url: `${ORIGIN()}/`, referrer: "https://www.perplexity.ai/search", occurredAt: new Date(Date.now() - 3_600_000).toISOString() });
    const res = await sendEvent({ type: "SIGNUP", visitorId: visitor, identityRef, traits: ["agency"], consent: { analytics: true, marketing: false, crossProduct: true } }, { key: sk, origin: null });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ channel: "AI_REFERRAL", rule: "last-non-direct-touch" });
    const ident = (await q((tx) => tx.query.identities.findFirst({ where: and(eq(identities.organizationId, orgId), eq(identities.externalRef, identityRef)) })))!;
    expect(ident.acquisition).toMatchObject({ channel: "AI_REFERRAL" });
    expect(ident.acquisition.firstTouchAt).toBeTruthy();
    expect(ident.consent).toMatchObject({ analytics: true, marketing: false, crossProduct: true });
    const touches = await q((tx) => tx.select().from(attributionEvents).where(eq(attributionEvents.visitorId, visitor)));
    expect(touches).toHaveLength(1);
    expect(touches[0].identityId).toBe(ident.id);
    const ip = await q((tx) => tx.query.identityProducts.findFirst({ where: and(eq(identityProducts.identityId, ident.id), eq(identityProducts.productId, product.id)) }));
    expect(ip).toMatchObject({ sharedTraits: ["agency"] });
  });

  it("POST /api/v1/revenue creates a subscription + revenue event attributed to the touch channel; duplicates are idempotent", async () => {
    const externalId = `inv_${uid()}`;
    const body = { externalId, type: "NEW", amountCents: 4900, mrrDeltaCents: 4900, currency: "EUR", identityRef, subscription: { externalId: `sub_${uid()}`, plan: "Pro", status: "ACTIVE", mrrCents: 4900 } };
    const res = await sendRevenue(body);
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json).toMatchObject({ ok: true, duplicate: false, channel: "AI_REFERRAL" });
    const ev = await q((tx) => tx.query.revenueEvents.findFirst({ where: eq(revenueEvents.id, json.id) }));
    expect(ev).toMatchObject({ type: "NEW", amountCents: 4900, channel: "AI_REFERRAL", provider: "api", productId: product.id });
    const sub = await q((tx) => tx.query.subscriptions.findFirst({ where: eq(subscriptions.id, ev!.subscriptionId!) }));
    expect(sub).toMatchObject({ status: "ACTIVE", mrrCents: 4900, channel: "AI_REFERRAL", plan: "Pro" });

    const dup = await sendRevenue(body);
    expect(dup.status).toBe(200);
    expect(await dup.json()).toMatchObject({ ok: true, duplicate: true });
    const rows = await q((tx) => tx.select().from(revenueEvents).where(and(eq(revenueEvents.organizationId, orgId), eq(revenueEvents.externalId, externalId))));
    expect(rows).toHaveLength(1);
  });

  it("revenue requires a secret key with revenue:write", async () => {
    const body = { externalId: `inv_${uid()}`, type: "ONE_TIME", amountCents: 100, currency: "EUR" };
    expect((await sendRevenue(body, skNoRevenue)).status).toBe(401);
    expect((await sendRevenue(body, pk)).status).toBe(401);
    expect((await sendRevenue({ type: "NEW" })).status).toBe(400);
  });

  async function affiliateCode(opts: { emailHash?: string | null; affiliate?: boolean; destination?: string; active?: boolean } = {}) {
    return q(async (tx) => {
      const [aff] = opts.affiliate === false ? [null] : await tx.insert(affiliates).values({ organizationId: orgId, name: `Aff ${uid()}`, status: "ACTIVE", commissionBps: 2000, contactEmailHash: opts.emailHash ?? null }).returning();
      const [code] = await tx
        .insert(referralCodes)
        .values({ organizationId: orgId, code: `C${uid()}`, productId: product.id, affiliateId: aff?.id ?? null, destinationUrl: opts.destination ?? `https://${domain}/signup`, active: opts.active ?? true })
        .returning();
      return { aff, code };
    });
  }

  async function convertViaReferral(code: string, opts: { touchAgoMs: number; email?: string }) {
    const v = vid();
    const ref = `ref-user-${uid()}`;
    const touch = await sendEvent({ type: "PAGE_VIEW", visitorId: v, url: `${ORIGIN()}/?ref=${code}`, occurredAt: new Date(Date.now() - opts.touchAgoMs).toISOString() });
    expect((await touch.json()).channel).toBe("AFFILIATE");
    await sendEvent({ type: "SIGNUP", visitorId: v, identityRef: ref, emailHashInput: opts.email }, { key: sk, origin: null });
    const res = await sendRevenue({ externalId: `inv_${uid()}`, type: "NEW", amountCents: 10_000, mrrDeltaCents: 10_000, currency: "EUR", identityRef: ref, subscription: { externalId: `sub_${uid()}`, status: "ACTIVE", mrrCents: 10_000 } });
    expect(res.status).toBe(201);
    const json = await res.json();
    const comm = await q((tx) => tx.select().from(commissions).where(eq(commissions.revenueEventId, json.id)));
    return { json, comm };
  }

  it("a referral code owned by an ACTIVE affiliate generates a PENDING commission", async () => {
    const { aff, code } = await affiliateCode();
    const { json, comm } = await convertViaReferral(code.code, { touchAgoMs: 3_600_000 });
    expect(json.channel).toBe("AFFILIATE");
    expect(comm).toHaveLength(1);
    expect(comm[0]).toMatchObject({ affiliateId: aff!.id, amountCents: 2000, currency: "EUR", status: "PENDING", fraudFlags: [] });
    expect(comm[0].payableAfter.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    const ev = await q((tx) => tx.query.revenueEvents.findFirst({ where: eq(revenueEvents.id, json.id) }));
    expect(ev!.referralCodeId).toBe(code.id);
  });

  it("SELF_REFERRAL puts the commission ON_HOLD", async () => {
    const email = `affiliate-${uid()}@example.test`;
    const { code } = await affiliateCode({ emailHash: hmac(email, "email") });
    const { comm } = await convertViaReferral(code.code, { touchAgoMs: 3_600_000, email: email.toUpperCase() });
    expect(comm[0]).toMatchObject({ status: "ON_HOLD", fraudFlags: ["SELF_REFERRAL"] });
  });

  it("INSTANT_CONVERSION (click → revenue in < 10 s) puts the commission ON_HOLD", async () => {
    const { code } = await affiliateCode();
    const { comm } = await convertViaReferral(code.code, { touchAgoMs: 0 });
    expect(comm[0].status).toBe("ON_HOLD");
    expect(comm[0].fraudFlags).toContain("INSTANT_CONVERSION");
  });

  it("a ref code without an affiliate is classified as REFERRAL", async () => {
    const { code } = await affiliateCode({ affiliate: false });
    const v = vid();
    const touch = await sendEvent({ type: "PAGE_VIEW", visitorId: v, ref: code.code, url: `${ORIGIN()}/` });
    expect((await touch.json()).channel).toBe("REFERRAL");
  });
});

describe("GET /r/CODE", () => {
  const visit = (code: string, headers: Record<string, string> = {}) => referralGET(new Request(`http://localhost/r/${code}`, { headers: { ...ipHeader(), ...headers } }), params({ code }));

  it("redirects (302) to the product domain with ref=CODE and records an AFFILIATE touch", async () => {
    const { code } = await q(async (tx) => {
      const [aff] = await tx.insert(affiliates).values({ organizationId: orgId, name: "Redirect aff", status: "ACTIVE" }).returning();
      const [c] = await tx.insert(referralCodes).values({ organizationId: orgId, code: `R${uid()}`, productId: product.id, affiliateId: aff.id, destinationUrl: `https://${domain}/signup?plan=pro` }).returning();
      return { code: c };
    });
    const res = await visit(code.code, { referer: "https://blog.example/post", cookie: "bcn_vid=visitor_abcdef123" });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get("location")!);
    expect(loc.origin).toBe(`https://${domain}`);
    expect(loc.pathname).toBe("/signup");
    expect(loc.searchParams.get("ref")).toBe(code.code);
    expect(loc.searchParams.get("plan")).toBe("pro");
    expect(res.headers.get("set-cookie")).toContain("bcn_vid=visitor_abcdef123");
    const touches = await q((tx) => tx.select().from(attributionEvents).where(eq(attributionEvents.referralCodeId, code.id)));
    expect(touches).toHaveLength(1);
    expect(touches[0]).toMatchObject({ channel: "AFFILIATE", visitorId: "visitor_abcdef123", referrerHost: "blog.example", productId: product.id });
  });

  it("records a REFERRAL touch for a code without an affiliate and issues a visitor cookie", async () => {
    const [c] = await q((tx) => tx.insert(referralCodes).values({ organizationId: orgId, code: `F${uid()}`, productId: product.id, destinationUrl: `https://${domain}/` }).returning());
    const res = await visit(c.code);
    expect(res.status).toBe(302);
    expect(res.headers.get("set-cookie")).toMatch(/bcn_vid=[A-Za-z0-9_-]{8,}/);
    const t = await q((tx) => tx.select().from(attributionEvents).where(eq(attributionEvents.referralCodeId, c.id)));
    expect(t.map((x) => x.channel)).toEqual(["REFERRAL"]);
  });

  it("unknown, malformed or inactive codes return 404", async () => {
    expect((await visit(`NOPE${uid()}`)).status).toBe(404);
    expect((await visit("../etc")).status).toBe(404);
    const [c] = await q((tx) => tx.insert(referralCodes).values({ organizationId: orgId, code: `I${uid()}`, productId: product.id, destinationUrl: `https://${domain}/`, active: false }).returning());
    expect((await visit(c.code)).status).toBe(404);
  });

  it("refuses destinations outside the product domain (no open redirect)", async () => {
    for (const dest of ["https://evil.example/phish", `http://${domain}/insecure`, `https://${domain}.evil.example/`]) {
      const [c] = await q((tx) => tx.insert(referralCodes).values({ organizationId: orgId, code: `E${uid()}`, productId: product.id, destinationUrl: dest }).returning());
      const res = await visit(c.code);
      expect(res.status, dest).toBe(404);
      expect(res.headers.get("location")).toBeNull();
      expect(await q((tx) => tx.select().from(attributionEvents).where(eq(attributionEvents.referralCodeId, c.id)))).toHaveLength(0);
    }
  });
});
