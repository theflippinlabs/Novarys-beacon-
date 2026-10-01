import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, withOrg, type Tx } from "@/db";
import { aiVisibilityPrompts, aiVisibilityTests, auditLogs, integrations, organizations, products, referralCodes, revenueEvents, subscriptions } from "@/db/schema";
import { createSession } from "@/lib/auth/service";
import { readFlash } from "@/lib/flash";
import { launchFacts, productLaunchChecklist } from "@/services/launch";
import { approveAsset, createAsset, generateVersion, getAsset, latestVersion, publishAsset, saveEditedVersion } from "@/services/content";
import { exportApprovedAsset } from "@/services/content-export";
import { newOrg, seedCompleteProduct, uid } from "./helpers";

/** Server actions run through act() as in production; only the Next.js request APIs are replaced. */
let session: string | null = null;
class Redirect extends Error {
  constructor(public url: string) {
    super(`redirect ${url}`);
  }
}
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session ? { value: session } : undefined), set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers({ "x-forwarded-for": "10.9.8.31" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
  notFound: () => {
    throw new Redirect("/404");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

const { setPublicSiteAction } = await import("@/app/actions/settings");

/** Run an action and return its redirect target. */
async function redirectOf(action: (fd: FormData) => Promise<unknown>, fields: Record<string, string>): Promise<string> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  try {
    await action(fd);
  } catch (e) {
    if (e instanceof Redirect) return e.url;
    throw e;
  }
  throw new Error("action did not redirect");
}
const paramsOf = (url: string) => Object.fromEntries(new URL(url, "http://x").searchParams.entries());

type Ctx = Awaited<ReturnType<typeof newOrg>>;
let A: Ctx;
const q = <T>(fn: (tx: Tx) => Promise<T>) => withOrg(A.org.id, fn);

beforeAll(async () => {
  A = await newOrg("w3b");
});
afterAll(closeDb);

describe("signed flash messages through act()", () => {
  it("signs the action's message for the signed-in member and drops flash parameters submitted with the form", async () => {
    session = (await createSession(A.user.id)).token;
    const url = await redirectOf(setPublicSiteAction, { _back: "/settings?tab=org&error=Fake+alert&fs=1.00000000000000000000000000000000", enabled: "true" });
    const p = paramsOf(url);
    expect(new URL(url, "http://x").pathname).toBe("/settings");
    expect(p.tab).toBe("org");
    expect(p.ok).toBe("Public site turned on.");
    expect(p.error).toBeUndefined();
    expect(p.fs).toMatch(/^[0-9a-z]+\.[0-9a-f]{32}$/);
    expect(readFlash(p, [A.user.id, null])).toEqual({ kind: "ok", text: "Public site turned on." });
    // Another member (or a signed-out visitor) cannot replay it.
    expect(readFlash(p, [null])).toBeNull();

    const bad = paramsOf(await redirectOf(setPublicSiteAction, { _back: "/settings", enabled: "maybe" }));
    expect(bad.error).toMatch(/Invalid value/);
    expect(readFlash(bad, [A.user.id, null])).toEqual({ kind: "error", text: bad.error });
    session = null;
  });
});

describe("launch checklist: measured items added in wave 3b", () => {
  let productId: string;
  let otherProductId: string;
  let slug: string;

  beforeAll(async () => {
    const { product } = await seedCompleteProduct(A.org.id, { name: `Launch W3b ${uid()}`, onboarded: true });
    productId = product.id;
    slug = product.slug;
    otherProductId = (await seedCompleteProduct(A.org.id, { name: `Other W3b ${uid()}`, onboarded: true })).product.id;
  });

  const facts = () => q((tx) => launchFacts(tx, A.org.id, productId));
  const items = async () => Object.fromEntries((await q((tx) => productLaunchChecklist(tx, A.org.id, productId))).map((i) => [i.key, i]));

  it("starts from the real state: endpoints served, nothing else connected or created", async () => {
    const f = await facts();
    expect(f.publicSite).toEqual({ enabled: true, orgSlug: A.org.slug, listed: true });
    expect(f.knowledge.verified).toBeGreaterThan(0);
    expect(f.bing).toBe("NOT_CONNECTED");
    expect(f.aiVisibility).toEqual({ providerConfigured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.PERPLEXITY_API_KEY), activePrompts: 0, testedPrompts: 0 });
    expect(f.referrals).toEqual({ activeCodes: 0 });
    expect(f.revenue).toEqual({ stripe: "NOT_CONNECTED", events: 0 });
    const b = await items();
    expect(b.hosted_endpoints).toMatchObject({ status: "DONE", href: `/api/v1/entity/${A.org.slug}/${slug}` });
    expect(b.bing.status).toBe("NOT_CONNECTED");
    expect(b.referral_code.status).toBe("TODO");
    expect(b.revenue_source.status).toBe("NOT_CONNECTED");
  });

  it("follows the public site switch and the product's onboarding and lifecycle", async () => {
    const org = (await q((tx) => tx.query.organizations.findFirst({ where: eq(organizations.id, A.org.id) })))!;
    await q((tx) => tx.update(organizations).set({ settings: { ...org.settings, publicSiteEnabled: false } }).where(eq(organizations.id, A.org.id)));
    expect((await facts()).publicSite.enabled).toBe(false);
    expect((await items()).hosted_endpoints).toMatchObject({ status: "TODO", href: "/settings" });
    await q((tx) => tx.update(organizations).set({ settings: { ...org.settings, publicSiteEnabled: true } }).where(eq(organizations.id, A.org.id)));

    await q((tx) => tx.update(products).set({ status: "DEPRECATED" }).where(eq(products.id, productId)));
    expect((await facts()).publicSite.listed).toBe(false);
    await q((tx) => tx.update(products).set({ status: "LIVE", onboardingCompletedAt: null }).where(eq(products.id, productId)));
    expect((await facts()).publicSite.listed).toBe(false);
    await q((tx) => tx.update(products).set({ onboardingCompletedAt: new Date() }).where(eq(products.id, productId)));
    expect((await items()).hosted_endpoints.status).toBe("DONE");
  });

  it("reads the Bing and Stripe integration states (product-scoped or organisation-wide)", async () => {
    const [bing] = await q((tx) => tx.insert(integrations).values({ organizationId: A.org.id, productId, provider: "BING_WEBMASTER", status: "ERROR" }).returning());
    expect((await facts()).bing).toBe("FAILING");
    await q((tx) => tx.update(integrations).set({ status: "CONNECTED" }).where(eq(integrations.id, bing.id)));
    expect((await items()).bing.status).toBe("DONE");

    const [stripe] = await q((tx) => tx.insert(integrations).values({ organizationId: A.org.id, productId: null, provider: "STRIPE", status: "EXPIRED" }).returning());
    expect((await facts()).revenue).toEqual({ stripe: "FAILING", events: 0 });
    expect((await items()).revenue_source.status).toBe("TODO");
    await q((tx) => tx.update(integrations).set({ status: "DISABLED" }).where(eq(integrations.id, stripe.id)));
    expect((await facts()).revenue.stripe).toBe("NOT_CONNECTED");
  });

  it("counts revenue events and subscriptions of this product only", async () => {
    await q((tx) => tx.insert(revenueEvents).values({ organizationId: A.org.id, productId: otherProductId, type: "NEW", amountCents: 900, currency: "EUR", provider: "manual", externalId: `o-${uid()}`, occurredAt: new Date() }));
    expect((await facts()).revenue.events).toBe(0);
    await q((tx) => tx.insert(revenueEvents).values({ organizationId: A.org.id, productId, type: "NEW", amountCents: 2900, currency: "EUR", provider: "manual", externalId: `e-${uid()}`, occurredAt: new Date() }));
    await q((tx) => tx.insert(subscriptions).values({ organizationId: A.org.id, productId, provider: "manual", externalId: `s-${uid()}`, status: "ACTIVE", currency: "EUR", startedAt: new Date() }));
    expect((await facts()).revenue.events).toBe(2);
    expect((await items()).revenue_source).toMatchObject({ status: "DONE", evidence: { params: { n: 2 } } });
  });

  it("needs a sampled test for every active prompt of the product", async () => {
    const [p1, p2] = await q((tx) =>
      tx
        .insert(aiVisibilityPrompts)
        .values([
          { organizationId: A.org.id, productId, prompt: "best tiktok live moderation tool" },
          { organizationId: A.org.id, productId, prompt: "how to stop spam in tiktok live chat" },
          { organizationId: A.org.id, productId, prompt: "inactive prompt", active: false },
          { organizationId: A.org.id, productId: null, prompt: "organisation-wide prompt" },
          { organizationId: A.org.id, productId: otherProductId, prompt: "other product prompt" },
        ])
        .returning(),
    );
    expect((await facts()).aiVisibility).toMatchObject({ activePrompts: 2, testedPrompts: 0 });
    await q((tx) => tx.insert(aiVisibilityTests).values({ organizationId: A.org.id, promptId: p1.id, provider: "anthropic", model: "m", response: "answer" }));
    await q((tx) => tx.insert(aiVisibilityTests).values({ organizationId: A.org.id, promptId: p1.id, provider: "openai", model: "m", response: "answer" }));
    expect((await facts()).aiVisibility).toMatchObject({ activePrompts: 2, testedPrompts: 1 });
    expect((await items()).ai_visibility_baseline.status).not.toBe("DONE");
    await q((tx) => tx.insert(aiVisibilityTests).values({ organizationId: A.org.id, promptId: p2.id, provider: "anthropic", model: "m", response: "answer" }));
    expect((await items()).ai_visibility_baseline).toMatchObject({ status: "DONE", evidence: { params: { tested: 2, n: 2 } } });
  });

  it("counts active referral codes of this product only", async () => {
    await q((tx) =>
      tx.insert(referralCodes).values([
        { organizationId: A.org.id, productId, code: `off-${uid()}`, destinationUrl: "https://example.test/", active: false },
        { organizationId: A.org.id, productId: otherProductId, code: `oth-${uid()}`, destinationUrl: "https://example.test/" },
      ]),
    );
    expect((await facts()).referrals.activeCodes).toBe(0);
    await q((tx) => tx.insert(referralCodes).values({ organizationId: A.org.id, productId, code: `on-${uid()}`, destinationUrl: "https://example.test/" }));
    expect((await items()).referral_code).toMatchObject({ status: "DONE", evidence: { params: { n: 1 } } });
  });

  it("keeps the new items non-blocking (critical issues stay blocking)", async () => {
    const list = await q((tx) => productLaunchChecklist(tx, A.org.id, productId));
    const blocking = list.filter((i) => i.blocking).map((i) => i.key);
    expect(blocking).toEqual(["knowledge", "site", "critical_issues", "core_pages", "conversion_tracking"]);
  });
});

describe("editing an approved, unpublished asset", () => {
  it("drops the approval of the old text, keeps the approved version on record and needs a new approval", async () => {
    const B = await newOrg("w3b-content");
    const run = <T>(fn: (tx: Tx) => Promise<T>) => withOrg(B.org.id, fn);
    const { product } = await seedCompleteProduct(B.org.id, { name: "Beacon Live" });
    const a = await run((tx) => createAsset(tx, B.actor, { productId: product.id, type: "LANDING_PAGE", title: "Approved landing" }));
    expect((await run((tx) => generateVersion(tx, B.actor, a.id, "Novarys"))).status).toBe("HUMAN_APPROVAL");
    await run((tx) => approveAsset(tx, B.actor, a.id, { acknowledge: true }));
    const approved = await run((tx) => getAsset(tx, B.org.id, a.id));
    const v1 = (await run((tx) => latestVersion(tx, a.id)))!;
    expect(approved).toMatchObject({ status: "APPROVED", approvedVersionId: v1.id });

    // Saving the approved text unchanged is refused: the approval stands.
    await expect(run((tx) => saveEditedVersion(tx, B.actor, a.id, { body: v1.body, metaTitle: v1.metaTitle, metaDescription: v1.metaDescription }))).rejects.toThrow(/No changes: this text is already approved/);
    expect((await run((tx) => getAsset(tx, B.org.id, a.id))).status).toBe("APPROVED");

    // A real edit: new version, fresh checks, the old approval no longer applies.
    const r = await run((tx) => saveEditedVersion(tx, B.actor, a.id, { body: `${v1.body}\n` }));
    expect(r.version.version).toBe(2);
    expect(["GENERATED", "FACT_CHECK", "SEO_CHECK", "HUMAN_APPROVAL"]).toContain(r.status);
    const edited = await run((tx) => getAsset(tx, B.org.id, a.id));
    expect(edited.status).toBe(r.status);
    // The previously approved version is not lost.
    expect(edited.approvedVersionId).toBe(v1.id);
    expect(edited.approvedBy).toBe(B.user.id);
    expect(edited.publishedVersionId).toBeNull();
    // Nothing can use the old approval meanwhile.
    await expect(run((tx) => publishAsset(tx, B.actor, a.id))).rejects.toThrow(/Invalid content transition/);
    await expect(run((tx) => exportApprovedAsset(tx, B.actor, a.id, "md"))).rejects.toThrow(/approved or published/);
    const log = await run((tx) => tx.query.auditLogs.findFirst({ where: and(eq(auditLogs.entityId, a.id), eq(auditLogs.action, "content.edit")) }));
    expect(log!.metadata).toMatchObject({ version: 2, branchedFrom: "APPROVED", approvedVersionId: v1.id, approvalSuperseded: true });

    // A new approval moves the record to the new version.
    expect(r.status).toBe("HUMAN_APPROVAL");
    await run((tx) => approveAsset(tx, B.actor, a.id, { acknowledge: true }));
    const reapproved = await run((tx) => getAsset(tx, B.org.id, a.id));
    expect(reapproved).toMatchObject({ status: "APPROVED", approvedVersionId: r.version.id });
  });
});
