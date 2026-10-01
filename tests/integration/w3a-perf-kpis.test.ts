import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { closeDb, withOrg, type Tx } from "@/db";
import { aiCitations, aiVisibilityPrompts, aiVisibilityTests, crossSellEvents, crossSellRules, identities, identityProducts, products } from "@/db/schema";
import { promptSummaries } from "@/services/ai-visibility";
import { kpis } from "@/services/metrics";
import { newOrg, uid } from "./helpers";

/** The previous implementation (full rows for 90 days, filtered per prompt in JS), kept as the reference. */
async function legacyPromptSummaries(tx: Tx, organizationId: string, productId?: string) {
  const prompts = await tx
    .select()
    .from(aiVisibilityPrompts)
    .where(and(eq(aiVisibilityPrompts.organizationId, organizationId), productId ? eq(aiVisibilityPrompts.productId, productId) : undefined))
    .orderBy(desc(aiVisibilityPrompts.createdAt));
  const tests = prompts.length
    ? await tx
        .select()
        .from(aiVisibilityTests)
        .where(and(eq(aiVisibilityTests.organizationId, organizationId), inArray(aiVisibilityTests.promptId, prompts.map((p) => p.id)), gte(aiVisibilityTests.ranAt, new Date(Date.now() - 90 * 86_400_000))))
        .orderBy(desc(aiVisibilityTests.ranAt))
    : [];
  const compCites = tests.length
    ? await tx
        .select({ testId: aiCitations.testId, url: aiCitations.url })
        .from(aiCitations)
        .where(and(eq(aiCitations.organizationId, organizationId), eq(aiCitations.kind, "COMPETITOR"), inArray(aiCitations.testId, tests.map((t) => t.id))))
    : [];
  return prompts.map((p) => {
    const ts = tests.filter((t) => t.promptId === p.id);
    const ids = new Set(ts.map((t) => t.id));
    const compNames = [...new Set(ts.flatMap((t) => t.competitorsMentioned.map((c) => c.name)))];
    return {
      prompt: p,
      testsRun: ts.length,
      testIds: ts.map((t) => t.id),
      mentions: productId ? ts.filter((t) => t.productsMentioned.some((m) => m.productId === productId)).length : ts.filter((t) => t.orgMentioned).length,
      cited: ts.filter((t) => t.ownDomainCited).length,
      grounded: ts.filter((t) => t.grounded).length,
      competitors: compNames,
      competitorCitedUrls: [...new Set(compCites.filter((c) => ids.has(c.testId)).map((c) => c.url))],
      last: ts[0] ?? null,
    };
  });
}

/** The legacy query had no ORDER BY for citations: compare that field as a set. */
const normalise = (rows: Awaited<ReturnType<typeof promptSummaries>>) => rows.map((r) => ({ ...r, competitorCitedUrls: [...r.competitorCitedUrls].sort() }));

let orgId: string;
let productA: string;
let productB: string;
const run = <T,>(fn: (tx: Tx) => Promise<T>) => withOrg(orgId, fn);

