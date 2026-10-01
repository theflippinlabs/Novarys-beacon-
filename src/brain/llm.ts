import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { DATA_TAG, safeJson } from "@/agent/framing";
import { weightedTokens, type ModelUsage } from "@/agent/budget";
import { resolveCredentials } from "@/ai/registry";
import type { ProviderCredentials } from "@/ai/types";
import type { Estimate, EstimationPower, ImpactEstimate } from "@/core/estimate/types";
import { stripLongDashes } from "@/core/util/text";
import { withOrg } from "@/db";
import { organizations } from "@/db/schema";
import { makeT } from "@/i18n/core";
import { log } from "@/lib/logger";
import { agentBudget, recordAgentUsage } from "@/services/agent-usage";
import { allowedNumbers, inventedNumbers } from "./guard";
import { foldFinding } from "./rank";
import { SEVERITY_ORDER, SPECIALIST_LABELS, type CoverageMap, type Finding, type LlmUsage, type Narrative, type SpecialistReport } from "./types";

/**
 * The Brain's optional LLM phase. Pure parts (model input, output schemas,
 * validation and application) are unit-tested; `callStructured` is the only
 * network call and runs with no database transaction open.
 */

// ─── Output schemas (kept simple for structured outputs; limits are checked after parsing) ───

export const SpecialistOutputSchema = z.object({
  narrative_en: z.string(),
  narrative_fr: z.string(),
  order: z.array(z.string()),
  merges: z.array(z.object({ keep: z.string(), drop: z.array(z.string()) })),
});
export type SpecialistOutput = z.infer<typeof SpecialistOutputSchema>;

export const SynthesisOutputSchema = z.object({ summary_en: z.string(), summary_fr: z.string() });

export const NARRATIVE_MAX = 1500;
export const SUMMARY_MAX = 2500;

// ─── Model input (compact JSON, English) ────────────────────────────────

const en = makeT(null);

function compactEstimate(e: Estimate) {
  return e.state === "ESTIMATED"
    ? { label: e.label, unit: e.unit, ...(e.currency ? { currency: e.currency } : {}), p10: e.p10, p50: e.p50, p90: e.p90, horizonDays: e.horizonDays, confidence: e.confidence, method: e.method, inputs: e.inputs.map((i) => ({ name: i.name, value: i.value })) }
    : { label: e.label, unit: e.unit, notEstimable: e.reason, missing: e.missing };
}

export function compactImpact(e: ImpactEstimate | undefined) {
  if (!e) return null;
  return { signups: compactEstimate(e.signups), revenue: e.revenue.map(compactEstimate), parts: e.parts.map(compactEstimate), missing: e.missing };
}

export const findingText = (f: Finding) => ({ title: en(f.title, f.vars), summary: en(f.summary, f.vars) });

function findingInput(f: Finding) {
  return { id: f.id, severity: f.severity, effort: f.effort, ...findingText(f), evidence: f.evidence.map((e) => ({ label: e.label, value: e.value })), estimate: compactImpact(f.estimate), fromOpportunity: Boolean(f.opportunityId) };
}

export function specialistInput(r: SpecialistReport) {
  return { area: SPECIALIST_LABELS[r.specialist], coverage: r.coverage, missing: r.missing, findings: r.findings.map(findingInput) };
}

export function synthesisInput(input: { coverage: CoverageMap; ranked: Finding[]; unestimated: Finding[]; estimationPower: EstimationPower }) {
  return {
    coverage: Object.fromEntries(Object.entries(input.coverage).map(([k, v]) => [SPECIALIST_LABELS[k as keyof CoverageMap], { coverage: v.coverage, missing: v.missing }])),
    rankedPlan: input.ranked.slice(0, 20).map((f, i) => ({ rank: i + 1, ...findingInput(f), evidence: f.evidence.slice(0, 6).map((e) => ({ label: e.label, value: e.value })) })),
    notEstimable: input.unestimated.slice(0, 15).map((f) => ({ severity: f.severity, ...findingText(f), missing: f.estimate?.missing ?? [] })),
    counts: { rankedPlan: input.ranked.length, notEstimable: input.unestimated.length },
    estimationPower: input.estimationPower,
  };
}

