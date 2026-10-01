import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, withOrg, type Tx } from "@/db";
import { aiRuns, auditLogs, contentAssets, contentVersions, organizations, pages, productFacets } from "@/db/schema";
import type { LlmProvider } from "@/ai/types";
import { EDITOR_TODO } from "@/core/content/markers";
import {
  approveAsset,
  createAsset,
  createAssetForPage,
  generateQueued,
  generateVersion,
  getAsset,
  latestVersion,
  publishAsset,
  repurposeAsset,
  saveEditedVersion,
} from "@/services/content";
import { syncPagePlan } from "@/services/discovery";
import { publishedPages } from "@/services/public";
import { newOrg, seedCompleteProduct } from "./helpers";

let ctx: Awaited<ReturnType<typeof newOrg>>;
let other: Awaited<ReturnType<typeof newOrg>>;
let orgId: string;
let productId: string;

const run = <T>(fn: (tx: Tx) => Promise<T>) => withOrg(orgId, fn);
const asset = (id: string) => run((tx) => getAsset(tx, orgId, id));

/**
 * Each scenario gets its own organisation: the quality gate rightly blocks
 * near-duplicates, and identical drafts of one product would be duplicates.
 */
async function scenario(label: string) {
  ctx = await newOrg(label);
  orgId = ctx.org.id;
  productId = (await seedCompleteProduct(orgId, { name: "Beacon Live" })).product.id;
  await run((tx) => syncPagePlan(tx, orgId, productId));
}

/** A stub LLM: returns `rewrite(templateBody)` as the rewritten body. */
function stubLlm(rewrite: (body: string) => string, calls: string[] = []): LlmProvider {
  return {
    id: "anthropic",
    label: "Stub",
    model: "stub-model",
    answer: async () => ({ text: "", citations: [] }),
    generateObject: async ({ prompt }) => {
      calls.push(prompt);
      const body = prompt.split("\nDRAFT:\n")[1] ?? "";
      return { title: "Rewritten title for Beacon Live", metaTitle: "Rewritten title for Beacon Live", metaDescription: "Real-time moderation for TikTok live streams run by creators and agencies.", body: rewrite(body) } as never;
    },
  };
}

/** Generate and approve a fresh LANDING_PAGE asset for the product (no page link). */
async function approvedLanding(title: string) {
  const a = await run((tx) => createAsset(tx, ctx.actor, { productId, type: "LANDING_PAGE", title }));
  const g = await run((tx) => generateVersion(tx, ctx.actor, a.id, "Novarys"));
  expect(g.status).toBe("HUMAN_APPROVAL");
  await run((tx) => approveAsset(tx, ctx.actor, a.id, { acknowledge: true }));
  return a.id;
}

beforeAll(async () => {
  other = await newOrg("content-integrity-other");
});
afterAll(closeDb);

describe("verified-only generation", () => {
  it("never writes unverified facts and the fact check has no HIGH claim", async () => {
    await scenario("ci-68");
    await run((tx) =>
      tx.insert(productFacets).values({ organizationId: orgId, productId, kind: "FEATURE", slug: "unverified-beta", name: "Unverified beta mode", description: "An unverified capability nobody checked.", verification: "UNVERIFIED" }),
    );
    const a = await run((tx) => createAsset(tx, ctx.actor, { productId, type: "LINKEDIN_POST", title: "Post" }));
    const r = await run((tx) => generateVersion(tx, ctx.actor, a.id));
    expect(r.version.body).not.toContain("Unverified beta mode");
    expect(r.fact.claims.filter((c) => c.severity === "HIGH")).toEqual([]);
    expect(r.quality.checks.length).toBeGreaterThan(0);
    expect((await run((tx) => latestVersion(tx, a.id)))!.qualityCheck).toBeTruthy();
  });
});

