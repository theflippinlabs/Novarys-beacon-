import { createHmac, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mapStripeEvent, verifyStripeSignature } from "@/services/stripe";
import { backoffMs } from "@/jobs/queue";
import { createBingAdapter, parseBingDate } from "@/integrations/bing";
import { createSearchConsoleAdapter } from "@/integrations/gsc";

describe("verifyStripeSignature", () => {
  const secret = "whsec_test";
  const body = JSON.stringify({ id: "evt_1", type: "invoice.paid" });
  const t = 1_750_000_000;
  const sign = (s: string, ts = t, b = body) => createHmac("sha256", s).update(`${ts}.${b}`).digest("hex");
  const now = t * 1000;

  it("accepts a valid signature", () => {
    expect(verifyStripeSignature(body, `t=${t},v1=${sign(secret)}`, secret, 300, now)).toBe(true);
  });
  it("rejects a wrong secret or a modified body", () => {
    expect(verifyStripeSignature(body, `t=${t},v1=${sign("whsec_other")}`, secret, 300, now)).toBe(false);
    expect(verifyStripeSignature(body + " ", `t=${t},v1=${sign(secret)}`, secret, 300, now)).toBe(false);
  });
  it("rejects timestamps outside the tolerance (replay)", () => {
    expect(verifyStripeSignature(body, `t=${t},v1=${sign(secret)}`, secret, 300, now + 301_000)).toBe(false);
    expect(verifyStripeSignature(body, `t=${t},v1=${sign(secret)}`, secret, 300, now - 301_000)).toBe(false);
    expect(verifyStripeSignature(body, `t=${t},v1=${sign(secret)}`, secret, 300, now + 299_000)).toBe(true);
  });
  it("accepts any matching v1 among several (secret rotation)", () => {
    expect(verifyStripeSignature(body, `t=${t},v1=${"0".repeat(64)},v0=abc,v1=${sign(secret)}`, secret, 300, now)).toBe(true);
    expect(verifyStripeSignature(body, `t=${t},v1=${"0".repeat(64)},v1=${sign("x")}`, secret, 300, now)).toBe(false);
  });
  it("rejects missing header, secret, timestamp or signature", () => {
    expect(verifyStripeSignature(body, null, secret, 300, now)).toBe(false);
    expect(verifyStripeSignature(body, `t=${t},v1=${sign(secret)}`, "", 300, now)).toBe(false);
    expect(verifyStripeSignature(body, `v1=${sign(secret)}`, secret, 300, now)).toBe(false);
    expect(verifyStripeSignature(body, `t=${t}`, secret, 300, now)).toBe(false);
  });
});

