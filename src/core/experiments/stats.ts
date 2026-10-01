/**
 * Growth experiment statistics (pure). Conversion experiments compare two
 * proportions: the control arm and the variant arm, each with a number of
 * exposed units (n) and of converted units.
 *
 * - Two-proportion z-test (pooled standard error, two-sided) when every
 *   expected cell count is at least 5.
 * - Fisher's exact test (two-sided, hypergeometric) for small counts.
 * - Minimum sample size per arm for a baseline rate and a minimum detectable
 *   effect (relative lift), alpha 0.05 two-sided and power 0.8 by default.
 *
 * A winner is declared only when both arms reached the minimum sample size
 * and p < alpha. Otherwise the result is INCONCLUSIVE, with the reason.
 */

export type ExperimentArm = { description?: string; url?: string };
export type Winner = "CONTROL" | "VARIANT" | "INCONCLUSIVE";
export type TestMethod = "Z_TEST" | "FISHER_EXACT";
export const ALPHA = 0.05;
export const POWER = 0.8;

/** Standard normal CDF (Abramowitz and Stegun 7.1.26 via erf, absolute error below 1.5e-7). */
export function normalCdf(z: number): number {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/** Inverse standard normal CDF (Acklam's rational approximation, relative error below 1.2e-9). */
export function normalQuantile(p: number): number {
  if (!(p > 0 && p < 1)) throw new Error("p must be in (0, 1)");
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -normalQuantile(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q) / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

export type Counts = { controlN: number; controlConversions: number; variantN: number; variantConversions: number };

function assertCounts(c: Counts) {
  for (const [k, v] of Object.entries(c)) if (!Number.isInteger(v) || v < 0) throw new Error(`${k} must be a non-negative integer`);
  if (c.controlConversions > c.controlN || c.variantConversions > c.variantN) throw new Error("Conversions cannot exceed the sample size");
}

/** Two-sided two-proportion z-test with a pooled standard error. */
export function twoProportionZTest(c: Counts): { z: number; pValue: number } {
  assertCounts(c);
  if (!c.controlN || !c.variantN) return { z: 0, pValue: 1 };
  const p1 = c.controlConversions / c.controlN;
  const p2 = c.variantConversions / c.variantN;
  const pool = (c.controlConversions + c.variantConversions) / (c.controlN + c.variantN);
  const se = Math.sqrt(pool * (1 - pool) * (1 / c.controlN + 1 / c.variantN));
  if (se === 0) return { z: 0, pValue: 1 };
  const z = (p2 - p1) / se;
  return { z, pValue: Math.min(1, 2 * (1 - normalCdf(Math.abs(z)))) };
}

/** log(n!) by summation (exact enough for the sample sizes Fisher's test is used for) with Stirling beyond. */
function logFactorial(n: number): number {
  if (n < 2) return 0;
  if (n < 1000) {
    let s = 0;
    for (let i = 2; i <= n; i++) s += Math.log(i);
    return s;
  }
  return n * Math.log(n) - n + 0.5 * Math.log(2 * Math.PI * n) + 1 / (12 * n) - 1 / (360 * n ** 3);
}

/**
 * Two-sided Fisher's exact test on the 2x2 table
 * [[controlConversions, controlN - controlConversions], [variantConversions, variantN - variantConversions]]:
 * the sum of the probabilities of every table with the same margins that is
 * at most as likely as the observed one.
 */
export function fisherExact(c: Counts): { pValue: number } {
  assertCounts(c);
  const a = c.controlConversions;
  const r1 = c.controlN;
  const r2 = c.variantN;
  const k = c.controlConversions + c.variantConversions;
  const n = r1 + r2;
  if (!n) return { pValue: 1 };
  const lf = (x: number) => logFactorial(x);
  const base = lf(r1) + lf(r2) + lf(k) + lf(n - k) - lf(n);
  const logP = (x: number) => base - lf(x) - lf(r1 - x) - lf(k - x) - lf(r2 - k + x);
  const lo = Math.max(0, k - r2);
  const hi = Math.min(k, r1);
  const observed = logP(a);
  let p = 0;
  for (let x = lo; x <= hi; x++) {
    const lp = logP(x);
    if (lp <= observed + 1e-7) p += Math.exp(lp);
  }
  return { pValue: Math.min(1, p) };
}

/**
 * Minimum sample size per arm to detect a relative lift `mde` over the
 * baseline conversion rate (two-sided alpha, power), normal approximation:
 * n = (z(1-a/2) * sqrt(2 * pbar * (1 - pbar)) + z(power) * sqrt(p1(1-p1) + p2(1-p2)))^2 / (p2 - p1)^2.
 */
export function minSampleSizePerArm(baselineRate: number, mde: number, opts: { alpha?: number; power?: number } = {}): number {
  const alpha = opts.alpha ?? ALPHA;
  const power = opts.power ?? POWER;
  if (!(baselineRate > 0 && baselineRate < 1)) throw new Error("The baseline rate must be between 0 and 1 (exclusive).");
  if (!(mde > 0)) throw new Error("The minimum detectable effect must be positive.");
  const p1 = baselineRate;
  const p2 = baselineRate * (1 + mde);
  if (p2 >= 1) throw new Error("Baseline rate × (1 + effect) must stay below 100%.");
  const pbar = (p1 + p2) / 2;
  const za = normalQuantile(1 - alpha / 2);
  const zb = normalQuantile(power);
  const n = (za * Math.sqrt(2 * pbar * (1 - pbar)) + zb * Math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))) ** 2 / (p2 - p1) ** 2;
  return Math.ceil(n);
}