beforeAll(async () => {
  orgId = (await newOrg("w3a-perf")).org.id;
  const [a, b] = await run((tx) =>
    tx
      .insert(products)
      .values([
        { organizationId: orgId, name: "Alpha", slug: `alpha-${uid()}` },
        { organizationId: orgId, name: "Bravo", slug: `bravo-${uid()}` },
      ])
      .returning(),
  );
  productA = a.id;
  productB = b.id;
  const prompts = await run((tx) =>
    tx
      .insert(aiVisibilityPrompts)
      .values([
        { organizationId: orgId, productId: productA, prompt: "alpha one", createdAt: new Date(Date.now() - 5000) },
        { organizationId: orgId, productId: productA, prompt: "alpha two", createdAt: new Date(Date.now() - 4000) },
        { organizationId: orgId, productId: productB, prompt: "bravo one", createdAt: new Date(Date.now() - 3000) },
        { organizationId: orgId, productId: null, prompt: "ecosystem", createdAt: new Date(Date.now() - 2000) },
        { organizationId: orgId, productId: productA, prompt: "never run", createdAt: new Date(Date.now() - 1000) },
      ])
      .returning(),
  );
  const comp = (name: string) => ({ competitorId: randomUUID(), name, position: 1 });
  const mention = (productId: string) => ({ productId, name: "x", position: 1 });
  const day = 86_400_000;
  // Varied runs per prompt (distinct timestamps), one outside the 90-day window.
  const spec: { p: number; ago: number; prods: string[]; comps: string[]; org: boolean; own: boolean; grounded: boolean; cites: string[] }[] = [
    { p: 0, ago: 1, prods: [productA], comps: ["ModBot", "Rival"], org: true, own: true, grounded: true, cites: ["https://modbot.example/a", "https://rival.example/"] },
    { p: 0, ago: 2, prods: [], comps: ["Rival", "Third"], org: false, own: false, grounded: false, cites: ["https://modbot.example/a"] },
    { p: 0, ago: 3, prods: [productA, productB], comps: [], org: true, own: false, grounded: true, cites: ["https://third.example/x"] },
    { p: 0, ago: 120, prods: [productA], comps: ["Ancient"], org: true, own: true, grounded: true, cites: ["https://old.example/"] },
    { p: 1, ago: 4, prods: [productB], comps: ["Zed", "ModBot", "Zed"], org: true, own: true, grounded: false, cites: [] },
    { p: 1, ago: 10, prods: [], comps: [], org: false, own: false, grounded: false, cites: ["https://zed.example/"] },
    { p: 2, ago: 5, prods: [productB], comps: ["ModBot"], org: true, own: false, grounded: true, cites: ["https://modbot.example/b"] },
    { p: 3, ago: 6, prods: [productA], comps: ["Eco"], org: true, own: true, grounded: true, cites: [] },
  ];
  await run(async (tx) => {
    for (const s of spec) {
      const [t] = await tx
        .insert(aiVisibilityTests)
        .values({
          organizationId: orgId,
          promptId: prompts[s.p].id,
          provider: "anthropic",
          model: "m",
          ranAt: new Date(Date.now() - s.ago * day),
          response: `long response ${"x".repeat(2000)}`,
          productsMentioned: s.prods.map(mention),
          competitorsMentioned: s.comps.map(comp),
          orgMentioned: s.org,
          ownDomainCited: s.own,
          grounded: s.grounded,
        })
        .returning();
      let position = 1;
      for (const url of s.cites) {
        const host = new URL(url).host;
        await tx.insert(aiCitations).values({ organizationId: orgId, testId: t.id, promptId: prompts[s.p].id, url, host, registrableDomain: host, kind: "COMPETITOR", category: "OTHER", position: position++ });
      }
      // A non-competitor citation never counts.
      await tx.insert(aiCitations).values({ organizationId: orgId, testId: t.id, promptId: prompts[s.p].id, url: "https://own.example/", host: "own.example", registrableDomain: "own.example", kind: "OWN", category: "OTHER", position: position++ });
    }
  });
});
afterAll(closeDb);

describe("promptSummaries (SQL aggregate) matches the previous implementation", () => {
  it("for the whole organisation", async () => {
    const [now, before] = await run(async (tx) => [await promptSummaries(tx, orgId), await legacyPromptSummaries(tx, orgId)] as const);
    expect(now).toHaveLength(5);
    expect(normalise(now)).toEqual(normalise(before));
    const alphaOne = now.find((s) => s.prompt.prompt === "alpha one")!;
    expect(alphaOne).toMatchObject({ testsRun: 3, mentions: 2, cited: 1, grounded: 2, competitors: ["ModBot", "Rival", "Third"] });
    expect(alphaOne.last?.response).toContain("long response");
    expect(now.find((s) => s.prompt.prompt === "never run")).toMatchObject({ testsRun: 0, testIds: [], competitors: [], competitorCitedUrls: [], last: null });
  });

  it("scoped to a product (mentions count that product only)", async () => {
    for (const pid of [productA, productB]) {
      const [now, before] = await run(async (tx) => [await promptSummaries(tx, orgId, pid), await legacyPromptSummaries(tx, orgId, pid)] as const);
      expect(normalise(now)).toEqual(normalise(before));
    }
    const a = await run((tx) => promptSummaries(tx, orgId, productA));
    expect(a.map((s) => s.prompt.prompt).sort()).toEqual(["alpha one", "alpha two", "never run"]);
    expect(a.find((s) => s.prompt.prompt === "alpha two")).toMatchObject({ testsRun: 2, mentions: 0, competitors: ["Zed", "ModBot"], competitorCitedUrls: ["https://zed.example/"] });
  });
});