describe("approval gates (server side)", () => {
  it("blocks approval when HIGH claims appear against the current graph", async () => {
    await scenario("ci-67");
    const a = await run((tx) => createAsset(tx, ctx.actor, { productId, type: "LANDING_PAGE", title: "Gate" }));
    await run((tx) => generateVersion(tx, ctx.actor, a.id));
    expect((await asset(a.id)).status).toBe("HUMAN_APPROVAL");
    // A fact loses its verification after the draft was generated: the draft now relies on an unverified fact.
    await run((tx) => tx.update(productFacets).set({ verification: "NEEDS_REVIEW" }).where(and(eq(productFacets.productId, productId), eq(productFacets.slug, "keyword-filters"))));
    await expect(run((tx) => approveAsset(tx, ctx.actor, a.id, { acknowledge: true }))).rejects.toThrow(/high-severity claim\(s\) block approval/);
    expect((await asset(a.id)).status).toBe("HUMAN_APPROVAL");
    await run((tx) => tx.update(productFacets).set({ verification: "VERIFIED" }).where(and(eq(productFacets.productId, productId), eq(productFacets.slug, "keyword-filters"))));
  });

  it("MEDIUM claims need an explicit acknowledgment", async () => {
    await scenario("ci-47");
    const a = await run((tx) => createAsset(tx, ctx.actor, { productId, type: "LANDING_PAGE", title: "Ack" }));
    await run((tx) => generateVersion(tx, ctx.actor, a.id));
    const v = (await run((tx) => latestVersion(tx, a.id)))!;
    const body = v.body.replace(/\n## /, "\nKeyword filters hide live comments for agencies running weekly giveaways.\n\n## ");
    const r = await run((tx) => saveEditedVersion(tx, ctx.actor, a.id, { body }));
    expect(r.status).toBe("HUMAN_APPROVAL");
    expect(r.fact.counts).toMatchObject({ HIGH: 0, MEDIUM: 1 });
    await expect(run((tx) => approveAsset(tx, ctx.actor, a.id))).rejects.toThrow(/explicit acknowledgment/);
    await run((tx) => approveAsset(tx, ctx.actor, a.id, { acknowledge: true }));
    expect((await asset(a.id)).status).toBe("APPROVED");
    const logs = await run((tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.entityId, a.id), eq(auditLogs.action, "content.approve"))));
    expect(logs[0].metadata).toMatchObject({ acknowledgedClaims: 1 });
  });

  it("optionally requires the approver to differ from the author", async () => {
    await scenario("ci-60");
    await run(async (tx) => {
      const org = (await tx.query.organizations.findFirst({ where: eq(organizations.id, orgId) }))!;
      await tx.update(organizations).set({ settings: { ...org.settings, content: { requireDistinctApprover: true } } }).where(eq(organizations.id, orgId));
    });
    const a = await run((tx) => createAsset(tx, ctx.actor, { productId, type: "LANDING_PAGE", title: "Four eyes" }));
    await run((tx) => generateVersion(tx, ctx.actor, a.id));
    await expect(run((tx) => approveAsset(tx, ctx.actor, a.id, { acknowledge: true }))).rejects.toThrow(/approver to differ from the author/);
    const reviewer = { organizationId: orgId, userId: other.user.id, actorType: "USER" as const };
    await run((tx) => approveAsset(tx, reviewer, a.id, { acknowledge: true }));
    expect((await asset(a.id)).approvedBy).toBe(other.user.id);
  });
});

