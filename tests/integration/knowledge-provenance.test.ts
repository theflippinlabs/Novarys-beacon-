import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { asSystem, closeDb, withOrg } from "@/db";
import { aiVisibilityPrompts, memberships, organizations, productChangelog, productClaims, productFacets, productFaqs, productPricing, productProofs, products, productSources, queries, users } from "@/db/schema";
import { loadProductGraph } from "@/core/knowledge/load";
import { verifiedOnly } from "@/core/knowledge/types";
import { buildAnswerBlocks, buildEntityProfile } from "@/core/geo/entity";
import { createSession } from "@/lib/auth/service";
import { hashPassword } from "@/lib/security/crypto";
import type { Role } from "@/lib/auth/rbac";
import { createProduct, replacePricing, syncFacets, syncSources, updateProduct } from "@/services/products";
import { addPricingPlan, addSource, suggestFaqs } from "@/services/knowledge";
import { checkOrganizationSources, editFact, refreshProvenance, setFactSource, setFactVerification, verifyProductClaims, type SourceFetcher } from "@/services/provenance";
import { AGENT_TOOLS } from "@/agent/tools";
import type { AgentToolContext } from "@/agent/types";
import { makeT } from "@/i18n/core";
import { newOrg, uid } from "./helpers";

/** Server actions run through act() as in production; only the Next.js request APIs are replaced. */
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
/** The liveness job's network calls go through safeFetch: answered from this table instead of the network. */
const http = new Map<string, number | "down">();
vi.mock("@/lib/security/ssrf", async (orig) => ({
  ...(await orig<typeof import("@/lib/security/ssrf")>()),
  safeFetch: async (url: string) => {
    const s = http.get(url);
    if (s === undefined || s === "down") throw new Error("connect ECONNREFUSED");
    return { url, status: s, headers: {}, body: "", bytes: 0, elapsedMs: 1, redirects: [], truncated: false };
  },
}));

const { saveOnboardingStepAction, setVerificationAction, markProductVerifiedAction } = await import("@/app/actions/products");
const { HANDLERS } = await import("@/jobs/handlers");

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
let ownerToken: string;
let editorToken: string;
let productId: string;
let docsId: string;
let siteId: string;

async function memberToken(orgId: string, role: Role) {
  const [u] = await asSystem(async (tx) => tx.insert(users).values({ email: `${role.toLowerCase()}-${uid()}@example.test`, name: role, passwordHash: await hashPassword("correct horse battery 42") }).returning());
  await asSystem((tx) => tx.insert(memberships).values({ organizationId: orgId, userId: u.id, role }));
  return { token: (await createSession(u.id)).token, userId: u.id };
}

const q = <T>(fn: Parameters<typeof withOrg<T>>[1]) => withOrg(A.org.id, fn);
const claimOf = async (field: string) => (await q((tx) => tx.select().from(productClaims).where(and(eq(productClaims.productId, productId), eq(productClaims.field, field)))))[0];
const step = (n: number, fields: Record<string, string>) => run(saveOnboardingStepAction, { productId, step: String(n), intent: "save", ...fields });

beforeAll(async () => {
  A = await newOrg("prov-a");
  B = await newOrg("prov-b");
  ownerToken = (await createSession(A.user.id)).token;
  editorToken = (await memberToken(A.org.id, "EDITOR")).token;
  const p = await withOrg(A.org.id, (tx) => createProduct(tx, A.actor, { name: `Prov ${uid()}` }));
  productId = p.id;
  await withOrg(A.org.id, async (tx) => {
    docsId = (await addSource(tx, A.actor, productId, { title: "Docs", url: "https://prov.example/docs", kind: "DOCUMENTATION" })).id;
    siteId = (await addSource(tx, A.actor, productId, { title: "Site", url: "https://prov.example/", kind: "WEBSITE" })).id;
  });
});
afterAll(closeDb);