/** Data envelope (same convention as the agent's tool results: untrusted, "<" escaped). */
export const frameData = (name: string, data: unknown) => `<${DATA_TAG} tool="${name.replace(/[^a-z0-9_]/gi, "")}" trust="untrusted">\n${safeJson(data)}\n</${DATA_TAG}>`;

// ─── Validation ─────────────────────────────────────────────────────────

export type Validated<T> = { ok: true; value: T } | { ok: false; reason: string };

const clean = (s: string) => stripLongDashes(s).replace(/\s+/g, " ").trim();

function checkText(texts: string[], max: number, allowed: Set<string>): string | null {
  for (const t of texts) {
    if (!t) return "empty text";
    if (t.length > max) return "text too long";
    const bad = inventedNumbers(t, allowed);
    if (bad.length) return `numbers not in the evidence: ${[...new Set(bad)].slice(0, 5).join(", ")}`;
  }
  return null;
}

/** Ids (uuids) are references, not numbers the model may quote. */
function withoutIds(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(withoutIds);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([k]) => k !== "id").map(([k, x]) => [k, withoutIds(x)]));
  return v;
}

const severityCounts = (fs: Finding[]) => SEVERITY_ORDER.map((s) => fs.filter((f) => f.severity === s).length);

/**
 * Validates a specialist's model output against its report and applies it:
 * narrative (number guard on both languages), order and merges by id.
 * Unknown ids are ignored; a merge that would join two different
 * opportunities is skipped. Any failure keeps the deterministic report.
 */
export function applySpecialistOutput(report: SpecialistReport, raw: unknown, usage?: LlmUsage): Validated<SpecialistReport> {
  const parsed = SpecialistOutputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "output does not match the schema" };
  const out = parsed.data;
  const narrative = { en: clean(out.narrative_en), fr: clean(out.narrative_fr) };
  const allowed = allowedNumbers([withoutIds(specialistInput(report)), report.findings.length, ...severityCounts(report.findings)]);
  const err = checkText([narrative.en, narrative.fr], NARRATIVE_MAX, allowed);
  if (err) return { ok: false, reason: err };

  const byId = new Map(report.findings.map((f) => [f.id, f]));
  const dropped = new Set<string>();
  for (const m of out.merges.slice(0, 20)) {
    const keep = byId.get(m.keep);
    if (!keep || dropped.has(m.keep)) continue;
    let merged = keep;
    for (const id of m.drop.slice(0, 10)) {
      const other = byId.get(id);
      if (!other || id === m.keep || dropped.has(id)) continue;
      if (merged.opportunityId && other.opportunityId && merged.opportunityId !== other.opportunityId) continue;
      merged = foldFinding(merged, other);
      dropped.add(id);
    }
    byId.set(m.keep, merged);
  }
  const ordered: Finding[] = [];
  const placed = new Set<string>();
  for (const id of out.order) {
    const f = byId.get(id);
    if (!f || dropped.has(id) || placed.has(id)) continue;
    ordered.push(f);
    placed.add(id);
  }
  for (const f of report.findings) if (!dropped.has(f.id) && !placed.has(f.id)) ordered.push(byId.get(f.id)!);
  return { ok: true, value: { ...report, findings: ordered, narrative, ...(usage ? { llm: usage } : {}) } };
}

export function validateSynthesis(raw: unknown, input: ReturnType<typeof synthesisInput>): Validated<Narrative> {
  const parsed = SynthesisOutputSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "output does not match the schema" };
  const summary = { en: clean(parsed.data.summary_en), fr: clean(parsed.data.summary_fr) };
  const levels = Object.values(input.coverage).map((c) => c.coverage);
  const allowed = allowedNumbers([withoutIds(input), Object.keys(input.coverage).length, ...["MEASURED", "PARTIAL", "NOT_CONNECTED"].map((l) => levels.filter((x) => x === l).length)]);
  const err = checkText([summary.en, summary.fr], SUMMARY_MAX, allowed);
  return err ? { ok: false, reason: err } : { ok: true, value: summary };
}