describe("published versions", () => {
  it("keeps serving the published version while a new draft is edited, until it is approved and published", async () => {
    await scenario("ci-101");
    const productPage = (await run((tx) => tx.query.pages.findFirst({ where: and(eq(pages.productId, productId), eq(pages.type, "PRODUCT")) })))!;
    const a = await run((tx) => createAssetForPage(tx, ctx.actor, productPage.id));
    await run((tx) => generateVersion(tx, ctx.actor, a.id, "Novarys"));
    await run((tx) => approveAsset(tx, ctx.actor, a.id, { acknowledge: true }));
    await run((tx) => publishAsset(tx, ctx.actor, a.id));
    const published = await asset(a.id);
    expect(published.publishedVersionId).toBe(published.approvedVersionId);
    const live1 = (await run((tx) => publishedPages(tx, orgId))).find((r) => r.asset.id === a.id)!;
    expect(live1.version!.version).toBe(1);

    // An editor (content:write) edits the published asset: a new draft, the page stays published with v1.
    const v1 = live1.version!;
    const edited = await run((tx) => saveEditedVersion(tx, ctx.actor, a.id, { body: v1.body.replace("## Who it is for", "Beacon Live keeps TikTok live streams safe.\n\n## Who it is for") }));
    expect(edited.version.version).toBe(2);
    const during = await asset(a.id);
    expect(during.status).not.toBe("PUBLISHED");
    expect(during.publishedVersionId).toBe(v1.id);
    expect((await run((tx) => tx.query.pages.findFirst({ where: eq(pages.id, productPage.id) })))!.status).toBe("PUBLISHED");
    const live2 = (await run((tx) => publishedPages(tx, orgId))).find((r) => r.asset.id === a.id)!;
    expect(live2.version!.id).toBe(v1.id);
    expect(live2.version!.body).toBe(v1.body);

    // Publishing the new version needs a new approval.
    await expect(run((tx) => publishAsset(tx, ctx.actor, a.id))).rejects.toThrow(/Invalid content transition/);
    await run((tx) => approveAsset(tx, ctx.actor, a.id, { acknowledge: true }));
    await run((tx) => publishAsset(tx, ctx.actor, a.id));
    const live3 = (await run((tx) => publishedPages(tx, orgId))).find((r) => r.asset.id === a.id)!;
    expect(live3.version!.version).toBe(2);
  });
});

describe("repurposing", () => {
  let sourceId: string;
  let derivativeIds: string[];

  it("is refused unless the source is approved or published", async () => {
    await scenario("ci-55");
    const a = await run((tx) => createAsset(tx, ctx.actor, { productId, type: "LANDING_PAGE", title: "Draft source" }));
    await run((tx) => generateVersion(tx, ctx.actor, a.id));
    await expect(run((tx) => repurposeAsset(tx, ctx.actor, a.id, ["X_POST"]))).rejects.toThrow(/Only approved or published content/);
  });

  it("creates derivative drafts that need their own approval", async () => {
    await scenario("ci-repurpose");
    sourceId = await approvedLanding("Source for derivatives");
    const src = await asset(sourceId);
    const r = await run((tx) => repurposeAsset(tx, ctx.actor, sourceId, ["X_POST", "LINKEDIN_POST", "FAQ"]));
    derivativeIds = r.derivatives.map((d) => d.id);
    expect(r.derivatives).toHaveLength(3);
    for (const d of r.derivatives) {
      const x = await asset(d.id);
      expect(x).toMatchObject({ sourceAssetId: sourceId, sourceVersionId: src.approvedVersionId, sourceStaleAt: null });
      expect(["FACT_CHECK", "SEO_CHECK", "HUMAN_APPROVAL"]).toContain(x.status);
      const v = (await run((tx) => latestVersion(tx, d.id)))!;
      const srcRefs = new Set((await run((tx) => tx.query.contentVersions.findFirst({ where: eq(contentVersions.id, src.approvedVersionId!) })))!.factRefs.map((f) => f.ref));
      expect(v.factRefs.every((f) => srcRefs.has(f.ref))).toBe(true);
      expect(v.factCheck!.claims.filter((c) => c.severity === "HIGH")).toEqual([]);
    }
  });

  it("flags derivatives stale when the source publishes a newer version", async () => {
    await run((tx) => publishAsset(tx, ctx.actor, sourceId));
    // Publishing the version the derivatives were built from does not make them stale.
    for (const id of derivativeIds) expect((await asset(id)).sourceStaleAt).toBeNull();
    const v = (await run((tx) => latestVersion(tx, sourceId)))!;
    await run((tx) => saveEditedVersion(tx, ctx.actor, sourceId, { body: v.body.replace("## Who it is for", "Beacon Live keeps TikTok live streams safe.\n\n## Who it is for") }));
    await run((tx) => approveAsset(tx, ctx.actor, sourceId, { acknowledge: true }));
    await run((tx) => publishAsset(tx, ctx.actor, sourceId));
    for (const id of derivativeIds) expect((await asset(id)).sourceStaleAt).toBeInstanceOf(Date);
  });

  it("is not reachable from another organisation", async () => {
    await expect(withOrg(other.org.id, (tx) => repurposeAsset(tx, other.actor, sourceId, ["X_POST"]))).rejects.toThrow("Content asset not found");
    const rows = await withOrg(other.org.id, (tx) => tx.select().from(contentAssets).where(eq(contentAssets.sourceAssetId, sourceId)));
    expect(rows).toHaveLength(0);
  });
});

