import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { asSystem, closeDb, withOrg } from "@/db";
import { auditLogs, contentAssets, media, memberships, organizations, productFacets, productFaqs, productPricing, products } from "@/db/schema";
import { AGENT_TOOLS } from "@/agent/tools";
import type { AgentToolContext } from "@/agent/types";
import { makeT } from "@/i18n/core";
import type { AuthContext } from "@/lib/auth/service";
import type { Role } from "@/lib/auth/rbac";
import { newOrg, seedCompleteProduct } from "./helpers";

type Org = Awaited<ReturnType<typeof newOrg>>;

let a: Org;
let b: Org;
let seededSlug: string;

const tool = (name: string) => {
  const t = AGENT_TOOLS.find((x) => x.name === name);
  if (!t) throw new Error(`no tool ${name}`);
  return t;
};

async function authFor(o: Org, role: Role): Promise<AuthContext> {
  const org = (await asSystem((tx) => tx.query.organizations.findFirst({ where: eq(organizations.id, o.org.id) })))!;
  return { user: { id: o.user.id, email: o.email, name: "Owner" }, org: { id: org.id, slug: org.slug, name: org.name, settings: org.settings, branding: org.branding }, role, sessionTokenHash: "test" };
}

/** Mirrors the agent loop: validate with the tool's schema, run inside withOrg, return JSON-roundtripped data. */
async function run<T = Record<string, unknown>>(o: Org, name: string, input: unknown, role: Role = "OWNER"): Promise<T> {
  const t = tool(name);
  const parsed = t.input.parse(input);
  const ctx = await authFor(o, role);
  const out = await withOrg(o.org.id, (tx) => {
    const c: AgentToolContext = { tx, ctx, actor: o.actor, locale: "en", t: makeT(null) };
    return t.run(c, parsed);
  });
  return JSON.parse(JSON.stringify(out)) as T;
}

beforeAll(async () => {
  a = await newOrg("agent-a");
  b = await newOrg("agent-b");
  seededSlug = (await seedCompleteProduct(a.org.id, { name: "Agent Seeded" })).product.slug;
});
afterAll(closeDb);

describe("agent tools: read", () => {
  it("overview marks unconnected sources as not connected and lists products", async () => {
    const r = await run<{ kpis: { discovery: { organicClicks: { status?: string } }; revenue: { mrr: { status?: string } } }; products: { slug: string }[]; priorityQueue: unknown[] }>(a, "get_workspace_overview", {});
    expect(r.kpis.discovery.organicClicks.status).toBe("not connected");
    expect(r.kpis.revenue.mrr.status).toBe("not connected");
    expect(r.products.map((p) => p.slug)).toContain(seededSlug);
    expect(Array.isArray(r.priorityQueue)).toBe(true);
  });

  it("get_product returns the graph summary with verification and score", async () => {
    const r = await run<{ slug: string; facets: Record<string, { items: { verification: string }[] }>; completeness: { pct: number }; beaconScore: { live: { total: number; components: unknown[] } } }>(a, "get_product", { product: seededSlug });
    expect(r.slug).toBe(seededSlug);
    expect(r.facets.FEATURE.items.length).toBeGreaterThan(0);
    expect(r.facets.FEATURE.items[0].verification).toBe("VERIFIED");
    expect(r.completeness.pct).toBeGreaterThan(0);
    expect(r.beaconScore.live.components.length).toBe(7);
  });

  it("conversions and revenue report not connected instead of zeros", async () => {
    expect((await run<{ status: string }>(a, "get_conversions_summary", { days: 28 })).status).toBe("not connected");
    const rev = await run<{ revenue: { status?: string }; revenueByChannel: unknown }>(a, "get_revenue_summary", {});
    expect(rev.revenue.status).toBe("not connected");
    expect(rev.revenueByChannel).toBe("not connected");
  });

  it("lists product photos without bytes", async () => {
    const p = await withOrg(a.org.id, async (tx) => (await tx.query.products.findFirst({ where: eq(products.slug, seededSlug) }))!);
    await withOrg(a.org.id, (tx) => tx.insert(media).values({ organizationId: a.org.id, productId: p.id, filename: "logo.webp", mime: "image/webp", width: 10, height: 10, sizeBytes: 4, bytes: Buffer.from("RIFF") }));
    const r = await run<{ items: Record<string, unknown>[] }>(a, "list_product_photos", { product: seededSlug });
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).not.toHaveProperty("bytes");
    expect(r.items[0].url).toMatch(/\/api\/media\//);
  });
});

