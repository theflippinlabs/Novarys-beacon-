import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { asSystem, closeDb, withOrg } from "@/db";
import {
  affiliates,
  aiVisibilityPrompts,
  auditLogs,
  campaigns,
  contentAssets,
  crossSellRules,
  experiments,
  memberships,
  organizations,
  productChangelog,
  productFaqs,
  productProofs,
  queries,
  referralCodes,
  users,
} from "@/db/schema";
import { can, PERMISSIONS, ROLES, type Permission, type Role } from "@/lib/auth/rbac";
import { createSession } from "@/lib/auth/service";
import { hashPassword } from "@/lib/security/crypto";
import { newOrg, seedCompleteProduct, uid } from "./helpers";

/**
 * Server actions run through `act()` exactly as in production; only the
 * Next.js request APIs are replaced: the session cookie comes from `session`,
 * and `redirect()` throws a Redirect carrying its target (flash message).
 */
let session: string | null = null;
class Redirect extends Error {
  constructor(public url: string) {
    super(`redirect ${url}`);
  }
}
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session ? { value: session } : undefined), set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers({ "x-forwarded-for": "10.9.8.7" }),
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

const { addProofAction, addChangelogAction, addFaqAction } = await import("@/app/actions/products");
const { addPromptAction, addCampaignAction, addExperimentAction, addCrossSellRuleAction, createReferralCodeAction } = await import("@/app/actions/growth");
const { setPublicSiteAction, updateOrgSettingsAction } = await import("@/app/actions/settings");
const { createContentAction } = await import("@/app/actions/content");

/** Run an action; return the flash outcome parsed from the redirect target. */
async function run(action: (fd: FormData) => Promise<unknown>, fields: Record<string, string>) {
  const fd = new FormData();
  fd.set("_back", "/t");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  try {
    await action(fd);
  } catch (e) {
    if (!(e instanceof Redirect)) throw e;
    const u = new URL(e.url, "http://x");
    return { path: u.pathname, ok: u.searchParams.get("ok"), error: u.searchParams.get("error") };
  }
  throw new Error("action did not redirect");
}

type Ctx = Awaited<ReturnType<typeof newOrg>>;
let A: Ctx;
let B: Ctx;
let productA: string;
let productA2: string;
let sourceA: string;
let productB: string;
let sourceB: string;
let affiliateB: string;
let campaignB: string;
let queryB: string;
const tokens = {} as Record<Role, string>;

async function memberToken(orgId: string, role: Role) {
  const [u] = await asSystem(async (tx) => tx.insert(users).values({ email: `${role.toLowerCase()}-${uid()}@example.test`, name: role, passwordHash: await hashPassword("correct horse battery 42") }).returning());
  await asSystem((tx) => tx.insert(memberships).values({ organizationId: orgId, userId: u.id, role }));
  return (await createSession(u.id)).token;
}

beforeAll(async () => {
  A = await newOrg("authz-a");
  B = await newOrg("authz-b");
  const a = await seedCompleteProduct(A.org.id, { name: `Authz A ${uid()}`, domain: "a-product.example" });
  const a2 = await seedCompleteProduct(A.org.id, { name: `Authz A2 ${uid()}`, domain: "a2-product.example" });
  const b = await seedCompleteProduct(B.org.id, { name: `Authz B ${uid()}` });
  productA = a.product.id;
  productA2 = a2.product.id;
  sourceA = a.sources.site.id;
  productB = b.product.id;
  sourceB = b.sources.site.id;
  await withOrg(B.org.id, async (tx) => {
    affiliateB = (await tx.insert(affiliates).values({ organizationId: B.org.id, name: "B affiliate", commissionBps: 1000, commissionMonths: 12, holdDays: 30, status: "ACTIVE" }).returning())[0].id;
    queryB = (await tx.insert(queries).values({ organizationId: B.org.id, productId: productB, query: "b private query", normalized: "b private query", intent: "INFORMATIONAL", funnelStage: "AWARENESS" }).returning())[0].id;
    campaignB = (await tx.insert(campaigns).values({ organizationId: B.org.id, name: "B campaign", channel: "EMAIL", utmSource: "b", utmMedium: "email", utmCampaign: "b" }).returning())[0].id;
  });
  for (const role of ROLES) tokens[role] = await memberToken(A.org.id, role);
}, 120_000);
afterAll(closeDb);

