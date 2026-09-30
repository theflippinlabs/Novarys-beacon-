import { and, desc, eq, gte, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { aiMentions, aiVisibilityPrompts, aiVisibilityTests, competitors, organizations, products } from "@/db/schema";
import { analyzeVisibility, recordRun } from "@/ai/tasks";
import type { LlmProvider } from "@/ai/types";

/**
 * Run one prompt against each configured provider and store the result as a
 * SAMPLED OBSERVATION. A single API response does not represent what every
 * user sees in a consumer AI app; the UI labels it accordingly.
 */
export async function runPromptTests(run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>, organizationId: string, promptId: string, providers: LlmProvider[]) {
  const ctx = await run(async (tx) => {
    const prompt = await tx.query.aiVisibilityPrompts.findFirst({ where: and(eq(aiVisibilityPrompts.id, promptId), eq(aiVisibilityPrompts.organizationId, organizationId)) });
    const prods = await tx.select().from(products).where(eq(products.organizationId, organizationId));
    const comps = await tx.select().from(competitors).where(eq(competitors.organizationId, organizationId));
    const org = await tx.query.organizations.findFirst({ where: eq(organizations.id, organizationId) });
    return { prompt, prods, comps, org };
  });
  if (!ctx.prompt) throw new Error("Prompt not found");
  const results: { provider: string; ok: boolean; mentioned?: boolean; error?: string }[] = [];
  for (const p of providers) {
    const t0 = Date.now();
    try {
      const { text, citations } = await p.answer(ctx.prompt.prompt);
      const a = analyzeVisibility(
        text,
        citations,
        ctx.prods.map((x) => ({ id: x.id, name: x.name, domain: x.domain })),
        ctx.comps.map((c) => ({ id: c.id, name: c.name, domain: c.domain })),
        [ctx.org?.name ?? ""].filter(Boolean),
      );
      await run(async (tx) => {
        const [test] = await tx
          .insert(aiVisibilityTests)
          .values({
            organizationId,
            promptId,
            provider: p.id,
            model: p.model,
            response: text.slice(0, 50_000),
            productsMentioned: a.productsMentioned,
            competitorsMentioned: a.competitorsMentioned,
            citations: a.citations.slice(0, 100),
            ownDomainCited: a.ownDomainCited,
            orgMentioned: a.orgMentioned,
            position: a.position,
          })
          .returning();
        for (const m of a.productsMentioned) await tx.insert(aiMentions).values({ organizationId, productId: m.productId, testId: test.id, engine: `${p.id}:${p.model}`, source: "SAMPLED_TEST", context: ctx.prompt!.prompt });
        await recordRun(tx, { organizationId, task: "analyzeVisibility", provider: p.id, model: p.model, input: { promptId }, output: { mentioned: a.orgMentioned, position: a.position, citations: a.citations.length }, confidence: 1, sources: a.citations.slice(0, 20), latencyMs: Date.now() - t0, status: "SUCCEEDED" });
      });
      results.push({ provider: p.id, ok: true, mentioned: a.orgMentioned });
    } catch (e) {
      results.push({ provider: p.id, ok: false, error: (e as Error).message });
    }
  }
  if (results.length && results.every((r) => !r.ok)) throw new Error(`All providers failed: ${results.map((r) => `${r.provider}: ${r.error}`).join("; ")}`);
  return results;
}

/** Weekly share of sampled tests that mentioned the organisation. */
export async function aiVisibilityTrend(tx: Tx, organizationId: string, weeks = 12, productId?: string) {
  const r = await tx.execute<{ week: string; tests: number; mentioned: number; cited: number }>(sql`
    select to_char(date_trunc('week', t.ran_at), 'YYYY-MM-DD') as week, count(*)::int as tests,
      count(*) filter (where ${productId ? sql`t.products_mentioned @> ${JSON.stringify([{ productId }])}::jsonb` : sql`t.org_mentioned`})::int as mentioned,
      count(*) filter (where t.own_domain_cited)::int as cited
    from ai_visibility_tests t
    ${productId ? sql`join ai_visibility_prompts p on p.id = t.prompt_id` : sql``}
    where t.organization_id = ${organizationId} and t.ran_at >= now() - make_interval(weeks => ${weeks})
    group by 1 order by 1`);
  return r.rows.map((x) => ({ week: x.week, tests: Number(x.tests), mentioned: Number(x.mentioned), cited: Number(x.cited) }));
}

export async function promptSummaries(tx: Tx, organizationId: string, productId?: string) {
  const prompts = await tx
    .select()
    .from(aiVisibilityPrompts)
    .where(and(eq(aiVisibilityPrompts.organizationId, organizationId), productId ? eq(aiVisibilityPrompts.productId, productId) : undefined))
    .orderBy(desc(aiVisibilityPrompts.createdAt));
  const tests = await tx
    .select()
    .from(aiVisibilityTests)
    .where(and(eq(aiVisibilityTests.organizationId, organizationId), gte(aiVisibilityTests.ranAt, new Date(Date.now() - 90 * 86_400_000))))
    .orderBy(desc(aiVisibilityTests.ranAt));
  return prompts.map((p) => {
    const ts = tests.filter((t) => t.promptId === p.id);
    const compNames = [...new Set(ts.flatMap((t) => t.competitorsMentioned.map((c) => c.name)))];
    return {
      prompt: p,
      testsRun: ts.length,
      mentions: productId ? ts.filter((t) => t.productsMentioned.some((m) => m.productId === productId)).length : ts.filter((t) => t.orgMentioned).length,
      cited: ts.filter((t) => t.ownDomainCited).length,
      competitors: compNames,
      last: ts[0] ?? null,
    };
  });
}