describe("queued generation (LLM outside transactions)", () => {
  it("keeps a guarded LLM rewrite and records its provenance", async () => {
    await scenario("ci-56");
    const a = await run((tx) => createAsset(tx, ctx.actor, { productId, type: "LANDING_PAGE", title: "LLM" }));
    const calls: string[] = [];
    const r = await generateQueued(run, ctx.actor, a.id, { resolveLlm: async () => stubLlm((b) => b.replace(/^# .*$/m, "# Rewritten title for Beacon Live"), calls), base: { version: 0, status: "IDEA" } });
    expect(calls).toHaveLength(1);
    expect(r.aborted).toBe(false);
    if (r.aborted) return;
    expect(r.generatedBy).toBe("anthropic:stub-model");
    expect(r.version.body).toContain("# Rewritten title for Beacon Live");
    const runRow = await run((tx) => tx.query.aiRuns.findFirst({ where: eq(aiRuns.id, r.version.aiRunId!) }));
    expect(runRow).toMatchObject({ task: "rewriteContent", status: "SUCCEEDED" });
  });

  it("rejects a rewrite that drops editor TODO lines or adds unsupported claims", async () => {
    await scenario("ci-75");
    const a = await run((tx) => createAsset(tx, ctx.actor, { productId, type: "OUTREACH", title: "Outreach" }));
    const r = await generateQueued(run, ctx.actor, a.id, { resolveLlm: async () => stubLlm((b) => b.split("\n").filter((l) => !l.startsWith(EDITOR_TODO)).join("\n") + "\nTrusted by 10,000 agencies.\n") });
    expect(r.aborted).toBe(false);
    if (r.aborted) return;
    expect(r.generatedBy).toMatch(/rejected by the rewrite guard/);
    expect(r.version.body).toContain(EDITOR_TODO);
    expect(r.version.body).not.toContain("10,000");
  });

  it("does not regress an asset approved while the job was queued (aborts with a note)", async () => {
    await scenario("ci-82");
    const id = await approvedLanding("Approved meanwhile");
    const before = await asset(id);
    // The job was requested while the asset awaited approval (HUMAN_APPROVAL, version 1).
    const r = await generateQueued(run, { ...ctx.actor, actorType: "SYSTEM" }, id, { base: { version: 1, status: "HUMAN_APPROVAL" } });
    expect(r.aborted).toBe(true);
    if (!r.aborted) return;
    expect(r.note).toMatch(/approved while this draft was being generated/);
    const after = await asset(id);
    expect(after).toMatchObject({ status: "APPROVED", currentVersion: before.currentVersion, approvedVersionId: before.approvedVersionId });
    const logs = await run((tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.entityId, id), eq(auditLogs.action, "content.generate_aborted"))));
    expect(logs).toHaveLength(1);
  });

  it("does not overwrite a human edit made while the job was queued", async () => {
    await scenario("ci-63");
    const a = await run((tx) => createAsset(tx, ctx.actor, { productId, type: "LANDING_PAGE", title: "Edited meanwhile" }));
    await run((tx) => generateVersion(tx, ctx.actor, a.id));
    const v = (await run((tx) => latestVersion(tx, a.id)))!;
    await run((tx) => saveEditedVersion(tx, ctx.actor, a.id, { body: v.body }));
    const r = await generateQueued(run, ctx.actor, a.id, { base: { version: 1, status: "HUMAN_APPROVAL" } });
    expect(r.aborted).toBe(true);
    expect((await asset(a.id)).currentVersion).toBe(2);
  });
});
