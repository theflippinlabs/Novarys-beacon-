import { and, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { aiCitations, aiMentions, aiVisibilityPrompts, aiVisibilityTests, competitors, organizations, productCompetitors, products, queryClusters, queries } from "@/db/schema";
import { analyzeVisibility, recordRun } from "@/ai/tasks";
import type { LlmProvider } from "@/ai/types";
import { citationOffsets, classifyCitation, entitiesNear } from "@/core/visibility/citations";
import { promptMatchesCluster } from "@/core/content/gaps";
import { audit, type Actor } from "@/lib/audit";

/**
 * Run one prompt against each configured provider and store the result as a
 * SAMPLED OBSERVATION. A single API response does not represent what every
 * user sees in a consumer AI app; the UI labels it accordingly.
 *
 * Per test: the exact prompt text sent (snapshot), the configured and the
 * served model, whether the answer was web-grounded, request parameters,
 * locale, full response and citations (with titles and offsets when the
 * provider annotates them). Per mention: entity, offset and a snippet of
 * about 200 characters. Each citation is classified into ai_citations.
 * Network I/O happens outside database transactions.
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
  const prompt = ctx.prompt;
  const results: { provider: string; ok: boolean; mentioned?: boolean; error?: string }[] = [];
  for (const p of providers) {
    const t0 = Date.now();
    try {
      const ans = await p.answer(prompt.prompt);
      const text = ans.text;
      const a = analyzeVisibility(
        text,
        ans.citations,
        ctx.prods.map((x) => ({ id: x.id, name: x.name, domain: x.domain })),
        ctx.comps.map((c) => ({ id: c.id, name: c.name, domain: c.domain, aliases: c.aliases })),
        [ctx.org?.name ?? ""].filter(Boolean),
      );
      const known = new Map((ans.citationDetails ?? []).map((d) => [d.url, d]));
      const productOffsets = a.productsMentioned.map((m) => ({ id: m.productId, offsets: m.offsets }));
      const competitorOffsets = a.competitorsMentioned.map((m) => ({ id: m.competitorId, offsets: m.offsets }));
      const cited = a.citations.slice(0, 100).flatMap((url, i) => {
        const c = classifyCitation(url, { products: ctx.prods, competitors: ctx.comps });
        if (!c) return [];
        const offsets = citationOffsets(text, url, i + 1, known.get(url)?.offsets ?? []);
        return [{ ...c, position: i + 1, title: known.get(url)?.title ?? null, offsets, nearProductIds: entitiesNear(offsets, productOffsets), nearCompetitorIds: entitiesNear(offsets, competitorOffsets) }];
      });
      await run(async (tx) => {
        const [test] = await tx
          .insert(aiVisibilityTests)
          .values({
            organizationId,
            promptId,
            provider: p.id,
            model: p.model,
            servedModel: ans.servedModel ?? null,
            promptText: prompt.prompt,
            grounded: ans.grounded ?? false,
            params: ans.params ?? {},
            locale: prompt.locale,
            response: text.slice(0, 50_000),
            productsMentioned: a.productsMentioned.map(({ productId, name, position, offset, snippet }) => ({ productId, name, position, offset: offset ?? undefined, snippet: snippet ?? undefined })),
            competitorsMentioned: a.competitorsMentioned.map(({ competitorId, name, position, offset, snippet }) => ({ competitorId, name, position, offset: offset ?? undefined, snippet: snippet ?? undefined })),
            citations: a.citations.slice(0, 100),
            citationDetails: cited.map((c) => ({ url: c.url, title: c.title, offsets: c.offsets.slice(0, 20) })),
            ownDomainCited: a.ownDomainCited,
            orgMentioned: a.orgMentioned,
            position: a.position,
          })
          .returning();
        if (a.productsMentioned.length)
          await tx.insert(aiMentions).values(
            a.productsMentioned.map((m) => ({ organizationId, productId: m.productId, testId: test.id, engine: `${p.id}:${ans.servedModel ?? p.model}`, source: "SAMPLED_TEST", context: m.snippet, snippet: m.snippet, mentionOffset: m.offset })),
          );
        if (cited.length)
          await tx.insert(aiCitations).values(
            cited.map((c) => ({
              organizationId,
              testId: test.id,
              promptId,
              productId: prompt.productId,
              competitorId: c.competitorId,
              url: c.url,
              host: c.host,
              registrableDomain: c.registrableDomain,
              kind: c.kind,
              category: c.category,
              position: c.position,
              title: c.title,
              nearProductIds: c.nearProductIds,
              nearCompetitorIds: c.nearCompetitorIds,
              observedAt: test.ranAt,
            })),
          );
        await recordRun(tx, {
          organizationId,
          task: "analyzeVisibility",
          provider: p.id,
          model: ans.servedModel ?? p.model,
          input: { promptId, promptText: prompt.prompt, grounded: ans.grounded ?? false },
          output: { mentioned: a.orgMentioned, firstAppearance: a.position, citations: a.citations.length },
          confidence: 1,
          sources: a.citations.slice(0, 20),
          latencyMs: Date.now() - t0,
          status: "SUCCEEDED",
        });
      });
      results.push({ provider: p.id, ok: true, mentioned: a.orgMentioned });
    } catch (e) {
      results.push({ provider: p.id, ok: false, error: (e as Error).message });
    }
  }
  if (results.length && results.every((r) => !r.ok)) throw new Error(`All providers failed: ${results.map((r) => `${r.provider}: ${r.error}`).join("; ")}`);
  return results;
}

/**
 * Weekly sampled tests, tests mentioning the organisation (or the product)
 * and tests citing an own domain. With a product, only tests of that
 * product's prompts are counted.
 */
export async function aiVisibilityTrend(tx: Tx, organizationId: string, weeks = 12, productId?: string) {
  const r = await tx.execute<{ week: string; tests: number; mentioned: number; cited: number }>(sql`
    select to_char(date_trunc('week', t.ran_at), 'YYYY-MM-DD') as week, count(*)::int as tests,
      count(*) filter (where ${productId ? sql`t.products_mentioned @> ${JSON.stringify([{ productId }])}::jsonb` : sql`t.org_mentioned`})::int as mentioned,
      count(*) filter (where t.own_domain_cited)::int as cited
    from ai_visibility_tests t
    ${productId ? sql`join ai_visibility_prompts p on p.id = t.prompt_id and p.product_id = ${productId}` : sql``}
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

/** One sampled run with its prompt, entities and classified citations. */
export async function testDetail(tx: Tx, organizationId: string, testId: string) {
  const test = await tx.query.aiVisibilityTests.findFirst({ where: and(eq(aiVisibilityTests.id, testId), eq(aiVisibilityTests.organizationId, organizationId)) });
  if (!test) return null;
  const prompt = await tx.query.aiVisibilityPrompts.findFirst({ where: and(eq(aiVisibilityPrompts.id, test.promptId), eq(aiVisibilityPrompts.organizationId, organizationId)) });
  const cites = await tx.select().from(aiCitations).where(and(eq(aiCitations.organizationId, organizationId), eq(aiCitations.testId, testId))).orderBy(aiCitations.position);
  const product = prompt?.productId ? await tx.query.products.findFirst({ where: and(eq(products.id, prompt.productId), eq(products.organizationId, organizationId)) }) : null;
  return { test, prompt, product, citations: cites };
}

export type CitationDomainRow = {
  domain: string;
  kind: "OWN" | "COMPETITOR" | "THIRD_PARTY";
  category: string;
  samplesCiting: number;
  samplesTotal: number;
  testIds: string[];
  urls: string[];
  products: string[];
  prompts: string[];
  productAppears: boolean;
  competitors: string[];
};

/**
 * Citation sources per registrable domain since a date: in how many of the
 * sampled responses the domain was cited, which products and prompts it was
 * cited for, whether the product appears on it (own domain, or the product
 * is mentioned near the citation in the answer) and which competitors are
 * associated (competitor domain, or mentioned near the citation).
 */
export async function citationDomains(tx: Tx, organizationId: string, opts: { productId?: string; since?: Date } = {}): Promise<CitationDomainRow[]> {
  const since = opts.since ?? new Date(Date.now() - 90 * 86_400_000);
  const total = await tx.execute<{ n: number }>(sql`
    select count(*)::int as n from ai_visibility_tests t
    ${opts.productId ? sql`join ai_visibility_prompts p on p.id = t.prompt_id and p.product_id = ${opts.productId}` : sql``}
    where t.organization_id = ${organizationId} and t.ran_at >= ${since}`);
  const samplesTotal = Number(total.rows[0]?.n ?? 0);
  if (!samplesTotal) return [];
  const rows = await tx
    .select({ c: aiCitations, prompt: aiVisibilityPrompts.prompt, productName: products.name })
    .from(aiCitations)
    .leftJoin(aiVisibilityPrompts, eq(aiVisibilityPrompts.id, aiCitations.promptId))
    .leftJoin(products, eq(products.id, aiCitations.productId))
    .where(and(eq(aiCitations.organizationId, organizationId), gte(aiCitations.observedAt, since), opts.productId ? eq(aiCitations.productId, opts.productId) : undefined));
  const comps = await tx.select({ id: competitors.id, name: competitors.name }).from(competitors).where(eq(competitors.organizationId, organizationId));
  const compName = new Map(comps.map((c) => [c.id, c.name]));
  const by = new Map<string, { rows: typeof rows }>();
  for (const r of rows) {
    const cur = by.get(r.c.registrableDomain) ?? { rows: [] };
    cur.rows.push(r);
    by.set(r.c.registrableDomain, cur);
  }
  const out: CitationDomainRow[] = [];
  for (const [domain, { rows: rs }] of by) {
    const cats = new Map<string, number>();
    for (const r of rs) cats.set(r.c.category, (cats.get(r.c.category) ?? 0) + 1);
    const category = [...cats.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
    const kind = rs.some((r) => r.c.kind === "OWN") ? "OWN" : rs.some((r) => r.c.kind === "COMPETITOR") ? "COMPETITOR" : "THIRD_PARTY";
    // An own domain is our own presence; otherwise the product must be mentioned near the citation.
    const productAppears = rs.some((r) => r.c.kind === "OWN" || (opts.productId ? r.c.nearProductIds.includes(opts.productId) : r.c.nearProductIds.length > 0));
    out.push({
      domain,
      kind,
      category,
      samplesCiting: new Set(rs.map((r) => r.c.testId)).size,
      samplesTotal,
      testIds: [...new Set(rs.map((r) => r.c.testId))],
      urls: [...new Set(rs.map((r) => r.c.url))].slice(0, 10),
      products: [...new Set(rs.map((r) => r.productName).filter((x): x is string => Boolean(x)))],
      prompts: [...new Set(rs.map((r) => r.prompt).filter((x): x is string => Boolean(x)))],
      productAppears,
      competitors: [...new Set(rs.flatMap((r) => [...(r.c.competitorId ? [r.c.competitorId] : []), ...r.c.nearCompetitorIds]).map((id) => compName.get(id)).filter((x): x is string => Boolean(x)))],
    });
  }
  return out.sort((a, b) => b.samplesCiting - a.samplesCiting || a.domain.localeCompare(b.domain));
}

export type CompetitorIntel = {
  competitor: { id: string; name: string; domain: string | null; aliases: string[] };
  samplesMentioning: number;
  samplesTotal: number;
  ownDomainCitedIn: number;
  citedDomains: { domain: string; samples: number }[];
  comparisonFacts: { productName: string; sourced: number }[];
  /** Prompts (and matching query clusters) where the competitor was observed and the product never was. */
  gaps: { promptId: string; prompt: string; samples: number; competitorSamples: number; clusters: string[] }[];
};

/**
 * Observed facts only: share of sampled responses that mention each
 * competitor, the domains cited near it, sourced comparison facts, and the
 * prompts and clusters where the competitor has discovery coverage that the
 * product (or the organisation, without a product) does not.
 */
export async function competitorIntel(tx: Tx, organizationId: string, opts: { productId?: string; since?: Date } = {}): Promise<CompetitorIntel[]> {
  const since = opts.since ?? new Date(Date.now() - 90 * 86_400_000);
  const comps = await tx.select().from(competitors).where(eq(competitors.organizationId, organizationId)).orderBy(competitors.name);
  if (!comps.length) return [];
  const tests = await tx
    .select({ t: aiVisibilityTests, prompt: aiVisibilityPrompts })
    .from(aiVisibilityTests)
    .innerJoin(aiVisibilityPrompts, eq(aiVisibilityPrompts.id, aiVisibilityTests.promptId))
    .where(and(eq(aiVisibilityTests.organizationId, organizationId), gte(aiVisibilityTests.ranAt, since), opts.productId ? eq(aiVisibilityPrompts.productId, opts.productId) : undefined));
  const cites = tests.length
    ? await tx.select().from(aiCitations).where(and(eq(aiCitations.organizationId, organizationId), inArray(aiCitations.testId, tests.map((x) => x.t.id))))
    : [];
  const links = await tx
    .select({ link: productCompetitors, productName: products.name })
    .from(productCompetitors)
    .innerJoin(products, eq(products.id, productCompetitors.productId))
    .where(and(eq(productCompetitors.organizationId, organizationId), opts.productId ? eq(productCompetitors.productId, opts.productId) : undefined));
  const clusterRows = await tx
    .select({ id: queryClusters.id, name: queryClusters.name, query: queries.query })
    .from(queryClusters)
    .innerJoin(queries, eq(queries.clusterId, queryClusters.id))
    .where(and(eq(queryClusters.organizationId, organizationId), opts.productId ? eq(queryClusters.productId, opts.productId) : undefined));
  const clusters = new Map<string, { name: string; queries: { query: string }[] }>();
  for (const r of clusterRows) {
    const c = clusters.get(r.id) ?? { name: r.name, queries: [] };
    c.queries.push({ query: r.query });
    clusters.set(r.id, c);
  }
  const ownMentioned = (t: (typeof tests)[number]["t"]) => (opts.productId ? t.productsMentioned.some((m) => m.productId === opts.productId) : t.orgMentioned);
  const byPrompt = new Map<string, (typeof tests)[number][]>();
  for (const x of tests) byPrompt.set(x.prompt.id, [...(byPrompt.get(x.prompt.id) ?? []), x]);
  return comps
    .map((c) => {
      const withComp = tests.filter((x) => x.t.competitorsMentioned.some((m) => m.competitorId === c.id));
      const domainSamples = new Map<string, Set<string>>();
      for (const ct of cites) if (ct.competitorId === c.id || ct.nearCompetitorIds.includes(c.id)) domainSamples.set(ct.registrableDomain, (domainSamples.get(ct.registrableDomain) ?? new Set()).add(ct.testId));
      const gaps = [...byPrompt.entries()].flatMap(([pid, xs]) => {
        const compN = xs.filter((x) => x.t.competitorsMentioned.some((m) => m.competitorId === c.id) || cites.some((ct) => ct.testId === x.t.id && ct.competitorId === c.id)).length;
        if (!compN || xs.some((x) => ownMentioned(x.t))) return [];
        const prompt = xs[0].prompt.prompt;
        return [{ promptId: pid, prompt, samples: xs.length, competitorSamples: compN, clusters: [...clusters.values()].filter((cl) => promptMatchesCluster(prompt, cl)).map((cl) => cl.name) }];
      });
      return {
        competitor: { id: c.id, name: c.name, domain: c.domain, aliases: c.aliases },
        samplesMentioning: withComp.length,
        samplesTotal: tests.length,
        ownDomainCitedIn: new Set(cites.filter((ct) => ct.competitorId === c.id).map((ct) => ct.testId)).size,
        citedDomains: [...domainSamples.entries()].map(([domain, s]) => ({ domain, samples: s.size })).sort((a, b) => b.samples - a.samples || a.domain.localeCompare(b.domain)).slice(0, 8),
        comparisonFacts: links.filter((l) => l.link.competitorId === c.id).map((l) => ({ productName: l.productName, sourced: l.link.comparisonFacts.filter((f) => f.sourceUrl).length })),
        gaps: gaps.sort((a, b) => b.competitorSamples - a.competitorSamples).slice(0, 10),
      };
    })
    // Without a product, every competitor is listed (so aliases can be edited); with one, linked or observed competitors.
    .filter((x) => !opts.productId || x.samplesMentioning > 0 || x.comparisonFacts.length > 0 || x.ownDomainCitedIn > 0);
}

/** Replace a competitor's aliases (trimmed, de-duplicated, at most 20) and audit the change. */
export async function setCompetitorAliases(tx: Tx, actor: Actor, competitorId: string, aliases: string[]) {
  const clean = [...new Set(aliases.map((a) => a.trim()).filter((a) => a.length >= 2 && a.length <= 80))].slice(0, 20);
  const [row] = await tx
    .update(competitors)
    .set({ aliases: clean })
    .where(and(eq(competitors.id, competitorId), eq(competitors.organizationId, actor.organizationId)))
    .returning({ id: competitors.id });
  if (!row) throw new Error("Competitor not found");
  await audit(tx, actor, "competitor.aliases", "competitor", competitorId, { aliases: clean });
  return clean;
}