describe("re-verification on every edit path", () => {
  it("wizard steps 1 to 4 create claims and send a changed VERIFIED claim back to review", async () => {
    session = ownerToken;
    expect((await step(1, { name: "Prov Product", status: "LIVE", releaseDate: "2026-01-02" })).ok).toBe("Saved.");
    expect((await step(2, { domain: "prov.example", languages: "en, fr", documentationUrl: "https://prov.example/docs" })).ok).toBe("Saved.");
    expect((await step(3, { category: "Moderation", apiAvailable: "false" })).ok).toBe("Saved.");
    expect((await step(4, { shortDescription: "Live moderation for streams.", fullDescription: "A long description.", howItWorks: "It filters." })).ok).toBe("Saved.");
    const claims = await q((tx) => tx.select().from(productClaims).where(eq(productClaims.productId, productId)));
    expect(claims.map((c) => c.field).sort()).toEqual(["api_available", "category", "documentation_url", "domain", "full_description", "how_it_works", "languages", "release_date", "short_description", "status"]);
    expect(claims.every((c) => c.verification === "UNVERIFIED" && c.confidence !== null)).toBe(true);

    // A human verifies every claim against the docs source.
    expect((await run(markProductVerifiedAction, { productId, sourceId: docsId })).ok).toBe("Core product description marked as human-verified.");
    const v = await claimOf("short_description");
    expect(v).toMatchObject({ verification: "VERIFIED", sourceId: docsId, verifiedBy: A.user.id });
    expect(v.verifiedAt).toBeInstanceOf(Date);
    expect(v.confidence).toBe(1);

    for (const [n, fields, field] of [
      [1, { name: "Prov Product", status: "BETA", releaseDate: "2026-01-02" }, "status"],
      [2, { domain: "prov2.example", languages: "en, fr", documentationUrl: "https://prov.example/docs" }, "domain"],
      [3, { category: "Moderation", apiAvailable: "true" }, "api_available"],
      [4, { shortDescription: "Live moderation for TikTok streams.", fullDescription: "A long description.", howItWorks: "It filters." }, "short_description"],
    ] as const) {
      await step(n, fields);
      const c = await claimOf(field);
      expect(c, field).toMatchObject({ verification: "NEEDS_REVIEW", verifiedAt: null, verifiedBy: null });
    }
    // Unchanged values keep their verification.
    expect((await claimOf("category")).verification).toBe("VERIFIED");
    expect((await claimOf("full_description")).verification).toBe("VERIFIED");
    // The public graph only exposes verified claims.
    const pub = verifiedOnly((await q((tx) => loadProductGraph(tx, A.org.id, productId)))!).product;
    expect(pub.shortDescription).toBeNull();
    expect(pub.domain).toBeNull();
    expect(pub.status).toBe("UNKNOWN");
    expect(pub.category).toBe("Moderation");
    expect(pub.fullDescription).toBe("A long description.");
    // Clearing a field drops its claim.
    await step(4, { shortDescription: "", fullDescription: "A long description.", howItWorks: "It filters." });
    expect(await claimOf("short_description")).toBeUndefined();
  });

  it("the agent's update_product sends a verified claim back to review", async () => {
    const tool = AGENT_TOOLS.find((t) => t.name === "update_product")!;
    const org = (await asSystem((tx) => tx.query.organizations.findFirst({ where: eq(organizations.id, A.org.id) })))!;
    const slug = (await q((tx) => tx.query.products.findFirst({ where: eq(products.id, productId) })))!.slug;
    const out = (await q((tx) => {
      const c: AgentToolContext = { tx, ctx: { user: { id: A.user.id, email: A.email, name: "Owner" }, org: { id: org.id, slug: org.slug, name: org.name, settings: org.settings, branding: org.branding }, role: "OWNER", sessionTokenHash: "t" }, actor: { ...A.actor, via: "agent" }, locale: "en", t: makeT(null), signal: new AbortController().signal };
      return tool.run(c, tool.input.parse({ product: slug, category: "Live moderation" }));
    })) as { needsReverification: boolean; fieldsToReverify: string[] };
    expect(out).toMatchObject({ needsReverification: true, fieldsToReverify: ["category"] });
    expect((await claimOf("category")).verification).toBe("NEEDS_REVIEW");
  });

  it("facets (wizard and edit), pricing, FAQ, proof and changelog edits reset verification", async () => {
    await q((tx) => syncFacets(tx, A.actor, productId, "FEATURE", [{ name: "Filters", slug: "filters", description: "Keyword filters." }]));
    const [facet] = await q((tx) => tx.select().from(productFacets).where(eq(productFacets.productId, productId)));
    await q((tx) => setFactVerification(tx, A.actor, { kind: "facet", id: facet.id, verification: "VERIFIED", sourceId: docsId }));
    await q((tx) => syncFacets(tx, A.actor, productId, "FEATURE", [{ name: "Filters", slug: "filters", description: "Keyword and emoji filters." }]));
    expect((await q((tx) => tx.select().from(productFacets).where(eq(productFacets.id, facet.id))))[0]).toMatchObject({ verification: "NEEDS_REVIEW", verifiedAt: null, verifiedBy: null });
    await q((tx) => setFactVerification(tx, A.actor, { kind: "facet", id: facet.id, verification: "VERIFIED" }));
    expect((await q((tx) => editFact(tx, A.actor, "facet", facet.id, { description: "Keyword and emoji filters." }))).changed).toBe(false);
    expect((await q((tx) => editFact(tx, A.actor, "facet", facet.id, { description: "Edited." }))).verification).toBe("NEEDS_REVIEW");

    await q((tx) => replacePricing(tx, A.actor, productId, [{ planName: "Pro", priceCents: 2900, currency: "EUR", interval: "MONTH" }]));
    const [plan] = await q((tx) => tx.select().from(productPricing).where(eq(productPricing.productId, productId)));
    await q((tx) => setFactVerification(tx, A.actor, { kind: "pricing", id: plan.id, verification: "VERIFIED", sourceId: docsId }));
    await q((tx) => replacePricing(tx, A.actor, productId, [{ planName: "Pro", priceCents: 2900, currency: "EUR", interval: "YEAR" }]));
    expect((await q((tx) => tx.select().from(productPricing).where(eq(productPricing.id, plan.id))))[0]).toMatchObject({ verification: "NEEDS_REVIEW", verifiedAt: null });

    const [faq] = await q((tx) => tx.insert(productFaqs).values({ organizationId: A.org.id, productId, question: "Is it free?", answer: "There is a free plan.", sourceId: docsId }).returning());
    const [proof] = await q((tx) => tx.insert(productProofs).values({ organizationId: A.org.id, productId, kind: "METRIC", title: "Speed", content: "Hides spam in 1 second.", sourceId: docsId }).returning());
    const [release] = await q((tx) => tx.insert(productChangelog).values({ organizationId: A.org.id, productId, releasedOn: "2026-02-01", title: "v2", sourceId: docsId }).returning());
    expect(release.verification).toBe("UNVERIFIED");
    for (const [kind, id, patch] of [
      ["faq", faq.id, { answer: "There is a free plan for one creator." }],
      ["proof", proof.id, { content: "Hides spam in 2 seconds." }],
      ["changelog", release.id, { title: "v2.0" }],
    ] as const) {
      await q((tx) => setFactVerification(tx, A.actor, { kind, id, verification: "VERIFIED" }));
      expect((await q((tx) => editFact(tx, A.actor, kind, id, patch))).verification, kind).toBe("NEEDS_REVIEW");
    }
  });

  it("changing a verified fact's source, or removing its source, sends it back to review", async () => {
    const [facet] = await q((tx) => tx.select().from(productFacets).where(eq(productFacets.productId, productId)));
    await q((tx) => setFactVerification(tx, A.actor, { kind: "facet", id: facet.id, verification: "VERIFIED", sourceId: docsId }));
    expect((await q((tx) => setFactSource(tx, A.actor, { kind: "facet", id: facet.id, sourceId: siteId }))).verification).toBe("NEEDS_REVIEW");
    await q((tx) => setFactVerification(tx, A.actor, { kind: "facet", id: facet.id, verification: "VERIFIED" }));
    // The wizard removes the site source: the facet loses its source and its verification.
    await q((tx) => syncSources(tx, A.actor, productId, [{ title: "Docs", url: "https://prov.example/docs", kind: "DOCUMENTATION" }]));
    expect((await q((tx) => tx.select().from(productFacets).where(eq(productFacets.id, facet.id))))[0]).toMatchObject({ sourceId: null, verification: "NEEDS_REVIEW" });
    siteId = (await q((tx) => addSource(tx, A.actor, productId, { title: "Site", url: "https://prov.example/", kind: "WEBSITE" }))).id;
  });
});

