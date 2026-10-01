import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, withOrg, type Tx } from "@/db";
import { aiRuns, beaconScores, opportunities, pages, queries } from "@/db/schema";
import { addQuery } from "@/services/queries";
import { generateProductOpportunities } from "@/services/opportunities";
import { computeAndStoreScore, latestScoreDetail } from "@/services/score";
import { newOrg, seedCompleteProduct, uid } from "./helpers";

let orgId: string;
let productId: string;
const q = <T,>(fn: (tx: Tx) => Promise<T>) => withOrg(orgId, fn);
const gaps = () => q((tx) => tx.select().from(opportunities).where(and(eq(opportunities.productId, productId), eq(opportunities.type, "CONTENT_GAP"))));
let queryIds: string[] = [];

beforeAll(async () => {
  orgId = (await newOrg("opps")).org.id;
  productId = (await seedCompleteProduct(orgId, { name: `Opp Product ${uid()}` })).product.id;
  const rows = await q(async (tx) => [
    await addQuery(tx, orgId, { query: "tiktok live chat moderation tool", productId, importance: 5, status: "ACTIVE" }),
    await addQuery(tx, orgId, { query: "how to stop spam in tiktok live", productId, importance: 3, status: "ACTIVE" }),
    await addQuery(tx, orgId, { query: "low priority query nobody needs", productId, importance: 2, status: "ACTIVE" }),
    await addQuery(tx, orgId, { query: "candidate query not yet curated", productId, importance: 5, status: "CANDIDATE" }),
  ]);
  queryIds = rows.map((r) => r!.id);
  // Re-adding an existing query is a no-op.
  expect(await q((tx) => addQuery(tx, orgId, { query: "TikTok live chat moderation tool?", productId }))).toBeNull();
});
afterAll(closeDb);

describe("opportunities", () => {
  it("creates CONTENT_GAP opportunities for ACTIVE, uncovered queries with importance ≥ 3", async () => {
    const res = await q((tx) => generateProductOpportunities(tx, orgId, productId));
    expect(res.created).toBe(res.total);
    expect(res.total).toBeGreaterThanOrEqual(2);
    const g = await gaps();
    expect(g.map((o) => o.queryId).sort()).toEqual([queryIds[0], queryIds[1]].sort());
    for (const o of g) {
      expect(o.status).toBe("OPEN");
      expect(o.fingerprint).toBe(`content_gap:${o.queryId}`);
      expect(o.priorityScore).toBeGreaterThan(0);
      expect(o.actions.length).toBeGreaterThan(0);
    }
    const run = await q((tx) => tx.select().from(aiRuns).where(and(eq(aiRuns.organizationId, orgId), eq(aiRuns.task, "generateOpportunity"))));
    expect(run.length).toBe(1);
  });

  it("is idempotent and preserves human decisions", async () => {
    const before = await q((tx) => tx.select().from(opportunities).where(eq(opportunities.productId, productId)));
    const target = before.find((o) => o.queryId === queryIds[1])!;
    await q((tx) => tx.update(opportunities).set({ status: "DISMISSED" }).where(eq(opportunities.id, target.id)));
    const res = await q((tx) => generateProductOpportunities(tx, orgId, productId));
    expect(res.created).toBe(0);
    expect(res.resolved).toBe(0);
    const after = await q((tx) => tx.select().from(opportunities).where(eq(opportunities.productId, productId)));
    expect(after.length).toBe(before.length);
    expect(after.map((o) => o.id).sort()).toEqual(before.map((o) => o.id).sort());
    expect(after.find((o) => o.id === target.id)!.status).toBe("DISMISSED");
  });

  it("auto-closes an OPEN opportunity whose condition no longer holds (query covered)", async () => {
    await q(async (tx) => {
      const [p] = await tx.insert(pages).values({ organizationId: orgId, productId, type: "GUIDE", path: `/guides/${uid()}`, title: "Moderation tool", status: "PUBLISHED", targetQueryId: queryIds[0] }).returning();
      await tx.update(queries).set({ coverage: "COVERED", pageId: p.id }).where(eq(queries.id, queryIds[0]));
    });
    const res = await q((tx) => generateProductOpportunities(tx, orgId, productId));
    expect(res.resolved).toBe(1);
    const g = await gaps();
    expect(g.find((o) => o.queryId === queryIds[0])!.status).toBe("DONE");
    expect(g.find((o) => o.queryId === queryIds[1])!.status).toBe("DISMISSED");
  });
});

describe("beacon score", () => {
  it("computeAndStoreScore returns a total within 0..100 with components, and stores a row", async () => {
    const score = await q((tx) => computeAndStoreScore(tx, orgId, productId));
    expect(score.total).toBeGreaterThanOrEqual(0);
    expect(score.total).toBeLessThanOrEqual(100);
    expect(score.components.length).toBeGreaterThan(0);
    const sum = score.components.reduce((s, c) => s + c.max, 0);
    expect(sum).toBe(100);
    for (const c of score.components) {
      expect(c.earned).toBeGreaterThanOrEqual(0);
      expect(c.earned).toBeLessThanOrEqual(c.max);
    }
    const rows = await q((tx) => tx.select().from(beaconScores).where(eq(beaconScores.productId, productId)));
    expect(rows).toHaveLength(1);
    expect(rows[0].total).toBe(score.total);
    const latest = await q((tx) => latestScoreDetail(tx, orgId, productId));
    expect(latest!.components.total).toBe(score.total);
    // A second computation appends history.
    await q((tx) => computeAndStoreScore(tx, orgId, productId));
    expect(await q((tx) => tx.select().from(beaconScores).where(eq(beaconScores.productId, productId)))).toHaveLength(2);
  });

  it("an unknown product cannot be scored", async () => {
    await expect(q((tx) => computeAndStoreScore(tx, orgId, "00000000-0000-4000-8000-000000000000"))).rejects.toThrow("Product not found");
  });
});