describe("RBAC matrix", () => {
  const EDITOR: Permission[] = ["read", "query:write", "job:run", "audit:read", "product:write", "content:write", "distribution:write", "growth:write"];
  const ADMIN: Permission[] = [...EDITOR, "product:delete", "content:approve", "fact:verify", "distribution:approve", "recommendation:decide", "revenue:write", "integration:manage", "apikey:manage", "member:manage", "settings:manage"];
  const EXPECTED: Record<Role, Permission[]> = {
    VIEWER: ["read"],
    ANALYST: ["read", "query:write", "job:run", "audit:read"],
    EDITOR,
    ADMIN,
    OWNER: [...PERMISSIONS],
  };
  it("matches the documented role matrix for every permission", () => {
    const known = new Set<Permission>([...ADMIN]);
    for (const role of ROLES) {
      const granted = PERMISSIONS.filter((p) => can(role, p) && (role === "OWNER" || known.has(p)));
      expect(granted.sort()).toEqual([...EXPECTED[role]].sort());
    }
    // Verification is a dedicated permission, above editing.
    expect(can("EDITOR", "fact:verify")).toBe(false);
    expect(can("ADMIN", "fact:verify")).toBe(true);
  });

  const cases: { name: string; permission: Permission; action: (fd: FormData) => Promise<unknown>; fields: () => Record<string, string> }[] = [
    { name: "addPromptAction", permission: "query:write", action: addPromptAction, fields: () => ({ prompt: `best moderation tool ${uid()}`, productId: productA }) },
    { name: "addProofAction", permission: "product:write", action: addProofAction, fields: () => ({ productId: productA, kind: "TESTIMONIAL", title: "Quote", content: "It works well for us.", sourceId: sourceA }) },
    { name: "addExperimentAction", permission: "growth:write", action: addExperimentAction, fields: () => ({ name: `Exp ${uid()}`, hypothesis: "A clearer CTA increases signups.", primaryMetric: "signups", productId: productA }) },
    { name: "setPublicSiteAction", permission: "settings:manage", action: setPublicSiteAction, fields: () => ({ enabled: "true" }) },
    { name: "updateOrgSettingsAction", permission: "settings:manage", action: updateOrgSettingsAction, fields: () => ({ model: "LAST_TOUCH", lookbackDays: "30", crossSellDailyCap: "1" }) },
  ];
  for (const c of cases)
    it.each([...ROLES])(`${c.name} (${c.permission}) as %s`, async (role) => {
      session = tokens[role];
      const r = await run(c.action, c.fields());
      if (can(role, c.permission)) {
        expect(r.error).toBeNull();
        expect(r.ok).toBeTruthy();
      } else expect(r.error).toBe("You do not have permission to do that.");
    });

  it("an anonymous caller is sent to /login and nothing is written", async () => {
    session = null;
    const prompt = `anon ${uid()}`;
    expect((await run(addPromptAction, { prompt })).path).toBe("/login");
    expect(await withOrg(A.org.id, (tx) => tx.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.prompt, prompt)))).toHaveLength(0);
  });

  it("setPublicSiteAction is audited and flips the setting", async () => {
    session = tokens.OWNER;
    expect((await run(setPublicSiteAction, { enabled: "false" })).ok).toMatch(/turned off/);
    const org = await asSystem((tx) => tx.query.organizations.findFirst({ where: eq(organizations.id, A.org.id) }));
    expect(org!.settings.publicSiteEnabled).toBe(false);
    const logs = await withOrg(A.org.id, (tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.organizationId, A.org.id), eq(auditLogs.action, "org.public_site_disabled"))));
    expect(logs).toHaveLength(1);
    await run(setPublicSiteAction, { enabled: "true" });
  });
});

