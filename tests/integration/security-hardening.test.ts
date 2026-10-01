import sharp from "sharp";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { asSystem, closeDb, withOrg } from "@/db";
import { crossSellRules, identities, memberships, organizations, products, providerCredentials, users } from "@/db/schema";
import { GET as entityGET } from "@/app/api/v1/entity/[org]/[product]/route";
import { GET as llmsGET } from "@/app/p/[org]/llms.txt/route";
import { GET as sitemapGET } from "@/app/p/[org]/sitemap.xml/route";
import { GET as mediaGET } from "@/app/api/media/[id]/route";
import { POST as crossSellEventPOST } from "@/app/api/v1/cross-sell/event/route";
import { createSession } from "@/lib/auth/service";
import { hashPassword } from "@/lib/security/crypto";
import { resetEnvCache } from "@/lib/env";
import { ingestImage } from "@/services/media";
import { saveIntegration, loadSecret } from "@/services/visibility";
import { rotateProviderCredentials } from "@/db/rotate-secrets";
import { createKey, ipHeader, jsonRequest, newOrg, params, seedCompleteProduct, uid } from "./helpers";

type Ctx = Awaited<ReturnType<typeof newOrg>>;
let A: Ctx;
let productSlug: string;

beforeAll(async () => {
  A = await newOrg("sec");
  productSlug = (await seedCompleteProduct(A.org.id, { name: `Sec Product ${uid()}`, onboarded: true })).product.slug;
});
afterAll(closeDb);

const setPublic = (enabled: boolean) =>
  asSystem(async (tx) => {
    const org = await tx.query.organizations.findFirst({ where: eq(organizations.id, A.org.id) });
    await tx.update(organizations).set({ settings: { ...org!.settings, publicSiteEnabled: enabled } }).where(eq(organizations.id, A.org.id));
  });

describe("public site switch (settings.publicSiteEnabled)", () => {
  const req = (path: string) => new Request(`http://localhost${path}`, { headers: ipHeader() });
  it("serves public surfaces by default and answers 404 everywhere once turned off", async () => {
    const slug = A.org.slug;
    expect((await entityGET(req(`/api/v1/entity/${slug}/${productSlug}`), params({ org: slug, product: productSlug }))).status).toBe(200);
    expect((await llmsGET(req(`/p/${slug}/llms.txt`), params({ org: slug }))).status).toBe(200);
    await setPublic(false);
    try {
      expect((await entityGET(req(`/api/v1/entity/${slug}/${productSlug}`), params({ org: slug, product: productSlug }))).status).toBe(404);
      expect((await llmsGET(req(`/p/${slug}/llms.txt`), params({ org: slug }))).status).toBe(404);
      expect((await sitemapGET(req(`/p/${slug}/sitemap.xml`), params({ org: slug }))).status).toBe(404);
    } finally {
      await setPublic(true);
    }
  });
});

describe("private media", () => {
  it("is served only to the member who uploaded it", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123" } }).png().toBuffer();
    const r = await withOrg(A.org.id, (tx) => ingestImage(tx, A.actor, { data: png, filename: "chat.png", visibility: "PRIVATE" }));
    const [colleague] = await asSystem(async (tx) => tx.insert(users).values({ email: `colleague-${uid()}@example.test`, name: "Colleague", passwordHash: await hashPassword("correct horse battery 42") }).returning());
    await asSystem((tx) => tx.insert(memberships).values({ organizationId: A.org.id, userId: colleague.id, role: "ADMIN" }));
    const get = (token: string) => mediaGET(new Request(`http://localhost/api/media/${r.id}`, { headers: { cookie: `beacon_session=${token}` } }), params({ id: r.id }));
    expect((await get((await createSession(colleague.id)).token)).status).toBe(404);
    expect((await get((await createSession(A.user.id)).token)).status).toBe(200);
  });
});