describe("agent tools: write flow", () => {
  let slug: string;
  let productId: string;

  it("creates a product with onboarding fields and audits via agent", async () => {
    const r = await run<{ created: { id: string; slug: string }; link: string }>(a, "create_product", { name: "Agent Made", domain: "https://agent-made.example/", category: "Testing", shortDescription: "A product created by the agent for tests." });
    slug = r.created.slug;
    productId = r.created.id;
    expect(slug).toBe("agent-made");
    expect(r.link).toBe("/products/agent-made/onboarding?step=1");
    const p = await withOrg(a.org.id, async (tx) => (await tx.query.products.findFirst({ where: eq(products.id, productId) }))!);
    expect(p).toMatchObject({ domain: "agent-made.example", category: "Testing", lastVerifiedAt: null });
    const logs = await withOrg(a.org.id, (tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.entityId, productId), eq(auditLogs.action, "product.create"))));
    expect(logs[0].metadata).toMatchObject({ via: "agent" });
  });

  it("adds knowledge facts as UNVERIFIED drafts", async () => {
    const src = await run<{ added: { id: string } }>(a, "add_product_source", { product: slug, title: "Home", url: "https://agent-made.example/" });
    const f = await run<{ added: { id: string; verification: string } }>(a, "add_product_facet", { product: slug, kind: "FEATURE", name: "Smart filters", description: "Filters things smartly according to the rules the user configures in the dashboard.", sourceId: src.added.id });
    expect(f.added.verification).toBe("UNVERIFIED");
    await run(a, "add_pricing_plan", { product: slug, planName: "Pro", priceMinorUnits: 1900, currency: "eur" });
    await run(a, "add_product_faq", { product: slug, question: "Does it filter things?", answer: "Yes, it filters things with configurable rules." });
    const verifications = await withOrg(a.org.id, async (tx) => [
      ...(await tx.select({ v: productFacets.verification }).from(productFacets).where(eq(productFacets.productId, productId))),
      ...(await tx.select({ v: productPricing.verification }).from(productPricing).where(eq(productPricing.productId, productId))),
      ...(await tx.select({ v: productFaqs.verification }).from(productFaqs).where(eq(productFaqs.productId, productId))),
    ]);
    expect(verifications).toHaveLength(3);
    expect(verifications.every((x) => x.v === "UNVERIFIED")).toBe(true);
    await expect(run(a, "add_product_facet", { product: slug, kind: "FEATURE", name: "Smart filters" })).rejects.toThrow(/already exists/);
  });

  it("clears human verification when the agent edits a verified description", async () => {
    const r = await run<{ needsReverification: boolean }>(a, "update_product", { product: seededSlug, shortDescription: "Real-time moderation for TikTok live streams." });
    expect(r.needsReverification).toBe(true);
    const p = await withOrg(a.org.id, async (tx) => (await tx.query.products.findFirst({ where: eq(products.slug, seededSlug) }))!);
    expect(p.lastVerifiedAt).toBeNull();
  });

  it("adds a query, generates opportunities and drafts content without approving or publishing", async () => {
    const q = await run<{ added: { id: string; status: string } }>(a, "add_query", { query: "agent made smart filters", product: slug, importance: 5 });
    expect(q.added.status).toBe("ACTIVE");
    await expect(run(a, "add_query", { query: "agent made smart filters", product: slug })).rejects.toThrow(/already exists/);

    const g = await run<{ products: number; currentOpportunities: number }>(a, "generate_opportunities", { product: slug });
    expect(g.products).toBe(1);
    expect(g.currentOpportunities).toBeGreaterThan(0);
    const list = await run<{ items: { id: string }[] }>(a, "list_opportunities", { product: slug });
    expect(list.items.length).toBeGreaterThan(0);

    const d = await run<{ asset: { id: string; status: string }; generation: string; link: string }>(a, "create_content_draft", { opportunityId: list.items[0].id, type: "ARTICLE" });
    expect(d.generation).toBe("done");
    expect(["FACT_CHECK", "SEO_CHECK", "HUMAN_APPROVAL"]).toContain(d.asset.status);
    expect(d.link).toBe(`/content/${d.asset.id}`);
    const opp = await run<{ status: string }>(a, "get_opportunity", { id: list.items[0].id });
    expect(opp.status).toBe("IN_PROGRESS");

    const fromProduct = await run<{ asset: { id: string; status: string } }>(a, "create_content_draft", { product: seededSlug, type: "FAQ", title: "Agent FAQ" });
    const again = await run<{ asset: { status: string; currentVersion: number } }>(a, "regenerate_content_draft", { id: fromProduct.asset.id });
    expect(again.asset.currentVersion).toBe(2);
    const statuses = await withOrg(a.org.id, (tx) => tx.select({ s: contentAssets.status }).from(contentAssets).where(eq(contentAssets.organizationId, a.org.id)));
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.some((x) => x.s === "APPROVED" || x.s === "PUBLISHED")).toBe(false);

    const c = await run<{ currentVersion: { body: string } }>(a, "get_content", { id: d.asset.id });
    expect(c.currentVersion.body.length).toBeGreaterThan(0);
  });

  it("refuses to regenerate approved content", async () => {
    const d = await run<{ asset: { id: string } }>(a, "create_content_draft", { product: seededSlug, type: "ARTICLE", title: "Approved one", generate: false });
    await withOrg(a.org.id, (tx) => tx.update(contentAssets).set({ status: "APPROVED" }).where(eq(contentAssets.id, d.asset.id)));
    await expect(run(a, "regenerate_content_draft", { id: d.asset.id })).rejects.toThrow(/human decision/);
  });

  it("distribution targets stop at PREPARED; submission stages are not accepted", async () => {
    const t = await run<{ added: { id: string; status: string } }>(a, "add_distribution_target", { name: "Example Directory", kind: "DIRECTORY", url: "https://directory.example/", product: slug });
    expect(t.added.status).toBe("DISCOVERED");
    expect((await run<{ status: string }>(a, "set_distribution_target_status", { id: t.added.id, status: "PREPARED" })).status).toBe("PREPARED");
    expect(() => tool("set_distribution_target_status").input.parse({ id: t.added.id, status: "SUBMITTED" })).toThrow();
  });

  it("syncs the page plan, recomputes the score and queues an audit", async () => {
    const plan = await run<{ planned: number }>(a, "sync_page_plan", { product: seededSlug });
    expect(plan.planned).toBeGreaterThan(0);
    const pages = await run<{ items: { id: string }[] }>(a, "list_planned_pages", { product: seededSlug });
    expect(pages.items.length).toBeGreaterThan(0);
    const score = await run<{ total: number }>(a, "recompute_beacon_score", { product: seededSlug });
    expect(score.total).toBeGreaterThan(0);
    const audit = await run<{ queued: { auditId: string } }>(a, "queue_seo_audit", { product: seededSlug });
    expect(audit.queued.auditId).toBeTruthy();
  });

  it("sets a product logo only from a PUBLIC image of the same workspace", async () => {
    const [pub] = await withOrg(a.org.id, (tx) => tx.insert(media).values({ organizationId: a.org.id, filename: "l.webp", mime: "image/webp", width: 1, height: 1, sizeBytes: 4, bytes: Buffer.from("RIFF") }).returning({ id: media.id }));
    const [priv] = await withOrg(a.org.id, (tx) => tx.insert(media).values({ organizationId: a.org.id, filename: "p.webp", mime: "image/webp", width: 1, height: 1, sizeBytes: 4, visibility: "PRIVATE", bytes: Buffer.from("RIFF") }).returning({ id: media.id }));
    const [other] = await withOrg(b.org.id, (tx) => tx.insert(media).values({ organizationId: b.org.id, filename: "o.webp", mime: "image/webp", width: 1, height: 1, sizeBytes: 4, bytes: Buffer.from("RIFF") }).returning({ id: media.id }));
    const r = await run<{ logoUrl: string }>(a, "set_product_logo", { product: slug, mediaId: pub.id });
    expect(r.logoUrl).toMatch(new RegExp(`/api/media/${pub.id}`));
    await expect(run(a, "set_product_logo", { product: slug, mediaId: priv.id })).rejects.toThrow();
    await expect(run(a, "set_product_logo", { product: slug, mediaId: other.id })).rejects.toThrow();
  });
});