describe("cross-organisation ids from forms are rejected (assertOwned)", () => {
  const rejects = async (action: (fd: FormData) => Promise<unknown>, fields: Record<string, string>, message: string) => {
    session = tokens.OWNER;
    const r = await run(action, fields);
    expect(r.error).toBe(message);
  };

  it("addProofAction: foreign product or source", async () => {
    await rejects(addProofAction, { productId: productB, kind: "TESTIMONIAL", title: "X proof", content: "Foreign product." }, "Product not found");
    await rejects(addProofAction, { productId: productA, kind: "TESTIMONIAL", title: "Y proof", content: "Foreign source.", sourceId: sourceB }, "Source not found");
    expect(await withOrg(A.org.id, (tx) => tx.select().from(productProofs).where(eq(productProofs.title, "Y proof")))).toHaveLength(0);
  });

  it("addChangelogAction: foreign product or source", async () => {
    await rejects(addChangelogAction, { productId: productB, releasedOn: "2026-01-01", title: "Foreign" }, "Product not found");
    await rejects(addChangelogAction, { productId: productA, releasedOn: "2026-01-01", title: "Foreign source", sourceId: sourceB }, "Source not found");
    expect(await withOrg(A.org.id, (tx) => tx.select().from(productChangelog).where(eq(productChangelog.title, "Foreign source")))).toHaveLength(0);
  });

  it("addFaqAction: foreign source", async () => {
    await rejects(addFaqAction, { productId: productA, question: "Is it foreign?", answer: "This answer cites a foreign source.", sourceId: sourceB }, "Source not found");
    expect(await withOrg(A.org.id, (tx) => tx.select().from(productFaqs).where(eq(productFaqs.question, "Is it foreign?")))).toHaveLength(0);
  });

  it("addPromptAction, addCampaignAction, addExperimentAction: foreign product", async () => {
    await rejects(addPromptAction, { prompt: "foreign product prompt", productId: productB }, "Product not found");
    await rejects(addCampaignAction, { name: "Foreign", channel: "EMAIL", utmSource: "x", utmMedium: "y", utmCampaign: "z", productId: productB }, "Product not found");
    await rejects(addExperimentAction, { name: "Foreign exp", hypothesis: "Foreign product experiment.", primaryMetric: "signups", productId: productB }, "Product not found");
    const [p, c, e] = await withOrg(A.org.id, async (tx) => [
      await tx.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.prompt, "foreign product prompt")),
      await tx.select().from(campaigns).where(eq(campaigns.name, "Foreign")),
      await tx.select().from(experiments).where(eq(experiments.name, "Foreign exp")),
    ]);
    expect([p.length, c.length, e.length]).toEqual([0, 0, 0]);
  });

  it("addCrossSellRuleAction: foreign source product", async () => {
    const base = { name: "Foreign rule", message: "Try our other product today.", ctaLabel: "Try it", ctaUrl: "https://a2-product.example/start" };
    await rejects(addCrossSellRuleAction, { ...base, sourceProductId: productB, destinationProductId: productA2 }, "Product not found");
    expect(await withOrg(A.org.id, (tx) => tx.select().from(crossSellRules).where(eq(crossSellRules.name, "Foreign rule")))).toHaveLength(0);
  });

  it("createReferralCodeAction: foreign affiliate or campaign", async () => {
    const base = { productId: productA, destinationUrl: "https://a-product.example/signup" };
    await rejects(createReferralCodeAction, { ...base, code: `FA${uid()}`.toUpperCase(), affiliateId: affiliateB }, "Affiliate not found");
    await rejects(createReferralCodeAction, { ...base, code: `FC${uid()}`.toUpperCase(), campaignId: campaignB }, "Campaign not found");
    const rows = await withOrg(A.org.id, (tx) => tx.select().from(referralCodes).where(eq(referralCodes.organizationId, A.org.id)));
    expect(rows).toHaveLength(0);
  });

  it("createContentAction: foreign product or target query", async () => {
    await rejects(createContentAction, { productId: productB, type: "LANDING_PAGE", title: "Foreign product page" }, "Product not found");
    await rejects(createContentAction, { productId: productA, type: "LANDING_PAGE", title: "Foreign query page", targetQueryId: queryB }, "Target query not found");
    const rows = await withOrg(A.org.id, (tx) => tx.select().from(contentAssets).where(eq(contentAssets.organizationId, A.org.id)));
    expect(rows.filter((r) => r.title === "Foreign product page" || r.title === "Foreign query page")).toHaveLength(0);
  });

  it("the same actions accept the organisation's own ids", async () => {
    session = tokens.OWNER;
    expect((await run(addProofAction, { productId: productA, kind: "TESTIMONIAL", title: "Own proof", content: "Own product and source.", sourceId: sourceA })).error).toBeNull();
    expect((await run(createReferralCodeAction, { productId: productA, destinationUrl: "https://a-product.example/signup" })).error).toBeNull();
  });
});