describe("POST /api/v1/cross-sell/event", () => {
  it("requires a cross-sell scope and a product involved in the rule; caps the body", async () => {
    const [src, dst, other] = await withOrg(A.org.id, async (tx) => {
      const mk = async (n: string) => (await tx.insert(products).values({ organizationId: A.org.id, slug: `${n}-${uid()}`, name: n }).returning())[0];
      return [await mk("xs-src"), await mk("xs-dst"), await mk("xs-other")];
    });
    const ref = `ref-${uid()}`;
    const rule = await withOrg(A.org.id, async (tx) => {
      await tx.insert(identities).values({ organizationId: A.org.id, externalRef: ref });
      return (await tx.insert(crossSellRules).values({ organizationId: A.org.id, sourceProductId: src.id, destinationProductId: dst.id, name: "r", message: "Try it now", ctaUrl: "https://dst.example/" }).returning())[0];
    });
    const send = (key: string, body: unknown = { identityRef: ref, ruleId: rule.id, type: "CLICK" }) =>
      crossSellEventPOST(jsonRequest("http://localhost/api/v1/cross-sell/event", body, { authorization: `Bearer ${key}` }));
    expect((await send(await createKey(A.org.id, "SECRET", { productId: src.id, scopes: ["events:write"] }))).status).toBe(401);
    expect((await send(await createKey(A.org.id, "SECRET", { productId: null, scopes: ["crosssell:read"] }))).status).toBe(401);
    expect((await send(await createKey(A.org.id, "SECRET", { productId: other.id, scopes: ["crosssell:read"] }))).status).toBe(404);
    expect((await send(await createKey(A.org.id, "SECRET", { productId: dst.id, scopes: ["crosssell:write"] }))).status).toBe(201);
    expect((await send("x", { identityRef: "x".repeat(10_000), ruleId: rule.id, type: "CLICK" })).status).toBe(413);
  });
});

describe("pnpm secrets:rotate", () => {
  it("re-encrypts provider credentials with the new primary key and keeps them readable", async () => {
    const old = randomBytes(32).toString("base64");
    const next = randomBytes(32).toString("base64");
    const saved = { BEACON_ENCRYPTION_KEY: process.env.BEACON_ENCRYPTION_KEY, BEACON_ENCRYPTION_KEYS: process.env.BEACON_ENCRYPTION_KEYS };
    process.env.BEACON_ENCRYPTION_KEY = old;
    delete process.env.BEACON_ENCRYPTION_KEYS;
    resetEnvCache();
    try {
      const integ = await withOrg(A.org.id, (tx) => saveIntegration(tx, A.actor, { provider: "BING_WEBMASTER", productId: null, config: { siteUrl: "https://a.example/" }, secret: { apiKey: `bing-${uid()}` } }));
      const before = await withOrg(A.org.id, async (tx) => ({ secret: await loadSecret(tx, integ.id), row: await tx.query.providerCredentials.findFirst({ where: eq(providerCredentials.integrationId, integ.id) }) }));
      expect(before.row!.ciphertext.startsWith("v2:v1:")).toBe(true);
      process.env.BEACON_ENCRYPTION_KEYS = `k2:${next}`;
      resetEnvCache();
      const res = await rotateProviderCredentials({ organizationId: A.org.id });
      expect(res.failed).toEqual([]);
      expect(res.rotated).toBeGreaterThanOrEqual(1);
      const after = await withOrg(A.org.id, async (tx) => ({ secret: await loadSecret(tx, integ.id), row: await tx.query.providerCredentials.findFirst({ where: eq(providerCredentials.integrationId, integ.id) }) }));
      expect(after.row!.ciphertext.startsWith("v2:k2:")).toBe(true);
      expect(after.secret).toEqual(before.secret);
      // Idempotent: nothing left to rotate for this credential.
      expect((await rotateProviderCredentials({ organizationId: A.org.id })).failed).toEqual([]);
    } finally {
      for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k];
      else process.env[k] = v;
      resetEnvCache();
    }
  });
});