// ─── Network ────────────────────────────────────────────────────────────

/** Monthly agent budget kept free for a Brain run's LLM phase (billing-weighted tokens); below it the run stays deterministic. */
export const BRAIN_LLM_RESERVE = 150_000;
const MAX_TOKENS = 16_000;

export type BrainLlm = { client: Anthropic; model: string };

/** Credentials (organisation key, else ANTHROPIC_API_KEY) and budget check, or the reason the LLM phase is skipped. */
export async function resolveBrainLlm(organizationId: string): Promise<{ llm: BrainLlm } | { skipped: string }> {
  const r = await withOrg(organizationId, async (tx): Promise<{ skipped: string; creds?: undefined } | { skipped?: undefined; creds: ProviderCredentials }> => {
    const creds = await resolveCredentials(tx, organizationId, "anthropic");
    if (!creds) return { skipped: "No Anthropic key (Settings, Integrations)" };
    const org = await tx.query.organizations.findFirst({ where: eq(organizations.id, organizationId), columns: { settings: true } });
    const budget = await agentBudget(tx, organizationId, org?.settings ?? {});
    if (budget.exceeded) return { skipped: "Monthly agent budget reached" };
    if (budget.remaining !== null && budget.remaining < BRAIN_LLM_RESERVE) return { skipped: "Not enough monthly agent budget left" };
    return { creds };
  });
  if (!r.creds) return { skipped: r.skipped ?? "No Anthropic key" };
  return { llm: { client: new Anthropic({ apiKey: r.creds.apiKey, timeout: 120_000, maxRetries: 2 }), model: r.creds.model || "claude-opus-5-5" } };
}

export type StructuredResult = { parsed: unknown; usage: LlmUsage; error?: string };

/** One structured-output call (refusal fallbacks on). Never throws: errors come back in `error`. */
export async function callStructured(llm: BrainLlm, system: string, data: string, schema: z.ZodObject, opts: { signal?: AbortSignal } = {}): Promise<StructuredResult> {
  try {
    const res = await llm.client.beta.messages.parse(
      {
        model: llm.model,
        max_tokens: MAX_TOKENS,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "medium", format: betaZodOutputFormat(schema) },
        system,
        messages: [{ role: "user", content: data }],
      },
      { signal: opts.signal },
    );
    const w = weightedTokens(res.usage as ModelUsage);
    const usage = { model: res.model ?? llm.model, inputTokens: w.input, outputTokens: w.output };
    if (res.stop_reason === "refusal") return { parsed: null, usage, error: "refused" };
    if (res.stop_reason === "max_tokens") return { parsed: null, usage, error: "output cut off" };
    const parsed = res.parsed_output ?? null;
    return { parsed, usage, ...(parsed === null ? { error: "no structured output" } : {}) };
  } catch (e) {
    const status = e instanceof Anthropic.APIError ? e.status : undefined;
    log.warn("brain.llm_error", { err: (e as Error).message, status });
    return { parsed: null, usage: { model: llm.model, inputTokens: 0, outputTokens: 0 }, error: e instanceof Anthropic.AuthenticationError ? "key rejected" : status ? `provider error ${status}` : "provider unreachable" };
  }
}

/** Adds one call to the organisation's monthly agent usage (its own short transaction). */
export async function recordBrainUsage(organizationId: string, usage: LlmUsage) {
  if (!usage.inputTokens && !usage.outputTokens) return;
  try {
    await withOrg(organizationId, (tx) => recordAgentUsage(tx, organizationId, { input: usage.inputTokens, output: usage.outputTokens }));
  } catch (e) {
    log.warn("brain.usage_record_failed", { err: (e as Error).message });
  }
}
