import { z } from "zod";
import type { Tx } from "@/db";
import { aiRuns } from "@/db/schema";
import { factCheck, type FactCheckOptions } from "@/core/content/fact-check";
import { CONTENT_RULES_VERSION, type Draft, type DraftRequest } from "@/core/content/generate";
import { guardRewrite, type GuardResult } from "@/core/content/rewrite-guard";
import { graphFacts } from "@/core/knowledge/facts";
import type { ProductGraph } from "@/core/knowledge/types";
import { recommendProducts, type RecommendationResult } from "@/core/sales/recommend";
import { analyzeAiResponse, type EntityRef, type ResponseAnalysis } from "@/core/visibility/ai-response";
import { generateOpportunities, type OpportunitySignals, type OpportunityDraft } from "@/core/opportunities/engine";
import { sha256 } from "@/lib/security/crypto";
import { stripLongDashes } from "@/core/util/text";
import { log } from "@/lib/logger";
import type { LlmProvider } from "./types";

/** Versioned prompts/rule-sets. Bump when behaviour changes so outputs stay traceable. */
export const PROMPT_VERSIONS = {
  generateContent: CONTENT_RULES_VERSION,
  rewriteContent: "content-rewrite-v3",
  factCheckDraft: "factcheck-v2",
  classifyIntent: "intent-rules-v1",
  analyzeVisibility: "ai-visibility-parse-v2",
  generateOpportunity: "opportunity-rules-v1",
  recommendProduct: "recommend-rules-v1",
} as const;

export type RunMeta = { organizationId: string; task: keyof typeof PROMPT_VERSIONS; provider: string; model: string; input: unknown; output: unknown; confidence?: number | null; sources?: string[]; latencyMs: number; status: "SUCCEEDED" | "FAILED"; error?: string };

/** Provenance record for every important AI/engine output (prompt version, provider, model, timestamp, confidence, sources). */
export async function recordRun(tx: Tx, m: RunMeta): Promise<string> {
  const [row] = await tx
    .insert(aiRuns)
    .values({
      organizationId: m.organizationId,
      task: m.task,
      provider: m.provider,
      model: m.model,
      promptVersion: PROMPT_VERSIONS[m.task],
      inputHash: sha256(JSON.stringify(m.input ?? null)),
      output: m.output as object,
      confidence: m.confidence ?? null,
      sources: m.sources ?? [],
      latencyMs: m.latencyMs,
      status: m.status,
      error: m.error,
    })
    .returning({ id: aiRuns.id });
  return row.id;
}

const RewriteSchema = z.object({
  title: z.string(),
  metaTitle: z.string(),
  metaDescription: z.string(),
  body: z.string().describe("Markdown. Must keep every '## Sources' URL and every '> TODO(editor):' line."),
});

const REWRITE_SYSTEM = `You are an editor for a software company's public product content.
Rewrite the draft for clarity and flow for the stated format.
Hard rules:
- Use ONLY the facts provided. Do not add customers, testimonials, statistics, integrations, awards, reviews, prices or claims about competitors that are not in the facts.
- Keep every URL in the Sources section, every line starting with "> TODO(editor):" and every "{cta:...}" marker unchanged.
- Keep markdown structure: one H1, H2 sections, lists where helpful. No superlatives such as "best" or "#1".
- Prefer concise, citation-friendly sentences that an answer engine could quote.
- Never use em dashes (\u2014) or en dashes (\u2013); use commas, colons, parentheses or full stops instead. Write ranges as "1 to 5".`;

export type GenerationResult = { draft: Draft; run: RunMeta; generatedBy: string; guard?: GuardResult };

/** Provenance of a deterministic, fact-grounded draft (no LLM involved). */
export function templateGeneration(organizationId: string, req: DraftRequest, draft: Draft, t0 = Date.now()): GenerationResult {
  return {
    draft,
    generatedBy: "beacon-rules",
    run: { organizationId, task: "generateContent", provider: "beacon-rules", model: "deterministic", input: req, output: { title: draft.title, factRefs: draft.factRefs.length }, confidence: 1, sources: draft.factRefs.map((f) => f.sourceUrl).filter((u): u is string => Boolean(u)), latencyMs: Date.now() - t0, status: "SUCCEEDED" },
  };
}

