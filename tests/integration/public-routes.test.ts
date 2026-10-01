import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeDb, withOrg } from "@/db";
import { productFacets, products } from "@/db/schema";
import { POST as recommendPOST } from "@/app/api/v1/recommend/route";
import { GET as entityGET } from "@/app/api/v1/entity/[org]/[product]/route";
import { GET as healthGET } from "@/app/api/health/route";
import { ipHeader, jsonRequest, newOrg, params, seedCompleteProduct, uid } from "./helpers";

let orgSlug: string;
let orgId: string;
let live: typeof products.$inferSelect;
let unverified: typeof products.$inferSelect;
let notOnboarded: typeof products.$inferSelect;

const recommend = (body: unknown) => recommendPOST(jsonRequest("http://localhost/api/v1/recommend", body, { origin: "https://site.example" }));
const entity = (org: string, product: string) => entityGET(new Request(`http://localhost/api/v1/entity/${org}/${product}`, { headers: ipHeader() }), params({ org, product }));

beforeAll(async () => {
  const ctx = await newOrg("public");
  orgSlug = ctx.org.slug;
  orgId = ctx.org.id;
  live = (await seedCompleteProduct(orgId, { name: "Beacon Live", slug: `beacon-live-${uid()}`, onboarded: true })).product;
  await withOrg(orgId, async (tx) => {
    // An unverified facet on the live product must never be published.
    await tx.insert(productFacets).values({ organizationId: orgId, productId: live.id, kind: "FEATURE", slug: "secret-beta", name: "Secret beta autopilot", description: "Unreviewed claim.", verification: "UNVERIFIED" });
    // An onboarded product whose facts are all unverified (a legal product).
    [unverified] = await tx
      .insert(products)
      .values({ organizationId: orgId, slug: `contract-pal-${uid()}`, name: "Contract Pal", domain: "contractpal.example", category: "Legal software", shortDescription: "Contract review for lawyers.", status: "LIVE", onboardingCompletedAt: new Date() })
      .returning();
    await tx.insert(productFacets).values([
      { organizationId: orgId, productId: unverified.id, kind: "AUDIENCE", slug: "lawyers", name: "Lawyers and legal teams", verification: "UNVERIFIED" },
      { organizationId: orgId, productId: unverified.id, kind: "PROBLEM", slug: "clauses", name: "Reviewing contract clauses takes hours", verification: "NEEDS_REVIEW" },
      { organizationId: orgId, productId: unverified.id, kind: "FEATURE", slug: "extraction", name: "Contract clause extraction", verification: "UNVERIFIED" },
    ]);
    // A product with verified legal facts that has NOT completed onboarding.
    [notOnboarded] = await tx.insert(products).values({ organizationId: orgId, slug: `lex-${uid()}`, name: "Lex Draft", status: "LIVE", lastVerifiedAt: new Date() }).returning();
    await tx.insert(productFacets).values([
      { organizationId: orgId, productId: notOnboarded.id, kind: "AUDIENCE", slug: "lawyers", name: "Lawyers", verification: "VERIFIED" },
      { organizationId: orgId, productId: notOnboarded.id, kind: "PROBLEM", slug: "contracts", name: "Contract review and legal clauses", verification: "VERIFIED" },
    ]);
  });
});
afterAll(closeDb);