/** Fisher's exact test is used when any expected cell count is below 5. */
export function chooseMethod(c: Counts): TestMethod {
  const n = c.controlN + c.variantN;
  if (!n) return "FISHER_EXACT";
  const k = c.controlConversions + c.variantConversions;
  const expected = [c.controlN * (k / n), c.controlN * (1 - k / n), c.variantN * (k / n), c.variantN * (1 - k / n)];
  return expected.some((e) => e < 5) ? "FISHER_EXACT" : "Z_TEST";
}

export type ResultReason = "NO_COUNTS" | "NO_MIN_SAMPLE" | "BELOW_MIN_SAMPLE" | "NOT_SIGNIFICANT" | "SIGNIFICANT";

export type ExperimentResult = {
  winner: Winner;
  reason: ResultReason;
  method: TestMethod | null;
  pValue: number | null;
  /** 1 - p (not a posterior probability; stored for display). */
  confidence: number | null;
  controlRate: number | null;
  variantRate: number | null;
  /** Relative lift of the variant over control (null when control is 0). */
  lift: number | null;
  /** min(n per arm) / minimum sample, capped at 1. */
  progress: number | null;
  explanation: string;
};

const pct = (x: number) => `${(Math.round(x * 1000) / 10).toFixed(1)}%`;
const fmtP = (p: number) => (p < 0.001 ? "< 0.001" : p.toFixed(3));

/**
 * Statistical result of an experiment. Refuses to declare a winner below the
 * minimum sample size (in either arm) or when p >= alpha.
 */
export function evaluateExperiment(input: Partial<Counts> & { minSampleSize?: number | null; alpha?: number }): ExperimentResult {
  const alpha = input.alpha ?? ALPHA;
  const empty = { method: null, pValue: null, confidence: null, controlRate: null, variantRate: null, lift: null };
  const { controlN, controlConversions, variantN, variantConversions } = input;
  if (controlN == null || controlConversions == null || variantN == null || variantConversions == null || controlN === 0 || variantN === 0)
    return { ...empty, winner: "INCONCLUSIVE", reason: "NO_COUNTS", progress: input.minSampleSize ? 0 : null, explanation: "No counts yet: a result needs exposures and conversions in both arms." };
  const c: Counts = { controlN, controlConversions, variantN, variantConversions };
  assertCounts(c);
  const controlRate = controlConversions / controlN;
  const variantRate = variantConversions / variantN;
  const lift = controlRate > 0 ? (variantRate - controlRate) / controlRate : null;
  const method = chooseMethod(c);
  const pValue = method === "Z_TEST" ? twoProportionZTest(c).pValue : fisherExact(c).pValue;
  const base = { method, pValue, confidence: 1 - pValue, controlRate, variantRate, lift };
  const rates = `control ${pct(controlRate)} (${controlConversions}/${controlN}), variant ${pct(variantRate)} (${variantConversions}/${variantN})`;
  const testName = method === "Z_TEST" ? "two-proportion z-test" : "Fisher's exact test";
  if (!input.minSampleSize)
    return { ...base, winner: "INCONCLUSIVE", reason: "NO_MIN_SAMPLE", progress: null, explanation: `No minimum sample size was set, so no winner can be declared (${rates}).` };
  const minN = Math.min(controlN, variantN);
  const progress = Math.min(1, minN / input.minSampleSize);
  if (minN < input.minSampleSize)
    return {
      ...base,
      winner: "INCONCLUSIVE",
      reason: "BELOW_MIN_SAMPLE",
      progress,
      explanation: `Below the minimum sample size (${minN} of ${input.minSampleSize} per arm): no winner is declared yet, whatever the p-value (${rates}).`,
    };
  if (pValue >= alpha)
    return { ...base, winner: "INCONCLUSIVE", reason: "NOT_SIGNIFICANT", progress, explanation: `Not statistically significant (${testName}, p = ${fmtP(pValue)}, threshold ${alpha}): ${rates}.` };
  const winner: Winner = variantRate > controlRate ? "VARIANT" : "CONTROL";
  return {
    ...base,
    winner,
    reason: "SIGNIFICANT",
    progress,
    explanation: `${winner === "VARIANT" ? "The variant" : "The control"} converts better (${testName}, p = ${fmtP(pValue)} < ${alpha}): ${rates}.`,
  };
}