describe("agent tools: isolation and permissions", () => {
  it("cannot read or write another tenant's data", async () => {
    await expect(run(b, "get_product", { product: seededSlug })).rejects.toThrow(/Product not found/);
    const aProduct = await withOrg(a.org.id, async (tx) => (await tx.query.products.findFirst({ where: eq(products.slug, seededSlug) }))!);
    await expect(run(b, "get_product", { product: aProduct.id })).rejects.toThrow(/Product not found/);
    await expect(run(b, "add_product_faq", { product: aProduct.id, question: "Cross tenant?", answer: "This must never be written." })).rejects.toThrow(/Product not found/);
    const list = await run<{ items: unknown[] }>(b, "list_products", {});
    expect(list.items).toHaveLength(0);
    const aOpp = await withOrg(a.org.id, (tx) => tx.execute<{ id: string }>(sql`select id from opportunities limit 1`));
    await expect(run(b, "get_opportunity", { id: aOpp.rows[0].id })).rejects.toThrow(/not found/);
    await expect(run(b, "set_opportunity_status", { id: aOpp.rows[0].id, status: "DISMISSED" })).rejects.toThrow(/not found/);
  });

  it("a VIEWER context cannot run write tools", async () => {
    await expect(run(a, "create_product", { name: "Viewer Product" }, "VIEWER")).rejects.toThrow(/does not allow/);
    await expect(run(a, "add_query", { query: "viewer query" }, "VIEWER")).rejects.toThrow(/does not allow/);
    const r = await run<{ items: unknown[] }>(a, "list_products", {}, "VIEWER");
    expect(r.items.length).toBeGreaterThan(0);
    const m = await asSystem((tx) => tx.query.memberships.findFirst({ where: eq(memberships.organizationId, a.org.id) }));
    expect(m?.role).toBe("OWNER");
  });
});