describe("mapStripeEvent", () => {
  const created = 1_750_000_000;
  const occurredAt = new Date(created * 1000).toISOString();

  it("maps a first invoice to NEW with monthly MRR (yearly prices divided by 12)", () => {
    const r = mapStripeEvent({
      id: "evt_1",
      type: "invoice.paid",
      created,
      data: {
        object: {
          id: "in_1",
          customer: "cus_1",
          subscription: "sub_1",
          billing_reason: "subscription_create",
          amount_paid: 17_800,
          currency: "usd",
          lines: {
            data: [
              { price: { unit_amount: 2_900, recurring: { interval: "month" }, metadata: { beacon_product: "liveguard" } }, quantity: 2 },
              { price: { unit_amount: 12_000, recurring: { interval: "year" } }, quantity: 1 },
            ],
          },
        },
      },
    });
    expect(r).toMatchObject({
      productSlug: "liveguard",
      provider: "stripe",
      externalId: "evt_1",
      type: "NEW",
      amountCents: 17_800,
      mrrDeltaCents: 5_800 + 1_000,
      currency: "USD",
      identityRef: "stripe:cus_1",
      occurredAt,
      subscription: { externalId: "sub_1", status: "ACTIVE", mrrCents: 6_800 },
    });
  });

  it("maps renewals and one-time invoices without MRR delta", () => {
    const renewal = mapStripeEvent({
      id: "evt_2",
      type: "invoice.paid",
      created,
      data: { object: { id: "in_2", subscription: "sub_1", billing_reason: "subscription_cycle", amount_paid: 2_900, metadata: { beacon_identity: "id-42" }, lines: { data: [{ price: { unit_amount: 2_900, recurring: { interval: "month" } } }] } } },
    });
    expect(renewal).toMatchObject({ type: "RENEWAL", mrrDeltaCents: 0, currency: "EUR", identityRef: "id-42" });
    const once = mapStripeEvent({ id: "evt_3", type: "invoice.paid", created, data: { object: { id: "in_3", amount_paid: 500 } } });
    expect(once).toMatchObject({ type: "ONE_TIME", amountCents: 500, subscription: undefined, identityRef: undefined });
  });

  it("maps a deleted subscription to CHURN with a negative MRR delta", () => {
    const r = mapStripeEvent({
      id: "evt_4",
      type: "customer.subscription.deleted",
      created,
      data: { object: { id: "sub_1", customer: "cus_1", status: "canceled", items: { data: [{ price: { unit_amount: 2_900, recurring: { interval: "month" }, nickname: "Pro" }, quantity: 1 }] } } },
    });
    expect(r).toMatchObject({ type: "CHURN", amountCents: 0, mrrDeltaCents: -2_900, subscription: { externalId: "sub_1", plan: "Pro", status: "CANCELLED", mrrCents: 0 } });
  });

  it("maps subscription updates to UPGRADE/DOWNGRADE and ignores no-op updates", () => {
    const items = (amount: number) => ({ data: [{ price: { unit_amount: amount, recurring: { interval: "month" } }, quantity: 1 }] });
    const up = mapStripeEvent({ id: "e", type: "customer.subscription.updated", created, data: { object: { id: "sub_1", status: "active", items: items(4_900) }, previous_attributes: { items: items(2_900) } } });
    expect(up).toMatchObject({ type: "UPGRADE", mrrDeltaCents: 2_000 });
    const down = mapStripeEvent({ id: "e", type: "customer.subscription.updated", created, data: { object: { id: "sub_1", status: "active", items: items(900) }, previous_attributes: { items: items(2_900) } } });
    expect(down).toMatchObject({ type: "DOWNGRADE", mrrDeltaCents: -2_000 });
    expect(mapStripeEvent({ id: "e", type: "customer.subscription.updated", created, data: { object: { id: "sub_1", status: "active", items: items(900) }, previous_attributes: { metadata: {} } } })).toBeNull();
    const pastDue = mapStripeEvent({ id: "e", type: "customer.subscription.updated", created, data: { object: { id: "sub_1", status: "past_due", items: items(900) }, previous_attributes: { status: "active" } } });
    expect(pastDue).toMatchObject({ type: "RENEWAL", mrrDeltaCents: 0, subscription: { status: "PAST_DUE" } });
  });

  it("maps charge.refunded to a negative REFUND and ignores unknown types", () => {
    const r = mapStripeEvent({ id: "evt_5", type: "charge.refunded", created, data: { object: { id: "ch_1", amount_refunded: 1_500, currency: "eur", customer: "cus_9", metadata: { beacon_product: "p" } } } });
    expect(r).toMatchObject({ type: "REFUND", amountCents: -1_500, mrrDeltaCents: 0, productSlug: "p", identityRef: "stripe:cus_9", currency: "EUR" });
    expect(mapStripeEvent({ id: "evt_6", type: "customer.created", created, data: { object: { id: "cus_1" } } })).toBeNull();
  });
});

describe("backoffMs", () => {
  it("doubles from 30s with ±20% jitter and caps at 1h", () => {
    expect(backoffMs(1, () => 0.5)).toBe(30_000);
    expect(backoffMs(1, () => 0)).toBe(24_000);
    expect(backoffMs(1, () => 1)).toBe(36_000);
    expect(backoffMs(2, () => 0.5)).toBe(60_000);
    expect(backoffMs(3, () => 0.5)).toBe(120_000);
    expect(backoffMs(0, () => 0.5)).toBe(30_000);
    expect(backoffMs(30, () => 0.5)).toBe(3_600_000);
    expect(backoffMs(30, () => 1)).toBe(4_320_000);
  });
});

describe("Bing Webmaster", () => {
  it("parseBingDate handles WCF dates and plain strings", () => {
    expect(parseBingDate("/Date(1700000000000-0800)/")).toBe("2023-11-14");
    expect(parseBingDate("/Date(0)/")).toBe("1970-01-01");
    expect(parseBingDate("2024-05-01T00:00:00")).toBe("2024-05-01");
  });

  it("fetchMetrics filters to the requested range", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(url);
      return new Response(
        JSON.stringify({
          d: [
            { Date: "/Date(1767225600000)/", Impressions: 100, Clicks: 5 }, // 2026-01-01
            { Date: "/Date(1767312000000)/", Impressions: 200, Clicks: 7 }, // 2026-01-02
          ],
        }),
      );
    }) as unknown as typeof fetch;
    const rows = await createBingAdapter(fakeFetch).fetchMetrics({ siteUrl: "https://acme.example/" }, { apiKey: "k" }, { start: "2026-01-02", end: "2026-01-31" });
    expect(rows).toEqual([
      { metric: "search_impressions", day: "2026-01-02", value: 200 },
      { metric: "search_clicks", day: "2026-01-02", value: 7 },
    ]);
    expect(new URL(calls[0]).searchParams.get("siteUrl")).toBe("https://acme.example/");
  });
});

