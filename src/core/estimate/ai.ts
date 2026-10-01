import { MISSING, THRESHOLDS, fmt, notEstimable, round, scopeKey, type EstimationContext } from "./context";
import { betaDraws, DRAWS, interval, wilson } from "./stats";
import type { Estimate, EstimateConfidence, EstimateInput } from "./types";

export const AI_KEY = "ai_mention_rate";
export const AI_LABEL = "AI mention rate";
export const AI_METHOD = "Share of sampled AI answers (AI visibility tests) that mention the product. Interval: Wilson score interval (80%).";
export const AI_GAP_KEY = "ai_mention_gap";
export const AI_GAP_LABEL = "Gap to the best competitor";
export const AI_GAP_METHOD =
  "Mention rate of the most mentioned competitor minus the product's, in the same sampled answers. Interval: difference of two Beta posteriors (uniform prior), 2,000 seeded draws.";

/** Confidence from sampled answers: LOW under 30, MEDIUM under 100, HIGH from 100. */
export function aiConfidence(samples: number): EstimateConfidence {
  return samples < 30 ? "LOW" : samples < 100 ? "MEDIUM" : "HIGH";
}

function scopeOf(ctx: EstimationContext, productId: string | null) {
  return ctx.ai.byScope[scopeKey(productId)] ?? { samples: 0, mentioned: 0, competitors: [] };
}

function notEnough(ctx: EstimationContext, key: string, label: string, samples: number, inputs: EstimateInput[]): Estimate {
  const missing = ctx.ai.tested ? [MISSING.aiSamples] : [MISSING.aiTests, MISSING.aiSamples];
  return notEstimable(key, label, "ratio", fmt("Fewer than 10 sampled AI answers in the last {days} days ({n} measured).", { days: ctx.ai.windowDays, n: samples }), missing, inputs);
}

/** Share of sampled AI answers that mention the product (the organisation when productId is null). */
export function estimateAiMentionRate(ctx: EstimationContext, productId: string | null): Estimate {
  const s = scopeOf(ctx, productId);
  const best = [...s.competitors].sort((a, b) => b.mentioned - a.mentioned || a.name.localeCompare(b.name))[0];
  const inputs: EstimateInput[] = [
    { name: "Sampled AI answers", value: s.samples, source: "MEASURED", detail: fmt("AI visibility tests in the last {days} days.", { days: ctx.ai.windowDays }), sampleSize: s.samples },
    { name: "Answers mentioning the product", value: s.mentioned, source: "MEASURED", detail: "Detected in the answer text." },
  ];
  if (best && s.samples > 0)
    inputs.push({ name: "Best competitor mention rate", value: round(best.mentioned / s.samples, 4), unit: "ratio", source: "MEASURED", detail: fmt("{name}: mentioned in {n} of {total} answers.", { name: best.name, n: best.mentioned, total: s.samples }) });
  if (s.samples < THRESHOLDS.aiSamples) return notEnough(ctx, AI_KEY, AI_LABEL, s.samples, inputs);
  const w = wilson(s.mentioned, s.samples);
  return {
    key: AI_KEY,
    label: AI_LABEL,
    unit: "ratio",
    state: "ESTIMATED",
    p10: round(w.low, 6),
    p50: round(s.mentioned / s.samples, 6),
    p90: round(w.high, 6),
    horizonDays: ctx.ai.windowDays,
    confidence: aiConfidence(s.samples),
    method: AI_METHOD,
    inputs,
  };
}

/** Mention rate gap to the most mentioned competitor (positive: the competitor is mentioned more). */
export function estimateAiMentionGap(ctx: EstimationContext, productId: string | null): Estimate {
  const s = scopeOf(ctx, productId);
  const best = [...s.competitors].sort((a, b) => b.mentioned - a.mentioned || a.name.localeCompare(b.name))[0];
  const inputs: EstimateInput[] = [{ name: "Sampled AI answers", value: s.samples, source: "MEASURED", detail: fmt("AI visibility tests in the last {days} days.", { days: ctx.ai.windowDays }), sampleSize: s.samples }];
  if (s.samples < THRESHOLDS.aiSamples) return notEnough(ctx, AI_GAP_KEY, AI_GAP_LABEL, s.samples, inputs);
  if (!best) return notEstimable(AI_GAP_KEY, AI_GAP_LABEL, "ratio", "No competitor was mentioned in the sampled AI answers.", [], inputs);
  inputs.push(
    { name: "Answers mentioning the product", value: s.mentioned, source: "MEASURED", detail: "Detected in the answer text." },
    { name: "Best competitor", value: best.name, source: "MEASURED", detail: fmt("{name}: mentioned in {n} of {total} answers.", { name: best.name, n: best.mentioned, total: s.samples }) },
  );
  const base = `${ctx.organizationId}|ai|${scopeKey(productId)}|${s.samples}`;
  const own = betaDraws(`${base}|own|${s.mentioned}`, s.mentioned + 1, s.samples - s.mentioned + 1);
  const comp = betaDraws(`${base}|${best.id}|${best.mentioned}`, best.mentioned + 1, s.samples - best.mentioned + 1);
  const diff = new Float64Array(DRAWS);
  for (let i = 0; i < DRAWS; i++) diff[i] = comp[i] - own[i];
  const iv = interval(diff);
  return {
    key: AI_GAP_KEY,
    label: AI_GAP_LABEL,
    unit: "ratio",
    state: "ESTIMATED",
    p10: round(iv.p10, 6),
    p50: round(iv.p50, 6),
    p90: round(iv.p90, 6),
    horizonDays: ctx.ai.windowDays,
    confidence: aiConfidence(s.samples),
    method: AI_GAP_METHOD,
    inputs,
  };
}
