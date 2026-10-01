import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { asSystem, closeDb, withOrg } from "@/db";
import { aiVisibilityPrompts, products, queries, queryClusters } from "@/db/schema";
import { DEMO_CLUSTER, DEMO_PROMPT_CATEGORY, DEMO_PROMPTS, DEMO_QUERIES, DEMO_QUERY_NOTE, seedDemo } from "@/db/fixtures/demo";
import { newOrg } from "./helpers";

let orgId: string;
beforeAll(async () => {
  orgId = (await newOrg("demo")).org.id;
});
afterAll(closeDb);

describe("demo fixture (pnpm db:seed:demo)", () => {
  it("creates only reviewable, demo-labelled content and is idempotent", async () => {
    const first = await asSystem((tx) => seedDemo(tx, orgId));
    const expectedQueries = Object.values(DEMO_QUERIES).flat().length;
    expect(first.queriesCreated).toBe(expectedQueries);
    expect(first.promptsCreated).toBe(DEMO_PROMPTS.length);

    const [qs, prompts, prods] = await withOrg(orgId, async (tx) => [
      await tx.select().from(queries).where(eq(queries.organizationId, orgId)),
      await tx.select().from(aiVisibilityPrompts).where(eq(aiVisibilityPrompts.organizationId, orgId)),
      await tx.select().from(products).where(eq(products.organizationId, orgId)),
    ] as const);
    expect(qs).toHaveLength(expectedQueries);
    for (const q of qs) {
      expect(q.status).toBe("CANDIDATE");
      expect(q.notes).toBe(DEMO_QUERY_NOTE);
    }
    expect(prompts).toHaveLength(DEMO_PROMPTS.length);
    for (const p of prompts) expect(p).toMatchObject({ active: false, category: DEMO_PROMPT_CATEGORY });
    // Product names only: no facts, nothing verified.
    for (const p of prods) expect(p).toMatchObject({ status: "UNKNOWN", domain: null, shortDescription: null, lastVerifiedAt: null });
    const clusterNames = await withOrg(orgId, (tx) => tx.query.queryClusters.findMany({ where: eq(queryClusters.organizationId, orgId), columns: { name: true } }));
    expect(new Set(clusterNames.map((c) => c.name))).toEqual(new Set([DEMO_CLUSTER]));

    const again = await asSystem((tx) => seedDemo(tx, orgId));
    expect(again).toEqual({ productsCreated: [], queriesCreated: 0, promptsCreated: 0 });
  });
});
