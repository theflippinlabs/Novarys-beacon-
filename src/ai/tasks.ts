import { z } from "zod";
import type { Tx } from "@/db";
import { aiRuns } from "@/db/schema";
import { factCheck } from "@/core/content/fact-check";
import { generateDraft, type Draft, type DraftRequest } from "@/core/content/generate";
import { graphFacts } from "@/core/content/fact-check";
import type { ProductGraph } from "@/core/knowledge/types";
import { classifyQuery, type Classification } from "@/core/queries/classify";
import { recommendProducts, type RecommendationResult } from "@/core/sales/recommend";
import { analyzeAiResponse, type EntityRef, type ResponseAnalysis } from "@/core/visibility/ai-response";
import { generateOpportunities, type OpportunitySignals, type OpportunityDraft } from "@/core/opportunities/engine";
import { sha256 } from "@/lib/security/crypto";
import { stripLongDashes } from "@/core/util/text";
import { log } from "@/lib/logger";
import type { LlmProvider } from "./types";

/** Versioned prompts/rule-sets. Bump when behaviour changes so outputs stay traceable. */
export const PROMPT_VERSIONS = {
  generateContent: "content-v1",
  rewriteContent: "content-rewrite-v2",
  factCheckDraft: "factcheck-v1",
  classifyIntent: "intent-rules-v1",
  analyzeVisibility: "ai-visibility-parse-v1",
  generateOpportunity: "opportunity-rules-v1",
  recommendProduct: "recommend-rules-v1",
} as const;

type RunMeta = { organizationId: string; task: keyof typeof PROMPT_VERSIONS; provider: string; model: string; input: unknown; output: unknown; confidence?: number | null; sources?: string[]; latencyMs: number; status: "SUCCEEDED" | "FAILED"; error?: string };

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
- Keep every URL in the Sources section and every line starting with "> TODO(editor):" unchanged.
- Keep markdown structure: one H1, H2 sections, lists where helpful. No superlatives such as "best" or "#1".
- Prefer concise, citation-friendly sentences that an answer engine could quote.
- Never use em dashes (\u2014) or en dashes (\u2013); use commas, colons, parentheses or full stops instead. Write ranges as "1 to 5".`;

/**
 * generateContent(): deterministic fact-grounded draft; optionally rewritten
 * by an LLM constrained to the same facts. The fact check always runs later
 * against the knowledge graph, so an LLM cannot smuggle in new claims.
 */
export async function generateContent(tx: Tx, organizationId: string, g: ProductGraph, req: DraftRequest, llm?: LlmProvider | null): Promise<{ draft: Draft; aiRunId: string; generatedBy: string }> {
  const t0 = Date.now();
  const draft = generateDraft(g, req);
  if (!llm?.generateObject) {
    const aiRunId = await recordRun(tx, { organizationId, task: "generateContent", provider: "beacon-rules", model: "deterministic", input: req, output: { title: draft.title, factRefs: draft.factRefs.length }, confidence: 1, sources: draft.factRefs.map((f) => f.sourceUrl).filter((u): u is string => Boolean(u)), latencyMs: Date.now() - t0, status: "SUCCEEDED" });
    return { draft, aiRunId, generatedBy: "beacon-rules" };
  }
  const facts = graphFacts(g).map((f) => ({ ref: f.ref, text: f.text, source: f.sourceUrl ?? null }));
  const prompt = `FORMAT: ${req.type}${req.targetQuery ? `\nTARGET QUERY: ${req.targetQuery}` : ""}\n\nFACTS (the only allowed source of claims):\n${JSON.stringify(facts, null, 1)}\n\nDRAFT:\n${draft.body}`;
  try {
    const out = await llm.generateObject({ system: REWRITE_SYSTEM, prompt, schema: RewriteSchema });
    // The model is told not to use long dashes; strip any that slip through before storing.
    const rewritten: Draft = { ...draft, title: stripLongDashes(out.title) || draft.title, metaTitle: stripLongDashes(out.metaTitle) || draft.metaTitle, metaDescription: stripLongDashes(out.metaDescription) || draft.metaDescription, body: stripLongDashes(out.body) };
    // Guard: if the rewrite fails the fact check where the template passed, keep the template draft.
    const before = factCheck(draft.body, g);
    const after = factCheck(rewritten.body, g);
    const keep = after.claims.filter((c) => c.status === "UNSUPPORTED").length <= before.claims.filter((c) => c.status === "UNSUPPORTED").length;
    const aiRunId = await recordRun(tx, { organizationId, task: "rewriteContent", provider: llm.id, model: llm.model, input: { req, draftHash: sha256(draft.body) }, output: { kept: keep, title: rewritten.title }, confidence: keep ? 0.8 : 0.3, latencyMs: Date.now() - t0, status: "SUCCEEDED" });
    return { draft: keep ? rewritten : draft, aiRunId, generatedBy: keep ? `${llm.id}:${llm.model}` : "beacon-rules (LLM rewrite rejected by fact check)" };
  } catch (e) {
    log.warn("ai.rewrite_failed", { err: e });
    const aiRunId = await recordRun(tx, { organizationId, task: "rewriteContent", provider: llm.id, model: llm.model, input: req, output: null, latencyMs: Date.now() - t0, status: "FAILED", error: (e as Error).message });
    return { draft, aiRunId, generatedBy: "beacon-rules (LLM unavailable)" };
  }
}

export function factCheckDraft(body: string, g: ProductGraph) {
  return factCheck(body, g, g.competitors.map((c) => c.competitor.name));
}

export function classifyIntent(query: string, brandTerms: string[]): Classification {
  return classifyQuery(query, brandTerms);
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
