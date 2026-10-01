import { describe, expect, it } from "vitest";
import { allocateCents, ATTRIBUTION_MODELS, attribute, creditsFor, DEFAULT_ATTRIBUTION, type Touch } from "@/core/attribution/attribution";
import { analyticsAllowed, canonicalEvent, eventTypesFor, forbiddenPublishableFields, lifecycleStatus, PUBLISHABLE_EVENTS, utmFromUrl, utmParams } from "@/core/conversions/events";
import { invoiceSubscription, lineMonthlyCents, mapStripeEvent, type StripeEvent } from "@/services/stripe";
import { linkLabels, pagePath } from "@/services/journey";
import { trackerSource } from "@/lib/tracker";
import { formatValue } from "@/components/ui";

const day = (d: number) => new Date(Date.UTC(2026, 0, d));
const t = (id: string, channel: Touch["channel"], d: number, extra: Partial<Touch> = {}): Touch => ({ id, channel, occurredAt: day(d), ...extra });
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

describe("attribution models", () => {
  const touches = [t("a", "ORGANIC_SEARCH", 10), t("b", "DIRECT", 12), t("c", "SOCIAL", 14), t("d", "AI_REFERRAL", 16), t("e", "DIRECT", 18)];

  it("weights sum to 1 for every model and every touch count", () => {
    for (let n = 0; n <= touches.length; n++)
      for (const m of ATTRIBUTION_MODELS) {
        const credits = creditsFor(touches.slice(0, n), day(20), m, 30);
        expect(sum(credits.map((c) => c.weight))).toBeCloseTo(1, 10);
      }
  });

  it("first touch, last non-direct touch, linear and position-based", () => {
    expect(creditsFor(touches, day(20), "FIRST_TOUCH", 30)).toEqual([{ touchId: "a", channel: "ORGANIC_SEARCH", campaignId: null, weight: 1 }]);
    expect(creditsFor(touches, day(20), "LAST_TOUCH", 30)).toMatchObject([{ touchId: "d", channel: "AI_REFERRAL", weight: 1 }]);
    expect(creditsFor(touches, day(20), "LINEAR", 30).map((c) => c.weight)).toEqual([0.2, 0.2, 0.2, 0.2, 0.2]);
    const pb = creditsFor(touches, day(20), "POSITION_BASED", 30);
    expect(pb.map((c) => c.touchId)).toEqual(["a", "b", "c", "d", "e"]);
    expect(pb[0].weight).toBe(0.4);
    expect(pb[4].weight).toBe(0.4);
    for (const mid of pb.slice(1, 4)) expect(mid.weight).toBeCloseTo(0.2 / 3, 10);
    expect(creditsFor(touches.slice(0, 2), day(20), "POSITION_BASED", 30).map((c) => c.weight)).toEqual([0.5, 0.5]);
    expect(creditsFor(touches.slice(0, 1), day(20), "POSITION_BASED", 30).map((c) => c.weight)).toEqual([1]);
  });

  it("no touch in the window credits UNATTRIBUTED, never DIRECT", () => {
    for (const m of ATTRIBUTION_MODELS) expect(creditsFor([t("old", "SOCIAL", 1)], day(40), m, 7)).toEqual([{ touchId: null, channel: "UNATTRIBUTED", campaignId: null, weight: 1 }]);
    // A measured direct visit is DIRECT.
    expect(attribute([t("d", "DIRECT", 19)], day(20), DEFAULT_ATTRIBUTION).channel).toBe("DIRECT");
  });

  it("allocates cents exactly (largest remainder), refunds keep their sign", () => {
    expect(allocateCents(1000, [1 / 3, 1 / 3, 1 / 3])).toEqual([334, 333, 333]);
    expect(sum(allocateCents(999, [0.4, 0.2 / 3, 0.2 / 3, 0.2 / 3, 0.4]))).toBe(999);
    expect(allocateCents(-500, [0.5, 0.5])).toEqual([-250, -250]);
    expect(allocateCents(0, [1])).toEqual([0]);
  });
});