describe("verification rules", () => {
  it("requires fact:verify (editors and the agent cannot verify)", async () => {
    const [facet] = await q((tx) => tx.select().from(productFacets).where(eq(productFacets.productId, productId)));
    session = editorToken;
    expect((await run(setVerificationAction, { kind: "facet", id: facet.id, verification: "VERIFIED", sourceId: docsId })).error).toBe("You do not have permission to do that.");
    expect((await run(markProductVerifiedAction, { productId, sourceId: docsId })).error).toBe("You do not have permission to do that.");
    await expect(q((tx) => setFactVerification(tx, { ...A.actor, via: "agent" }, { kind: "facet", id: facet.id, verification: "VERIFIED", sourceId: docsId }))).rejects.toThrow(/fact:verify/);
    session = ownerToken;
    expect((await run(setVerificationAction, { kind: "facet", id: facet.id, verification: "VERIFIED", sourceId: docsId })).ok).toBe("Marked verified.");
  });

  it("VERIFIED requires a source and stamps verified_at / verified_by; other statuses clear the stamp", async () => {
    const [unsourced] = await q((tx) => tx.insert(productFacets).values({ organizationId: A.org.id, productId, kind: "AUDIENCE", slug: `aud-${uid()}`, name: "Agencies" }).returning());
    session = ownerToken;
    expect((await run(setVerificationAction, { kind: "facet", id: unsourced.id, verification: "VERIFIED" })).error).toMatch(/Link a source before verifying/);
    expect((await q((tx) => tx.select().from(productFacets).where(eq(productFacets.id, unsourced.id))))[0].verification).toBe("UNVERIFIED");
    await run(setVerificationAction, { kind: "facet", id: unsourced.id, verification: "VERIFIED", sourceId: siteId });
    const row = (await q((tx) => tx.select().from(productFacets).where(eq(productFacets.id, unsourced.id))))[0];
    expect(row).toMatchObject({ verification: "VERIFIED", sourceId: siteId, verifiedBy: A.user.id, confidence: 0.9 });
    await run(setVerificationAction, { kind: "facet", id: unsourced.id, verification: "REJECTED" });
    expect((await q((tx) => tx.select().from(productFacets).where(eq(productFacets.id, unsourced.id))))[0]).toMatchObject({ verification: "REJECTED", verifiedAt: null, verifiedBy: null, confidence: 0 });
    // A suggested FAQ without an answer cannot be verified.
    const [draft] = await q((tx) => tx.insert(productFaqs).values({ organizationId: A.org.id, productId, question: "Draft?", answer: "", sourceId: docsId, suggestedFrom: "query:x" }).returning());
    await expect(q((tx) => setFactVerification(tx, A.actor, { kind: "faq", id: draft.id, verification: "VERIFIED" }))).rejects.toThrow(/Write the answer/);
  });

  it("markProductVerified verifies only claims with a source", async () => {
    const p = await q((tx) => createProduct(tx, A.actor, { name: `NoSrc ${uid()}` }));
    await q((tx) => updateProduct(tx, A.actor, p.id, { category: "Video", shortDescription: "Clips." }));
    expect(await q((tx) => verifyProductClaims(tx, A.actor, p.id, null))).toEqual({ verified: 0, skipped: 2 });
    session = ownerToken;
    expect((await run(markProductVerifiedAction, { productId: p.id })).error).toMatch(/Choose the source/);
  });
});