describe("kpis: cross-sell KPIs are scoped to the product", () => {
  it("counts only events of rules whose source or destination is the product", async () => {
    const org = (await newOrg("w3a-eco")).org.id;
    const q = <T,>(fn: (tx: Tx) => Promise<T>) => withOrg(org, fn);
    const [a, b, c, d] = await q((tx) =>
      tx
        .insert(products)
        .values(["A", "B", "C", "D"].map((n) => ({ organizationId: org, name: `Eco ${n}`, slug: `eco-${n.toLowerCase()}-${uid()}` })))
        .returning(),
    );
    const rule = (src: string, dst: string, name: string) => ({ organizationId: org, sourceProductId: src, destinationProductId: dst, name, message: "Try it", ctaUrl: "https://dest.example/" });
    const [r1, r2] = await q((tx) => tx.insert(crossSellRules).values([rule(a.id, b.id, "A to B"), rule(c.id, b.id, "C to B")]).returning());
    const [i1, i2, i3] = await q((tx) =>
      tx
        .insert(identities)
        .values(["eco-1", "eco-2", "eco-3"].map((ref) => ({ organizationId: org, externalRef: `${ref}-${uid()}` })))
        .returning(),
    );
    await q((tx) =>
      tx.insert(identityProducts).values([
        { organizationId: org, identityId: i1.id, productId: a.id, status: "ACTIVE" },
        { organizationId: org, identityId: i1.id, productId: b.id, status: "ACTIVE" },
        { organizationId: org, identityId: i2.id, productId: b.id, status: "TRIALING" },
        { organizationId: org, identityId: i2.id, productId: c.id, status: "ACTIVE" },
        { organizationId: org, identityId: i3.id, productId: c.id, status: "ACTIVE" },
      ]),
    );
    const ev = (ruleId: string, type: "IMPRESSION" | "CONVERSION", n: number) => Array.from({ length: n }, () => ({ organizationId: org, ruleId, identityId: i1.id, type, occurredAt: new Date(Date.now() - 86_400_000) }));
    await q((tx) => tx.insert(crossSellEvents).values([...ev(r1.id, "IMPRESSION", 4), ...ev(r1.id, "CONVERSION", 2), ...ev(r2.id, "IMPRESSION", 2)]));

    const k = async (productId?: string) => (await q((tx) => kpis(tx, org, { days: 30, productId }))).ecosystem;
    expect((await k()).crossSellRate.now).toBeCloseTo(2 / 6);
    expect((await k()).multiProductUsers.now).toBe(2);
    expect((await k(a.id)).crossSellRate.now).toBeCloseTo(2 / 4);
    expect((await k(a.id)).multiProductUsers.now).toBe(1);
    expect((await k(c.id)).crossSellRate.now).toBe(0);
    expect((await k(c.id)).multiProductUsers.now).toBe(1);
    expect((await k(b.id)).crossSellRate.now).toBeCloseTo(2 / 6);
    expect((await k(b.id)).multiProductUsers.now).toBe(2);
    // No rule touches D: not connected rather than a borrowed organisation-wide rate.
    const dk = await k(d.id);
    expect(dk.crossSellRate.now).toBeNull();
    expect(dk.crossSellRate.state).not.toBe("OK");
    expect(dk.multiProductUsers.now).toBe(0);
  });
});
