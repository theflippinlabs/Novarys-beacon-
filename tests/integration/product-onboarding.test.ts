import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, withOrg } from "@/db";
import { auditLogs, distributionTargets, pages, productFacets, productPricing, products, queries } from "@/db/schema";
import { loadProductGraph } from "@/core/knowledge/load";
import { DISTRIBUTION_CATALOG } from "@/core/distribution/catalog";
import { createProduct, syncCompetitors, syncFacets, syncSources, replacePricing, updateProduct } from "@/services/products";
import { analyzeProduct, launchChecklist } from "@/services/onboarding";
import { createKey, newOrg } from "./helpers";

let ctx: Awaited<ReturnType<typeof newOrg>>;
let productId: string;
let orgId: string;

beforeAll(async () => {
  ctx = await newOrg("onb");
  orgId = ctx.org.id;
});
afterAll(closeDb);

const desc = (s: string) => `${s}, described at length so that the discovery planner has enough factual material.`;

describe("product knowledge graph + onboarding analysis", () => {
  it("createProduct slugifies, rejects duplicates and writes an audit log", async () => {
    const p = await withOrg(orgId, (tx) => createProduct(tx, ctx.actor, { name: "  Clip Studio Pro " }));
    productId = p.id;
    expect(p).toMatchObject({ slug: "clip-studio-pro", name: "Clip Studio Pro", organizationId: orgId, onboardingStep: 1 });
    await expect(withOrg(orgId, (tx) => createProduct(tx, ctx.actor, { name: "Clip Studio Pro" }))).rejects.toThrow(/already exists/);
    await expect(withOrg(orgId, (tx) => createProduct(tx, ctx.actor, { name: "!!!" }))).rejects.toThrow(/Invalid product name/);
    const logs = await withOrg(orgId, (tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.organizationId, orgId), eq(auditLogs.action, "product.create"))));
    expect(logs).toEqual([expect.objectContaining({ entityId: p.id, actorUserId: ctx.user.id, metadata: { name: "Clip Studio Pro" } })]);
  });

  it("syncs sources, facets, pricing and competitors; loadProductGraph returns them", async () => {
    await withOrg(orgId, async (tx) => {
      await updateProduct(tx, ctx.actor, productId, {
        domain: "clipstudio.example",
        category: "Video editing",
        shortDescription: "Short-form video editor for creator agencies.",
        fullDescription: "Clip Studio Pro turns long recordings into short clips for TikTok, Reels and Shorts, with captions and brand templates for agencies that manage many creators.",
        conversionUrls: [{ label: "Try free", url: "https://clipstudio.example/signup", kind: "TRY_FREE" }],
      });
      await syncSources(tx, ctx.actor, productId, [
        { title: "Website", url: "https://clipstudio.example/", kind: "WEBSITE" },
        { title: "Docs", url: "https://clipstudio.example/docs", kind: "DOCUMENTATION" },
      ]);
      await syncFacets(tx, ctx.actor, productId, "FEATURE", [
        { name: "Auto captions", slug: "auto-captions", description: desc("Automatic captions in 20 languages") },
        { name: "Brand templates", slug: "brand-templates", description: desc("Reusable brand templates") },
        { name: "Clip finder", slug: "clip-finder", description: desc("Finds highlight moments in recordings") },
      ]);
      await syncFacets(tx, ctx.actor, productId, "AUDIENCE", [{ name: "Creator agencies", slug: "creator-agencies", description: desc("Agencies managing many creators") }]);
      await syncFacets(tx, ctx.actor, productId, "PROBLEM", [{ name: "Editing short clips takes hours", slug: "editing-takes-hours", description: null }]);
      await replacePricing(tx, ctx.actor, productId, [
        { planName: "Starter", priceCents: 1900, currency: "EUR", interval: "MONTH" },
        { planName: "Agency", priceCents: null, currency: "EUR", interval: "MONTH" },
      ]);
      await syncCompetitors(tx, ctx.actor, productId, [
        { name: "CapCut", domain: "capcut.com" },
        { name: "Opus Clip", domain: null },
      ]);
    });
    const g = (await withOrg(orgId, (tx) => loadProductGraph(tx, orgId, productId)))!;
    expect(g.product.domain).toBe("clipstudio.example");
    expect(g.sources.map((s) => s.url).sort()).toEqual(["https://clipstudio.example/", "https://clipstudio.example/docs"]);
    expect(g.facets.filter((f) => f.kind === "FEATURE").map((f) => f.name)).toEqual(["Auto captions", "Brand templates", "Clip finder"]);
    expect(g.pricing.map((p) => [p.planName, p.priceCents])).toEqual([
      ["Starter", 1900],
      ["Agency", null],
    ]);
    expect(g.competitors.map((c) => c.competitor.name).sort()).toEqual(["CapCut", "Opus Clip"]);
    // A different org cannot load it.
    const other = await newOrg("onb-other");
    expect(await withOrg(other.org.id, (tx) => loadProductGraph(tx, other.org.id, productId))).toBeNull();
    expect(await withOrg(other.org.id, (tx) => loadProductGraph(tx, orgId, productId))).toBeNull();
  });

  it("re-syncing preserves ids, removes dropped items and sends changed VERIFIED facts back to review", async () => {
    await withOrg(orgId, async (tx) => {
      await tx.update(productFacets).set({ verification: "VERIFIED" }).where(eq(productFacets.productId, productId));
      await tx.update(productPricing).set({ verification: "VERIFIED" }).where(eq(productPricing.productId, productId));
    });
    const before = await withOrg(orgId, (tx) => tx.select().from(productFacets).where(and(eq(productFacets.productId, productId), eq(productFacets.kind, "FEATURE"))));
    await withOrg(orgId, async (tx) => {
      await syncFacets(tx, ctx.actor, productId, "FEATURE", [
        { name: "Auto captions", slug: "auto-captions", description: desc("Automatic captions in 20 languages") }, // unchanged
        { name: "Brand kits", slug: "brand-templates", description: desc("Reusable brand templates") }, // renamed
      ]);
      await replacePricing(tx, ctx.actor, productId, [{ planName: "starter", priceCents: 2400, currency: "EUR", interval: "MONTH" }]);
      await syncCompetitors(tx, ctx.actor, productId, [{ name: "CapCut", domain: null }]);
    });
    const after = await withOrg(orgId, (tx) => tx.select().from(productFacets).where(and(eq(productFacets.productId, productId), eq(productFacets.kind, "FEATURE"))));
    const bySlug = new Map(after.map((f) => [f.slug, f]));
    expect([...bySlug.keys()].sort()).toEqual(["auto-captions", "brand-templates"]);
    expect(bySlug.get("auto-captions")!.id).toBe(before.find((f) => f.slug === "auto-captions")!.id);
    expect(bySlug.get("auto-captions")!.verification).toBe("VERIFIED");
    expect(bySlug.get("brand-templates")!.verification).toBe("NEEDS_REVIEW");
    const pricing = await withOrg(orgId, (tx) => tx.select().from(productPricing).where(eq(productPricing.productId, productId)));
    expect(pricing).toHaveLength(1);
    expect(pricing[0]).toMatchObject({ priceCents: 2400, verification: "NEEDS_REVIEW" });
    const g = (await withOrg(orgId, (tx) => loadProductGraph(tx, orgId, productId)))!;
    expect(g.competitors.map((c) => c.competitor.name)).toEqual(["CapCut"]);
    expect(g.competitors[0].competitor.domain).toBe("capcut.com"); // a null domain does not wipe a known one
    // restore three features for the planner
    await withOrg(orgId, (tx) =>
      syncFacets(tx, ctx.actor, productId, "FEATURE", [
        { name: "Auto captions", slug: "auto-captions", description: desc("Automatic captions in 20 languages") },
        { name: "Brand kits", slug: "brand-templates", description: desc("Reusable brand templates") },
        { name: "Clip finder", slug: "clip-finder", description: desc("Finds highlight moments in recordings") },
      ]),
    );
  });

  it("launchChecklist reflects real state before analysis", async () => {
    const items = await withOrg(orgId, (tx) => launchChecklist(tx, orgId, productId));
    const done = Object.fromEntries(items.map((i) => [i.label, i.done]));
    expect(done["Canonical domain set"]).toBe(true);
    expect(done["Conversion URL declared"]).toBe(true);
    expect(done["Discovery pages planned"]).toBe(false);
    expect(done["Technical audit run"]).toBe(false);
    expect(done["Tracking keys created"]).toBe(false);
    expect(done["First events received"]).toBe(false);
    expect(done["Product page published"]).toBe(false);
    expect(done["Search Console connected"]).toBe(false);
    expect(done["≥ 10 active queries curated"]).toBe(false);
  });

  it("analyzeProduct generates CANDIDATE queries, plans pages, suggests distribution venues and completes onboarding", async () => {
    const res = await withOrg(orgId, (tx) => analyzeProduct(tx, orgId, productId));
    expect(res.queries.inserted).toBeGreaterThan(5);
    expect(res.pages.planned).toBeGreaterThan(0);
    expect(res.distributionSuggested).toBe(DISTRIBUTION_CATALOG.length);
    expect(res.completeness).toBeGreaterThan(0);
    expect(res.completeness).toBeLessThan(1);

    const qs = await withOrg(orgId, (tx) => tx.select().from(queries).where(eq(queries.productId, productId)));
    expect(qs.length).toBe(res.queries.inserted);
    expect(new Set(qs.map((q) => q.status))).toEqual(new Set(["CANDIDATE"]));
    expect(new Set(qs.map((q) => q.source))).toEqual(new Set(["GENERATED"]));
    expect(qs.map((q) => q.normalized)).toEqual(expect.arrayContaining(["clip studio pro", "clip studio pro vs capcut", "capcut alternatives"]));

    const ps = await withOrg(orgId, (tx) => tx.select().from(pages).where(eq(pages.productId, productId)));
    expect(ps.length).toBe(res.pages.planned);
    expect(ps.find((p) => p.type === "PRODUCT")).toMatchObject({ path: "/clip-studio-pro", status: "PLANNED", origin: "PLANNED" });
    expect(ps.filter((p) => p.type === "FEATURE")).toHaveLength(3);
    for (const p of ps) expect(typeof p.quality.publishable).toBe("boolean");

    const dts = await withOrg(orgId, (tx) => tx.select().from(distributionTargets).where(eq(distributionTargets.productId, productId)));
    expect(dts.map((d) => d.name).sort()).toEqual(DISTRIBUTION_CATALOG.map((d) => d.name).sort());
    expect(new Set(dts.map((d) => d.status))).toEqual(new Set(["DISCOVERED"]));

    const p = await withOrg(orgId, (tx) => tx.query.products.findFirst({ where: eq(products.id, productId) }));
    expect(p!.onboardingCompletedAt).toBeInstanceOf(Date);

    // Idempotent: a second run inserts no duplicate queries, pages or venues.
    const again = await withOrg(orgId, (tx) => analyzeProduct(tx, orgId, productId));
    expect(again.queries.inserted).toBe(0);
    expect(again.distributionSuggested).toBe(0);
    const ps2 = await withOrg(orgId, (tx) => tx.select().from(pages).where(eq(pages.productId, productId)));
    expect(ps2.length).toBe(ps.length);
  });

  it("launchChecklist reflects state after analysis and key creation", async () => {
    await createKey(orgId, "PUBLISHABLE", { productId, allowedOrigins: ["clipstudio.example"] });
    const items = await withOrg(orgId, (tx) => launchChecklist(tx, orgId, productId));
    const byLabel = Object.fromEntries(items.map((i) => [i.label, i]));
    expect(byLabel["Discovery pages planned"].done).toBe(true);
    expect(byLabel["Tracking keys created"].done).toBe(true);
    expect(byLabel["≥ 10 active queries curated"]).toMatchObject({ done: false, detail: "0 active" }); // CANDIDATE queries are not curated
    expect(byLabel["Product page published"].done).toBe(false);
    expect(byLabel["Canonical domain set"].href).toBe("/products/clip-studio-pro/knowledge");
  });

  it("analyzeProduct of an unknown product throws", async () => {
    await expect(withOrg(orgId, (tx) => analyzeProduct(tx, orgId, "00000000-0000-4000-8000-000000000000"))).rejects.toThrow("Product not found");
  });
});