describe("sources.check and OUTDATED / CONFLICTING", () => {
  it("marks claims sourced by a source failing twice as OUTDATED (mocked fetch), and stale verifications", async () => {
    const org = await newOrg("prov-src");
    const actor = org.actor;
    const p = await withOrg(org.org.id, (tx) => createProduct(tx, actor, { name: "Src" }));
    const good = await withOrg(org.org.id, (tx) => addSource(tx, actor, p.id, { title: "Good", url: "https://good.example/", kind: "WEBSITE" }));
    const bad = await withOrg(org.org.id, (tx) => addSource(tx, actor, p.id, { title: "Bad", url: "https://bad.example/", kind: "DOCUMENTATION" }));
    const gone = await withOrg(org.org.id, (tx) => addSource(tx, actor, p.id, { title: "Gone", url: "https://gone.example/", kind: "PRICING" }));
    http.set("https://good.example/", 200).set("https://bad.example/", 404).set("https://gone.example/", "down");
    const [onBad, onGood, onGone, stale] = await withOrg(org.org.id, (tx) =>
      tx
        .insert(productFacets)
        .values([
          { organizationId: org.org.id, productId: p.id, kind: "FEATURE", slug: "a", name: "A", sourceId: bad.id, verification: "VERIFIED", verifiedAt: new Date() },
          { organizationId: org.org.id, productId: p.id, kind: "FEATURE", slug: "b", name: "B", sourceId: good.id, verification: "VERIFIED", verifiedAt: new Date() },
          { organizationId: org.org.id, productId: p.id, kind: "FEATURE", slug: "c", name: "C", sourceId: gone.id, verification: "UNVERIFIED" },
          { organizationId: org.org.id, productId: p.id, kind: "FEATURE", slug: "d", name: "D", sourceId: good.id, verification: "VERIFIED", verifiedAt: new Date(Date.now() - 200 * 86_400_000) },
        ])
        .returning(),
    );
    const status = async (id: string) => (await withOrg(org.org.id, (tx) => tx.select().from(productFacets).where(eq(productFacets.id, id))))[0].verification;

    // First run (through the job handler): one failure is not enough, but the stale verification is outdated.
    const first = (await HANDLERS["sources.check"]({ id: "j1", organizationId: org.org.id, type: "sources.check", payload: {} } as never, { heartbeat: async () => undefined })) as { checked: number; failing: number };
    expect(first).toMatchObject({ checked: 3, failing: 2 });
    const srcRows = await withOrg(org.org.id, (tx) => tx.select().from(productSources).where(eq(productSources.productId, p.id)));
    expect(Object.fromEntries(srcRows.map((s) => [s.title, [s.httpStatus, s.consecutiveFailures, Boolean(s.lastCheckedAt)]]))).toEqual({ Good: [200, 0, true], Bad: [404, 1, true], Gone: [null, 1, true] });
    expect(await status(onBad.id)).toBe("VERIFIED");
    expect(await status(stale.id)).toBe("OUTDATED");

    // Second failure in a row: claims sourced by failing sources become OUTDATED.
    const fetcher: SourceFetcher = async (url) => {
      const s = http.get(url);
      if (s === undefined || s === "down") throw new Error("down");
      return { status: s };
    };
    await checkOrganizationSources((fn) => withOrg(org.org.id, fn), org.org.id, fetcher);
    expect(await status(onBad.id)).toBe("OUTDATED");
    expect(await status(onGone.id)).toBe("OUTDATED");
    expect(await status(onGood.id)).toBe("VERIFIED");
    const conf = (await withOrg(org.org.id, (tx) => tx.select().from(productFacets).where(eq(productFacets.id, onGood.id))))[0].confidence;
    expect(conf).toBe(0.9);

    // The organisation can lengthen the freshness window.
    await asSystem((tx) => tx.update(organizations).set({ settings: { knowledge: { staleAfterDays: 365 } } }).where(eq(organizations.id, org.org.id)));
    await withOrg(org.org.id, (tx) => setFactVerification(tx, actor, { kind: "facet", id: stale.id, verification: "VERIFIED" }));
    await withOrg(org.org.id, (tx) => tx.update(productFacets).set({ verifiedAt: new Date(Date.now() - 200 * 86_400_000) }).where(eq(productFacets.id, stale.id)));
    await withOrg(org.org.id, (tx) => refreshProvenance(tx, org.org.id, p.id));
    expect(await status(stale.id)).toBe("VERIFIED");
  });

  it("detects CONFLICTING pricing and scalar claims from different sources, and clears it once resolved", async () => {
    const p = await q((tx) => createProduct(tx, A.actor, { name: `Conf ${uid()}` }));
    const s1 = await q((tx) => addSource(tx, A.actor, p.id, { title: "Pricing", url: `https://conf-${uid()}.example/pricing`, kind: "PRICING" }));
    const s2 = await q((tx) => addSource(tx, A.actor, p.id, { title: "Press", url: `https://press-${uid()}.example/`, kind: "PRESS" }));
    const a = await q((tx) => addPricingPlan(tx, A.actor, p.id, { planName: "Pro", priceCents: 2900, currency: "EUR", interval: "MONTH", sourceId: s1.id }));
    // The same plan again needs a different source.
    await expect(q((tx) => addPricingPlan(tx, A.actor, p.id, { planName: "Pro", priceCents: 3900, currency: "EUR", interval: "MONTH", sourceId: s1.id }))).rejects.toThrow(/already exists/);
    const b = await q((tx) => addPricingPlan(tx, A.actor, p.id, { planName: "pro", priceCents: 3900, currency: "EUR", interval: "MONTH", sourceId: s2.id }));
    await q((tx) => updateProduct(tx, A.actor, p.id, { category: "Video editing" }));
    await q((tx) => tx.update(productClaims).set({ sourceId: s1.id }).where(eq(productClaims.productId, p.id)));
    await q((tx) => tx.insert(productClaims).values({ organizationId: A.org.id, productId: p.id, field: "category", value: "Photo editing", sourceId: s2.id }));

    const r = await q((tx) => refreshProvenance(tx, A.org.id, p.id));
    expect(r.conflicting).toBe(4);
    const plans = await q((tx) => tx.select().from(productPricing).where(eq(productPricing.productId, p.id)));
    expect(plans.map((x) => x.verification)).toEqual(["CONFLICTING", "CONFLICTING"]);
    const claims = await q((tx) => tx.select().from(productClaims).where(eq(productClaims.productId, p.id)));
    expect(claims.every((c) => c.verification === "CONFLICTING")).toBe(true);

    // A human rejects the wrong plan: the other one goes back to review.
    await q((tx) => setFactVerification(tx, A.actor, { kind: "pricing", id: b.id, verification: "REJECTED" }));
    await q((tx) => refreshProvenance(tx, A.org.id, p.id));
    expect((await q((tx) => tx.select().from(productPricing).where(eq(productPricing.id, a.id))))[0].verification).toBe("NEEDS_REVIEW");
  });
});