describe("event vocabulary and consent", () => {
  it("maps legacy names to the Phase 2 canonical names and counts both", () => {
    expect(canonicalEvent("SIGNUP")).toBe("SIGNUP_COMPLETED");
    expect(canonicalEvent("SUBSCRIBED")).toBe("SUBSCRIPTION_STARTED");
    expect(canonicalEvent("CANCELLED")).toBe("SUBSCRIPTION_CANCELLED");
    expect(canonicalEvent("TRIAL_STARTED")).toBe("TRIAL_STARTED");
    expect(eventTypesFor("SIGNUP_COMPLETED")).toEqual(["SIGNUP_COMPLETED", "SIGNUP"]);
    expect(eventTypesFor("PRODUCT_VIEWED")).toEqual(["PRODUCT_VIEWED"]);
    expect(lifecycleStatus("SUBSCRIPTION_UPGRADED")).toBe("ACTIVE");
    expect(lifecycleStatus("TRIAL_STARTED")).toBe("TRIALING");
  });

  it("publishable keys: browser events only, no identity, consent or traits", () => {
    expect(PUBLISHABLE_EVENTS.has("PAGE_VIEW")).toBe(true);
    expect(PUBLISHABLE_EVENTS.has("SIGNUP_COMPLETED")).toBe(false);
    expect(forbiddenPublishableFields({ type: "PAGE_VIEW", identityRef: "u", consent: { analytics: true }, traits: [], emailHashInput: "a@b.c" })).toEqual(["identityRef", "emailHashInput", "consent", "traits"]);
    expect(forbiddenPublishableFields({ type: "PAGE_VIEW", visitorId: "v" })).toEqual([]);
  });

  it("analytics consent: explicit refusal blocks linkage, unknown consent does not", () => {
    const epoch = new Date(0).toISOString();
    expect(analyticsAllowed(null)).toBe(true);
    expect(analyticsAllowed({ analytics: false, marketing: false, crossProduct: false, updatedAt: epoch })).toBe(true);
    expect(analyticsAllowed({ analytics: false, marketing: false, crossProduct: false, updatedAt: "2026-05-01T00:00:00.000Z" })).toBe(false);
    expect(analyticsAllowed({ analytics: true, marketing: false, crossProduct: false, updatedAt: "2026-05-01T00:00:00.000Z" })).toBe(true);
    // Consent sent with the event wins over the stored one.
    expect(analyticsAllowed({ analytics: true, marketing: false, crossProduct: false, updatedAt: "2026-05-01T00:00:00.000Z" }, { analytics: false, marketing: false, crossProduct: false })).toBe(false);
  });

  it("parses UTM from a URL", () => {
    const u = utmFromUrl(new URL("https://x.example/?utm_source=News&utm_medium=email&utm_campaign=launch&utm_term=t&utm_content=c&other=1"));
    expect(u).toEqual({ source: "News", medium: "email", campaign: "launch", term: "t", content: "c" });
    expect(utmParams({ source: "a", campaign: "b" })).toEqual({ utm_source: "a", utm_campaign: "b" });
  });
});

