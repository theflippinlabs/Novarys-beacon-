import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq, isNull } from "drizzle-orm";
import { closeDb, withOrg } from "@/db";
import { aiRuns, auditLogs, contentAssets, contentVersions, pages, productFacets, products } from "@/db/schema";
import { approveAsset, createAssetForPage, generateVersion, getAsset, latestVersion, publishAsset, rejectAsset, saveEditedVersion } from "@/services/content";
import { syncPagePlan } from "@/services/discovery";
import { newOrg, seedCompleteProduct } from "./helpers";
import { CONTENT_RULES_VERSION } from "@/core/content/generate";

let ctx: Awaited<ReturnType<typeof newOrg>>;
let orgId: string;
let productId: string;
let productPage: typeof pages.$inferSelect;

const asset = (id: string) => withOrg(orgId, (tx) => getAsset(tx, orgId, id));
const page = (id: string) => withOrg(orgId, async (tx) => (await tx.query.pages.findFirst({ where: eq(pages.id, id) }))!);

beforeAll(async () => {
  ctx = await newOrg("content");
  orgId = ctx.org.id;
  const seeded = await seedCompleteProduct(orgId, { name: "Beacon Live" });
  productId = seeded.product.id;
  await withOrg(orgId, (tx) => syncPagePlan(tx, orgId, productId));
  productPage = (await withOrg(orgId, (tx) => tx.query.pages.findFirst({ where: and(eq(pages.productId, productId), eq(pages.type, "PRODUCT")) })))!;
});
afterAll(closeDb);