describe("FAQ suggestions and GEO provenance", () => {
  it("drafts FAQ questions from high-importance queries and active prompts; drafts never reach answers", async () => {
    await q((tx) =>
      tx.insert(queries).values([
        { organizationId: A.org.id, productId, query: "how to stop spam in live chat", normalized: `how to stop spam in live chat ${uid()}`, intent: "PROBLEM", funnelStage: "AWARENESS", importance: 5 },
        { organizationId: A.org.id, productId, query: "best moderation tool", normalized: `best moderation tool ${uid()}`, intent: "COMMERCIAL", funnelStage: "CONSIDERATION", importance: 5 },
      ]),
    );
    await q((tx) => tx.insert(aiVisibilityPrompts).values({ organizationId: A.org.id, productId, prompt: "Which tools moderate live chats", active: true }));
    const s = await q((tx) => suggestFaqs(tx, A.actor, productId));
    expect(s.map((x) => x.question)).toEqual(["How to stop spam in live chat?", "Which tools moderate live chats?"]);
    expect(await q((tx) => suggestFaqs(tx, A.actor, productId))).toEqual([]);
    const drafts = await q((tx) => tx.select().from(productFaqs).where(and(eq(productFaqs.productId, productId), eq(productFaqs.answer, ""))));
    const suggested = drafts.filter((d) => d.suggestedFrom?.startsWith("query:") || d.suggestedFrom?.startsWith("prompt:"));
    expect(suggested.filter((d) => d.question !== "Draft?").map((d) => d.verification)).toEqual(["UNVERIFIED", "UNVERIFIED"]);
    const g = (await q((tx) => loadProductGraph(tx, A.org.id, productId)))!;
    expect(buildAnswerBlocks(g).answers.some((a) => a.question === "How to stop spam in live chat?")).toBe(false);
  });

  it("the entity profile never substitutes the homepage for a missing source", async () => {
    const g = (await q((tx) => loadProductGraph(tx, A.org.id, productId)))!;
    const e = buildEntityProfile(g, "Org");
    for (const c of [...e.features, ...e.whoFor.audiences]) {
      expect(c.sourced).toBe(c.sources.length > 0);
      expect(c.sources).not.toContain("https://prov2.example");
    }
  });
});

describe("tenant isolation of product_claims", () => {
  it("another organisation can neither read nor write a product's claims", async () => {
    const mine = await q((tx) => tx.select().from(productClaims).where(eq(productClaims.productId, productId)));
    expect(mine.length).toBeGreaterThan(0);
    expect(await withOrg(B.org.id, (tx) => tx.select().from(productClaims).where(eq(productClaims.productId, productId)))).toEqual([]);
    await expect(withOrg(B.org.id, (tx) => tx.insert(productClaims).values({ organizationId: A.org.id, productId, field: "category", value: "Injected" }))).rejects.toThrow();
    const updated = await withOrg(B.org.id, (tx) => tx.update(productClaims).set({ verification: "VERIFIED" }).where(eq(productClaims.productId, productId)).returning());
    expect(updated).toEqual([]);
    // Services refuse foreign ids too.
    await expect(withOrg(B.org.id, (tx) => setFactVerification(tx, B.actor, { kind: "claim", id: mine[0].id, verification: "REJECTED" }))).rejects.toThrow(/not found/);
  });
});