/**
 * Optional LLM rewrite of a deterministic draft, constrained to the VERIFIED
 * facts. Performs network I/O: never call it inside a database transaction
 * (the content.generate job reads in one transaction, calls this with no
 * transaction open, then persists in a second one). The rewrite is kept only
 * when `guardRewrite` accepts it: no editor TODO line, Sources URL or CTA
 * marker removed, no new unsupported claim, no higher NEEDS_REVIEW,
 * UNSUPPORTED or HIGH count than the template.
 */
export async function rewriteDraft(llm: LlmProvider, organizationId: string, g: ProductGraph, req: DraftRequest, draft: Draft, checkOpts: Omit<FactCheckOptions, "metaTitle" | "metaDescription"> = {}): Promise<GenerationResult> {
  if (!llm.generateObject) return templateGeneration(organizationId, req, draft);
  const t0 = Date.now();
  const facts = graphFacts(g, { verifiedOnly: true }).map((f) => ({ ref: f.ref, text: f.text, source: f.sourceUrl ?? null }));
  const prompt = `FORMAT: ${req.type}${req.targetQuery ? `\nTARGET QUERY: ${req.targetQuery}` : ""}\n\nFACTS (the only allowed source of claims):\n${JSON.stringify(facts, null, 1)}\n\nDRAFT:\n${draft.body}`;
  try {
    const out = await llm.generateObject({ system: REWRITE_SYSTEM, prompt, schema: RewriteSchema });
    // The model is told not to use long dashes; strip any that slip through before storing.
    const rewritten: Draft = { ...draft, title: stripLongDashes(out.title) || draft.title, metaTitle: stripLongDashes(out.metaTitle) || draft.metaTitle, metaDescription: stripLongDashes(out.metaDescription) || draft.metaDescription, body: stripLongDashes(out.body) };
    const before = factCheckDraft(draft.body, g, { ...checkOpts, metaTitle: draft.metaTitle, metaDescription: draft.metaDescription });
    const after = factCheckDraft(rewritten.body, g, { ...checkOpts, metaTitle: rewritten.metaTitle, metaDescription: rewritten.metaDescription });
    const guard = guardRewrite(draft, rewritten, before, after);
    const run: RunMeta = { organizationId, task: "rewriteContent", provider: llm.id, model: llm.model, input: { req, draftHash: sha256(draft.body) }, output: { kept: guard.ok, title: rewritten.title, rejectedBecause: guard.reasons }, confidence: guard.ok ? 0.8 : 0.3, latencyMs: Date.now() - t0, status: "SUCCEEDED" };
    return { draft: guard.ok ? rewritten : draft, run, guard, generatedBy: guard.ok ? `${llm.id}:${llm.model}` : "beacon-rules (LLM rewrite rejected by the rewrite guard)" };
  } catch (e) {
    log.warn("ai.rewrite_failed", { err: e });
    return { draft, generatedBy: "beacon-rules (LLM unavailable)", run: { organizationId, task: "rewriteContent", provider: llm.id, model: llm.model, input: req, output: null, latencyMs: Date.now() - t0, status: "FAILED", error: (e as Error).message } };
  }
}

/** Fact check of a draft against the knowledge graph (VERIFIED facts only, competitors from the graph). */
export function factCheckDraft(body: string, g: ProductGraph, opts: FactCheckOptions = {}) {
  return factCheck(body, g, { competitorNames: g.competitors.map((c) => c.competitor.name), ...opts });
}

export function analyzeVisibility(response: string, citations: string[], products: EntityRef[], competitors: EntityRef[], orgNames: string[]): ResponseAnalysis {
  return analyzeAiResponse(response, citations, products, competitors, orgNames);
}

export function generateOpportunity(signals: OpportunitySignals): OpportunityDraft[] {
  return generateOpportunities(signals);
}

export function recommendProduct(need: string, graphs: ProductGraph[], complementaryPairs?: Set<string>): RecommendationResult {
  return recommendProducts(need, graphs, { complementaryPairs });
}
