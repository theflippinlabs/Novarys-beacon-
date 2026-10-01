/**
 * Statistics for the estimators (pure, deterministic). Everything random is
 * driven by a seeded PRNG so the same data always yields the same estimate.
 */

/** Number of Monte Carlo draws (and bootstrap resamples) used everywhere. */
export const DRAWS = 2000;

/** z for a two-sided 80% interval (the p10 to p90 band). */
export const Z80 = 1.2815515655446004;

/** mulberry32: small, fast, seeded 32-bit PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash of a string, used to derive a seed from a stable key. */
export function hashSeed(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export type Rng = () => number;

/** Standard normal draw (Box-Muller). */
export function normal(rng: Rng): number {
  let u = 0;
  while (u <= Number.EPSILON) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Gamma(shape, 1) draw (Marsaglia and Tsang; boosted for shape < 1). */
export function gamma(rng: Rng, shape: number): number {
  if (shape < 1) {
    let u = 0;
    while (u <= Number.EPSILON) u = rng();
    return gamma(rng, shape + 1) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0;
    let v = 0;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Beta(a, b) draw. */
export function betaDraw(rng: Rng, a: number, b: number): number {
  const x = gamma(rng, a);
  const y = gamma(rng, b);
  return x / (x + y);
}

/** `n` Beta(a, b) draws from a PRNG seeded with `key` (same key, same draws). */
export function betaDraws(key: string, a: number, b: number, n = DRAWS): Float64Array {
  const rng = mulberry32(hashSeed(key));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = betaDraw(rng, a, b);
  return out;
}

/** ln Γ(x), Lanczos approximation (x > 0). */
export function logGamma(x: number): number {
  const g = 7;
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  x -= 1;
  let a = c[0];
  const t = x + g + 0.5;
  for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

/** Continued fraction for the incomplete beta function (Lentz). */
function betacf(x: number, a: number, b: number): number {
  const MAXIT = 500;
  const EPS = 1e-14;
  const FPMIN = 1e-300;
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < FPMIN) d = FPMIN;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < FPMIN) d = FPMIN;
    c = 1 + aa / c;
    if (Math.abs(c) < FPMIN) c = FPMIN;
    d = 1 / d;
    const del = d * c;
    h *= del;
    if (Math.abs(del - 1) < EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b): the CDF of Beta(a, b) at x. */
export function betaCdf(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const lbt = logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x);
  const bt = Math.exp(lbt);
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(x, a, b)) / a : 1 - (bt * betacf(1 - x, b, a)) / b;
}

/** Quantile of Beta(a, b) (bisection on the CDF, precision 1e-10). */
export function betaQuantile(p: number, a: number, b: number): number {
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (betaCdf(mid, a, b) < p) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-10) break;
  }
  return (lo + hi) / 2;
}

export type Interval = { p10: number; p50: number; p90: number };

/**
 * Posterior of a rate with a uniform Beta(1, 1) prior after `successes` out
 * of `trials`: Beta(successes + 1, trials - successes + 1). Returns its 10th,
 * 50th and 90th percentiles.
 */
export function betaPosterior(successes: number, trials: number): Interval & { a: number; b: number } {
  const a = successes + 1;
  const b = Math.max(0, trials - successes) + 1;
  return { a, b, p10: betaQuantile(0.1, a, b), p50: betaQuantile(0.5, a, b), p90: betaQuantile(0.9, a, b) };
}

/** Wilson score interval for a proportion (default 80%: z = 1.2816). */
export function wilson(successes: number, trials: number, z = Z80): { low: number; high: number; center: number } {
  if (trials <= 0) return { low: 0, high: 1, center: 0.5 };
  const p = successes / trials;
  const z2 = z * z;
  const denom = 1 + z2 / trials;
  const center = (p + z2 / (2 * trials)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / trials + z2 / (4 * trials * trials))) / denom;
  return { low: Math.max(0, center - half), high: Math.min(1, center + half), center };
}

/** Empirical quantile with linear interpolation between order statistics (type 7, as numpy and R default). */
export function quantile(values: ArrayLike<number>, p: number): number {
  const n = values.length;
  if (!n) return NaN;
  const s = Array.from(values).sort((x, y) => x - y);
  const h = (n - 1) * Math.min(1, Math.max(0, p));
  const lo = Math.floor(h);
  const hi = Math.min(n - 1, lo + 1);
  return s[lo] + (h - lo) * (s[hi] - s[lo]);
}

/** p10, p50 and p90 of a sample. */
export function interval(values: ArrayLike<number>): Interval {
  const s = Float64Array.from(values).sort();
  const q = (p: number) => {
    const h = (s.length - 1) * p;
    const lo = Math.floor(h);
    const hi = Math.min(s.length - 1, lo + 1);
    return s[lo] + (h - lo) * (s[hi] - s[lo]);
  };
  return { p10: q(0.1), p50: q(0.5), p90: q(0.9) };
}

/**
 * Seeded nonparametric bootstrap of the mean: `resamples` means of samples
 * drawn with replacement from `values` (the sampling distribution of the mean).
 */
export function bootstrapMeans(values: ArrayLike<number>, key: string, resamples = DRAWS): Float64Array {
  const n = values.length;
  const out = new Float64Array(resamples);
  if (!n) return out;
  const rng = mulberry32(hashSeed(key));
  for (let r = 0; r < resamples; r++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += values[Math.floor(rng() * n)];
    out[r] = sum / n;
  }
  return out;
}

/**
 * Weighted isotonic regression, non-increasing (pool adjacent violators).
 * Returns one fitted value per input, in input order.
 */
export function isotonicDecreasing(values: number[], weights: number[]): number[] {
  const blocks: { v: number; w: number; n: number }[] = [];
  for (let i = 0; i < values.length; i++) {
    blocks.push({ v: values[i], w: Math.max(weights[i], Number.EPSILON), n: 1 });
    while (blocks.length > 1 && blocks[blocks.length - 2].v < blocks[blocks.length - 1].v) {
      const b = blocks.pop()!;
      const a = blocks[blocks.length - 1];
      const w = a.w + b.w;
      a.v = (a.v * a.w + b.v * b.w) / w;
      a.w = w;
      a.n += b.n;
    }
  }
  return blocks.flatMap((b) => Array<number>(b.n).fill(b.v));
}