describe("content workflow", () => {
  let assetId: string;

  it("the planned PRODUCT page passes the publication gate", () => {
    expect(productPage.path).toBe("/beacon-live");
    expect(productPage.quality.publishable).toBe(true);
  });

  it("createAssetForPage links a LANDING_PAGE asset to the page and is idempotent", async () => {
    const a = await withOrg(orgId, (tx) => createAssetForPage(tx, ctx.actor, productPage.id));
    assetId = a.id;
    expect(a).toMatchObject({ type: "LANDING_PAGE", status: "IDEA", pageId: productPage.id, productId, currentVersion: 0, createdBy: ctx.user.id });
    expect((await page(productPage.id)).contentAssetId).toBe(a.id);
    const again = await withOrg(orgId, (tx) => createAssetForPage(tx, ctx.actor, productPage.id));
    expect(again.id).toBe(a.id);
  });

  it("approve/publish are refused before generation", async () => {
    await expect(withOrg(orgId, (tx) => approveAsset(tx, ctx.actor, assetId))).rejects.toThrow(/Invalid content transition IDEA → APPROVED/);
    await expect(withOrg(orgId, (tx) => publishAsset(tx, ctx.actor, assetId))).rejects.toThrow(/Invalid content transition IDEA → PUBLISHED/);
  });

  it("generateVersion (no LLM) stores a version, runs checks and lands in HUMAN_APPROVAL for a complete verified graph", async () => {
    const r = await withOrg(orgId, (tx) => generateVersion(tx, ctx.actor, assetId, "Novarys"));
    expect(r.generatedBy).toBe("beacon-rules");
    expect(r.version.version).toBe(1);
    expect(r.fact.passed).toBe(true);
    expect(r.seo.passed).toBe(true);
    expect(r.status).toBe("HUMAN_APPROVAL");
    const a = await asset(assetId);
    expect(a).toMatchObject({ status: "HUMAN_APPROVAL", currentVersion: 1 });
    expect((await page(productPage.id)).status).toBe("IN_REVIEW");
    const v = await withOrg(orgId, (tx) => latestVersion(tx, assetId));
    expect(v!.factCheck!.passed).toBe(true);
    expect(v!.seoCheck!.passed).toBe(true);
    expect(v!.aiRunId).toBeTruthy();
    const run = await withOrg(orgId, (tx) => tx.query.aiRuns.findFirst({ where: eq(aiRuns.id, v!.aiRunId!) }));
    expect(run).toMatchObject({ task: "generateContent", provider: "beacon-rules", status: "SUCCEEDED", promptVersion: CONTENT_RULES_VERSION });
  });

  it("an edit that adds an invented claim blocks the fact check, and approval is refused", async () => {
    const v = (await withOrg(orgId, (tx) => latestVersion(tx, assetId)))!;
    const body = v.body.replace(/\n## /, "\nTrusted by 10,000 agencies worldwide.\n\n## ");
    expect(body).not.toBe(v.body);
    const r = await withOrg(orgId, (tx) => saveEditedVersion(tx, ctx.actor, assetId, { body }));
    expect(r.version.version).toBe(2);
    expect(r.fact.passed).toBe(false);
    expect(r.status).toBe("FACT_CHECK");
    const bad = r.fact.claims.filter((c) => c.status !== "SUPPORTED");
    expect(bad.map((c) => c.claim)).toEqual(expect.arrayContaining([expect.stringContaining("Trusted by 10,000 agencies")]));
    expect(bad.find((c) => c.claim.includes("10,000"))!.status).toBe("UNSUPPORTED");
    expect((await asset(assetId)).status).toBe("FACT_CHECK");
    expect((await page(productPage.id)).status).toBe("DRAFT");
    // Approval is only possible from HUMAN_APPROVAL.
    await expect(withOrg(orgId, (tx) => approveAsset(tx, ctx.actor, assetId))).rejects.toThrow(/Invalid content transition FACT_CHECK → APPROVED/);
  });

  it("re-saving the original body re-runs checks and returns to HUMAN_APPROVAL", async () => {
    const v1 = await withOrg(orgId, (tx) => tx.query.contentVersions.findFirst({ where: and(eq(contentVersions.assetId, assetId), eq(contentVersions.version, 1)) }));
    const r = await withOrg(orgId, (tx) => saveEditedVersion(tx, ctx.actor, assetId, { body: v1!.body }));
    expect(r.version.version).toBe(3);
    expect(r.version.metaTitle).toBe(v1!.metaTitle); // carried over from the previous version
    expect(r.status).toBe("HUMAN_APPROVAL");
  });

  it("an edit that breaks SEO rules stops at SEO_CHECK", async () => {
    const v = (await withOrg(orgId, (tx) => latestVersion(tx, assetId)))!;
    const r = await withOrg(orgId, (tx) => saveEditedVersion(tx, ctx.actor, assetId, { body: v.body, metaTitle: "Short" }));
    expect(r.fact.passed).toBe(true);
    expect(r.seo.passed).toBe(false);
    expect(r.seo.checks.find((c) => c.rule === "meta_title")!.ok).toBe(false);
    expect(r.status).toBe("SEO_CHECK");
    await expect(withOrg(orgId, (tx) => approveAsset(tx, ctx.actor, assetId))).rejects.toThrow(/SEO_CHECK → APPROVED/);
    const fixed = await withOrg(orgId, (tx) => saveEditedVersion(tx, ctx.actor, assetId, { body: v.body, metaTitle: v.metaTitle }));
    expect(fixed.status).toBe("HUMAN_APPROVAL");
  });

  it("approve from HUMAN_APPROVAL with passing checks records the approver", async () => {
    await withOrg(orgId, (tx) => approveAsset(tx, ctx.actor, assetId));
    const a = await asset(assetId);
    expect(a.status).toBe("APPROVED");
    expect(a.approvedBy).toBe(ctx.user.id);
    expect(a.approvedAt).toBeInstanceOf(Date);
    expect((await page(productPage.id)).status).toBe("APPROVED");
  });

  it("publish is rejected when the page fails the publication quality gate", async () => {
    // Facts lose their verification after approval → the planner re-scores the page below the gate.
    await withOrg(orgId, async (tx) => {
      await tx.update(productFacets).set({ verification: "UNVERIFIED" }).where(eq(productFacets.productId, productId));
      await tx.update(products).set({ lastVerifiedAt: null }).where(eq(products.id, productId));
      await syncPagePlan(tx, orgId, productId);
    });
    const p = await page(productPage.id);
    expect(p.quality.publishable).toBe(false);
    expect(String(p.quality.blockers)).toMatch(/Factual confidence/);
    await expect(withOrg(orgId, (tx) => publishAsset(tx, ctx.actor, assetId))).rejects.toThrow(/publication quality gate.*Factual confidence/);
    expect((await asset(assetId)).status).toBe("APPROVED");
  });

  it("publish succeeds once the gate passes again; page becomes PUBLISHED", async () => {
    await withOrg(orgId, async (tx) => {
      await tx.update(productFacets).set({ verification: "VERIFIED" }).where(eq(productFacets.productId, productId));
      await tx.update(products).set({ lastVerifiedAt: new Date() }).where(eq(products.id, productId));
      await syncPagePlan(tx, orgId, productId);
    });
    await withOrg(orgId, (tx) => publishAsset(tx, ctx.actor, assetId));
    const a = await asset(assetId);
    expect(a.status).toBe("PUBLISHED");
    expect(a.publishedAt).toBeInstanceOf(Date);
    const p = await page(productPage.id);
    expect(p.status).toBe("PUBLISHED");
    expect(p.publishedAt).toBeInstanceOf(Date);
  });

  it("reject: only from allowed states, stores the reason and sends the page back to DRAFT", async () => {
    // PUBLISHED → REJECTED is not a valid transition.
    await expect(withOrg(orgId, (tx) => rejectAsset(tx, ctx.actor, assetId, "nope"))).rejects.toThrow(/PUBLISHED → REJECTED/);
    const faqPage = (await withOrg(orgId, (tx) => tx.query.pages.findFirst({ where: and(eq(pages.productId, productId), eq(pages.type, "ANSWER"), isNull(pages.contentAssetId)) })))!;
    const a = await withOrg(orgId, (tx) => createAssetForPage(tx, ctx.actor, faqPage.id));
    expect(a.type).toBe("FAQ");
    await withOrg(orgId, (tx) => generateVersion(tx, ctx.actor, a.id));
    await withOrg(orgId, (tx) => rejectAsset(tx, ctx.actor, a.id, "Off-brand tone"));
    const after = await asset(a.id);
    expect(after).toMatchObject({ status: "REJECTED", rejectionReason: "Off-brand tone" });
    expect((await page(faqPage.id)).status).toBe("DRAFT");
    // A rejected asset can be regenerated; the rejection reason is cleared.
    const regen = await withOrg(orgId, (tx) => generateVersion(tx, ctx.actor, a.id));
    expect(regen.version.version).toBe(2);
    expect((await asset(a.id)).rejectionReason).toBeNull();
  });

  it("writes audit log rows for every workflow step", async () => {
    const logs = await withOrg(orgId, (tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.organizationId, orgId), eq(auditLogs.entityId, assetId))));
    const actions = logs.map((l) => l.action);
    for (const a of ["content.create", "content.generate", "content.edit", "content.approve", "content.publish"]) expect(actions).toContain(a);
    expect(actions.filter((a) => a === "content.edit").length).toBe(4);
    expect(logs.every((l) => l.actorUserId === ctx.user.id)).toBe(true);
    const rejected = await withOrg(orgId, (tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.organizationId, orgId), eq(auditLogs.action, "content.reject"))));
    expect(rejected[0].metadata).toEqual({ reason: "Off-brand tone" });
  });

  it("assets of another organisation are not reachable", async () => {
    const other = await newOrg("content-other");
    await expect(withOrg(other.org.id, (tx) => getAsset(tx, other.org.id, assetId))).rejects.toThrow("Content asset not found");
    await expect(withOrg(other.org.id, (tx) => approveAsset(tx, other.actor, assetId))).rejects.toThrow("Content asset not found");
    const v = await withOrg(other.org.id, (tx) => tx.select().from(contentAssets).where(eq(contentAssets.id, assetId)));
    expect(v).toHaveLength(0);
  });
});