describe("POST /api/v1/recommend", () => {
  it("recommends a primary product from verified facts", async () => {
    const res = await recommend({ org: orgSlug, need: "We are an agency and spam is ruining our TikTok live chat" });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://site.example");
    const body = await res.json();
    expect(body.basis).toBe("verified product facts only");
    expect(body.primary).toMatchObject({ productId: live.id, productName: "Beacon Live" });
    expect(body.primary.why.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain("Secret beta");
    expect(body.primary.pricing).toEqual([expect.stringMatching(/^Pro: .*29.*\/month$/)]);
    expect(body.considered).toBe(2); // only onboarded products are considered
  });

  it("never uses unverified facts (or products that have not completed onboarding)", async () => {
    const res = await recommend({ org: orgSlug, need: "I am a lawyer and need help reviewing contract clauses" });
    const body = await res.json();
    expect(body.primary).toBeNull();
    expect(body.complementary).toEqual([]);
    expect(body.explanation).toMatch(/No product/);
    expect(JSON.stringify(body)).not.toContain("Contract Pal");
    expect(JSON.stringify(body)).not.toContain("Lex Draft");
  });

  it("returns a null primary with an explanation when nothing matches", async () => {
    const body = await (await recommend({ org: orgSlug, need: "How do I bake sourdough bread at home?" })).json();
    expect(body.primary).toBeNull();
    expect(body.explanation).toBe("No product's documented audiences, problems, use cases or features match this need closely enough to recommend it.");
  });

  it("validates input and unknown organisations", async () => {
    expect((await recommend({ org: orgSlug, need: "hi" })).status).toBe(400);
    expect((await recommend({ need: "a long enough need" })).status).toBe(400);
    expect((await recommendPOST(jsonRequest("http://localhost/api/v1/recommend", "{oops"))).status).toBe(400);
    expect((await recommend({ org: `nope-${uid()}`, need: "agency tiktok spam moderation" })).status).toBe(404);
    expect((await recommend({ org: "Bad Slug!", need: "agency tiktok spam moderation" })).status).toBe(404);
  });
});

describe("POST /api/v1/recommend: unverified product-level facts", () => {
  // BUG: verifiedOnly() (src/core/knowledge/types.ts) withholds shortDescription/fullDescription/howItWorks
  // when the product is not verified (lastVerifiedAt null) but keeps `category`, which recommendProducts()
  // scores (weight 2 per matched term). An unverified category alone is enough to be recommended.
  it("does not recommend a product on the strength of its unverified category", async () => {
    const ctx = await newOrg("public-cat");
    const [p] = await withOrg(ctx.org.id, (tx) =>
      tx.insert(products).values({ organizationId: ctx.org.id, slug: `clause-bot-${uid()}`, name: "Clause Bot", category: "Legal contract review software", status: "LIVE", onboardingCompletedAt: new Date(), lastVerifiedAt: null }).returning(),
    );
    const body = await (await recommend({ org: ctx.org.slug, need: "legal contract review software" })).json();
    expect(body.primary?.productId).not.toBe(p.id);
    expect(body.primary).toBeNull();
  });
});

describe("GET /api/v1/entity/{org}/{product}", () => {
  it("publishes verified facts only and lists unknowns", async () => {
    const res = await entity(orgSlug, live.slug);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = await res.json();
    expect(body.schema).toBe("beacon.entity/v1");
    expect(body.who).toMatchObject({ product: "Beacon Live", url: `https://${live.domain}` });
    const features = body.features.map((f: { text: string }) => f.text);
    expect(features).toEqual(expect.arrayContaining([expect.stringContaining("Keyword filters")]));
    expect(JSON.stringify(body)).not.toContain("Secret beta");
    expect(body.features.every((f: { verified: boolean }) => f.verified)).toBe(true);
    expect(body.unknowns).toEqual([]);
    expect(body.answers.length).toBeGreaterThan(0);
    expect(body.policy).toMatch(/Only human-verified facts/);
  });

  it("an onboarded product with unverified facts exposes none of them and lists them as unknowns", async () => {
    const body = await (await entity(orgSlug, unverified.slug)).json();
    expect(body.what.summary).toBeNull(); // product facts not verified → description withheld
    expect(body.whoFor.audiences).toEqual([]);
    expect(body.problem).toEqual([]);
    expect(body.features).toEqual([]);
    expect(body.unknowns).toEqual(expect.arrayContaining(["summary", "target audiences", "problems solved", "pricing", "how it works", "API availability", "free trial", "languages"]));
    expect(JSON.stringify(body)).not.toMatch(/Lawyers|clause/i);
  });

  it("returns 404 for products that have not completed onboarding, unknown products and unknown orgs", async () => {
    expect((await entity(orgSlug, notOnboarded.slug)).status).toBe(404);
    expect((await entity(orgSlug, `missing-${uid()}`)).status).toBe(404);
    expect((await entity(`nope-${uid()}`, live.slug)).status).toBe(404);
  });

  it("does not leak products across organisations", async () => {
    const other = await newOrg("public-other");
    expect((await entity(other.org.slug, live.slug)).status).toBe(404);
    const body = await (await recommend({ org: other.org.slug, need: "We are an agency and spam is ruining our TikTok live chat" })).json();
    expect(body.primary).toBeNull();
    expect(body.considered).toBe(0);
  });
});

describe("GET /api/health", () => {
  it("reports database health without tenant data", async () => {
    const res = await healthGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.db.ok).toBe(true);
    expect(Object.keys(body).sort()).toEqual(["db", "queue", "status", "time"]);
  });
});