describe("Stripe event mapping", () => {
  const ev = (type: string, object: Record<string, unknown>, extra: Partial<StripeEvent["data"]> = {}): StripeEvent => ({ id: "evt_1", type, created: 1_780_000_000, data: { object: { id: "obj_1", ...object }, ...extra } });

  it("legacy invoice shape", () => {
    const m = mapStripeEvent(
      ev("invoice.paid", {
        customer: "cus_1",
        subscription: "sub_1",
        billing_reason: "subscription_create",
        amount_paid: 2900,
        currency: "usd",
        lines: { data: [{ price: { unit_amount: 2900, recurring: { interval: "month" }, metadata: { beacon_product: "app" } }, quantity: 1 }] },
      }),
    );
    expect(m.action).toBe("record");
    if (m.action !== "record") return;
    expect(m.items[0]).toMatchObject({ productSlug: "app", type: "NEW", amountCents: 2900, mrrDeltaCents: 2900, currency: "USD", identityRef: "stripe:cus_1", identityFallback: true, subscription: { externalId: "sub_1", mrrCents: 2900 } });
  });

  it("current (basil) invoice shape: parent.subscription_details and line.pricing", () => {
    const start = 1_780_000_000;
    const o = {
      customer: "cus_2",
      billing_reason: "subscription_create",
      amount_paid: 12000,
      currency: "eur",
      parent: { type: "subscription_details", subscription_details: { subscription: "sub_2", metadata: { beacon_identity: "user_42", beacon_product: "app" } } },
      lines: { data: [{ amount: 12000, quantity: 1, period: { start, end: start + 365 * 86_400 }, pricing: { type: "price_details", price_details: { price: "price_1", product: "prod_1" }, unit_amount_decimal: "12000" }, parent: { type: "subscription_item_details", subscription_item_details: { proration: false, subscription: "sub_2" } } }] },
    };
    expect(invoiceSubscription(o as never)).toBe("sub_2");
    expect(lineMonthlyCents(o.lines.data[0] as never)).toBe(1000);
    const m = mapStripeEvent(ev("invoice.paid", o));
    if (m.action !== "record") throw new Error("expected record");
    expect(m.items[0]).toMatchObject({ productSlug: "app", identityRef: "user_42", identityFallback: false, mrrDeltaCents: 1000, currency: "EUR", subscription: { externalId: "sub_2", mrrCents: 1000 } });
  });

  it("refunds: one event per refund object; cumulative fallback otherwise", () => {
    const withList = mapStripeEvent(ev("charge.refunded", { currency: "eur", amount_refunded: 700, refunds: { data: [{ id: "re_1", amount: 300, status: "succeeded" }, { id: "re_2", amount: 400, status: "succeeded" }] } }));
    if (withList.action !== "record") throw new Error("expected record");
    expect(withList.items.map((i) => [i.externalId, i.amountCents, i.sourceRef])).toEqual([
      ["refund:re_1", -300, "obj_1"],
      ["refund:re_2", -400, "obj_1"],
    ]);
    const cumulative = mapStripeEvent(ev("charge.refunded", { currency: "eur", amount_refunded: 700 }));
    if (cumulative.action !== "record") throw new Error("expected record");
    expect(cumulative.items[0]).toMatchObject({ cumulativeRefundCents: 700, sourceRef: "obj_1" });
    const refund = mapStripeEvent(ev("refund.created", { id: "re_1", amount: 300, currency: "eur", charge: "ch_1", status: "succeeded" }));
    if (refund.action !== "record") throw new Error("expected record");
    expect(refund.items[0]).toMatchObject({ externalId: "refund:re_1", amountCents: -300, sourceRef: "ch_1" });
  });

  it("subscription created is subscription-only; checkout links identity; missing currency and unknown types are ignored", () => {
    const created = mapStripeEvent(ev("customer.subscription.created", { status: "trialing", currency: "eur", customer: "cus_3", items: { data: [{ price: { unit_amount: 1000, recurring: { interval: "month" } }, quantity: 1 }] } }));
    if (created.action !== "record") throw new Error("expected record");
    expect(created.items[0]).toMatchObject({ subscriptionOnly: true, subscription: { status: "TRIALING", mrrCents: 1000 } });
    expect(mapStripeEvent(ev("checkout.session.completed", { mode: "subscription", subscription: "sub_9", client_reference_id: "user_9" }))).toEqual({ action: "link", subscriptionExternalId: "sub_9", identityRef: "user_9", productSlug: undefined });
    expect(mapStripeEvent(ev("invoice.paid", { amount_paid: 100 })).action).toBe("ignore");
    expect(mapStripeEvent(ev("customer.created", {})).action).toBe("ignore");
  });
});

describe("currency formatting and journey labels", () => {
  it("never assumes a currency", () => {
    expect(formatValue(123456, "money", "USD", "en-US")).toBe("$1,235");
    expect(formatValue(123456, "money", null, "en-US")).toBe("1,234.56");
  });

  it("normalises page paths and labels links", () => {
    expect(pagePath("https://x.example/pricing/?a=1")).toBe("/pricing");
    expect(pagePath("/pricing?utm_source=x")).toBe("/pricing");
    expect(pagePath("(not set)")).toBeNull();
    expect(pagePath("https://x.example/")).toBe("/");
    expect(linkLabels({ search: { clicks: 1, impressions: 9 }, analytics: { sessions: 3, organicSessions: 1, keyEvents: 0 }, beacon: { visitors: 2, signups: 1, subscriptions: 0 } })).toEqual({ searchToAnalytics: "MODELLED", analyticsToBeacon: "MODELLED", searchToBeacon: "MODELLED", beaconToConversion: "MEASURED" });
    expect(linkLabels({ search: null, analytics: null, beacon: null })).toEqual({ searchToAnalytics: "UNKNOWN", analyticsToBeacon: "UNKNOWN", searchToBeacon: "UNKNOWN", beaconToConversion: "UNKNOWN" });
  });
});

describe("tracker", () => {
  it("is small, valid JavaScript, with sessions, SPA navigation, UTM capture and DNT/GPC", () => {
    const src = trackerSource("https://beacon.example/api/v1/events");
    expect(src.length).toBeLessThan(3000);
    expect(() => new Function(src)).not.toThrow();
    for (const s of ["sessionStorage", "18e5", "pushState", "replaceState", "popstate", "utm_", "doNotTrack", "globalPrivacyControl", "landingUrl", "sessionId"]) expect(src).toContain(s);
    for (const s of ["identityRef", "consent"]) expect(src).not.toContain(s);
  });
});