describe("Google Search Console adapter", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const serviceAccountJson = JSON.stringify({ client_email: "beacon@proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }).toString() });

  function fakeGoogle(opts: { tokenStatus?: number } = {}) {
    const requests: { url: string; body: string; auth?: string }[] = [];
    const impl = (async (input: string, init: RequestInit) => {
      const url = String(input);
      const body = init.body instanceof URLSearchParams ? init.body.toString() : String(init.body);
      const headers = init.headers as Record<string, string>;
      requests.push({ url, body, auth: headers?.authorization });
      if (url === "https://oauth2.googleapis.com/token") {
        if (opts.tokenStatus) return new Response("denied", { status: opts.tokenStatus });
        const assertion = new URLSearchParams(body).get("assertion")!;
        const [h, c, sig] = assertion.split(".");
        const verifier = createVerify("RSA-SHA256");
        verifier.update(`${h}.${c}`);
        if (!verifier.verify(publicKey, Buffer.from(sig, "base64url"))) return new Response("bad sig", { status: 401 });
        const claims = JSON.parse(Buffer.from(c, "base64url").toString());
        if (claims.scope !== "https://www.googleapis.com/auth/webmasters.readonly" || claims.iss !== "beacon@proj.iam.gserviceaccount.com") return new Response("bad claims", { status: 400 });
        return new Response(JSON.stringify({ access_token: "ya29.test" }));
      }
      if (headers?.authorization !== "Bearer ya29.test") return new Response("unauthorized", { status: 401 });
      const q = JSON.parse(body) as { dimensions?: string[] };
      const dim = q.dimensions?.[0];
      const rows =
        dim === "date"
          ? [{ keys: ["2026-01-01"], clicks: 3, impressions: 100, ctr: 0.03, position: 7.5 }]
          : dim === "query"
            ? [{ keys: ["tiktok moderation"], clicks: 2, impressions: 40, ctr: 0.05, position: 4 }]
            : dim === "page"
              ? [
                  { keys: ["https://acme.example/a"], clicks: 1, impressions: 10, ctr: 0.1, position: 3 },
                  { keys: ["https://acme.example/b"], clicks: 0, impressions: 0, ctr: 0, position: 0 },
                ]
              : [];
      return new Response(JSON.stringify({ rows }));
    }) as unknown as typeof fetch;
    return { impl, requests };
  }

  it("signs a JWT, exchanges it for a token and produces metric rows", async () => {
    const { impl, requests } = fakeGoogle();
    const rows = await createSearchConsoleAdapter(impl).fetchMetrics({ siteUrl: "sc-domain:acme.example" }, { serviceAccountJson }, { start: "2026-01-01", end: "2026-01-28" });
    expect(rows).toEqual([
      { metric: "search_impressions", day: "2026-01-01", value: 100 },
      { metric: "search_clicks", day: "2026-01-01", value: 3 },
      { metric: "search_position", day: "2026-01-01", value: 7.5, weight: 100 },
      { metric: "query_impressions", day: "2026-01-28", dimension: "tiktok moderation", value: 40 },
      { metric: "query_clicks", day: "2026-01-28", dimension: "tiktok moderation", value: 2 },
      { metric: "query_position", day: "2026-01-28", dimension: "tiktok moderation", value: 4, weight: 40 },
      { metric: "indexed_pages_with_impressions", day: "2026-01-28", value: 1 },
    ]);
    const api = requests.filter((r) => r.url.includes("searchAnalytics"));
    expect(api).toHaveLength(3);
    expect(api[0].url).toBe("https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aacme.example/searchAnalytics/query");
    expect(JSON.parse(api[0].body)).toEqual({ startDate: "2026-01-01", endDate: "2026-01-28", dimensions: ["date"], rowLimit: 500 });
  });

  it("surfaces OAuth failures and invalid service accounts", async () => {
    const { impl } = fakeGoogle({ tokenStatus: 403 });
    await expect(createSearchConsoleAdapter(impl).fetchMetrics({ siteUrl: "x" }, { serviceAccountJson }, { start: "a", end: "b" })).rejects.toThrow(/google-oauth HTTP 403/);
    const ok = fakeGoogle();
    await expect(createSearchConsoleAdapter(ok.impl).fetchMetrics({ siteUrl: "x" }, { serviceAccountJson: "{not json" }, { start: "a", end: "b" })).rejects.toThrow(/invalid/);
    const evil = JSON.stringify({ ...JSON.parse(serviceAccountJson), token_uri: "https://evil.example/token" });
    await expect(createSearchConsoleAdapter(ok.impl).fetchMetrics({ siteUrl: "x" }, { serviceAccountJson: evil }, { start: "a", end: "b" })).rejects.toThrow(/Unexpected token_uri/);
    expect(ok.requests).toHaveLength(0);
    const test = await createSearchConsoleAdapter(impl).testConnection({ siteUrl: "x" }, { serviceAccountJson });
    expect(test.ok).toBe(false);
    expect(test.message).toMatch(/403/);
  });
});
