/**
 * Number guard (pure). A model may explain and reorder Beacon's findings but
 * never add a number: every number in its text must already appear in the
 * data it was given (evidence, estimates, variables, coverage). Numbers are
 * compared by value after normalising thousands separators (1,234 / 1 234)
 * and French decimal commas (12,5); a value may also be written rounded to
 * an integer or one decimal, or a ratio as a percentage (0.45 as 45).
 */

/** Values of every number written in `text`. */
export function extractNumbers(text: string): number[] {
  const normalised = text
    // thousands separators (comma, space, no-break spaces) between digit groups of three
    .replace(/(\d)[,   ](?=\d{3}(?!\d))/g, "$1")
    // decimal comma
    .replace(/(\d),(?=\d)/g, "$1.");
  return [...normalised.matchAll(/\d+(?:\.\d+)?/g)].map((m) => Number(m[0])).filter((n) => Number.isFinite(n));
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;
const key = (n: number) => String(round(n, 4));

/** The set of values a text may contain, with their accepted roundings. */
export function allowedNumbers(sources: unknown[]): Set<string> {
  const out = new Set<string>();
  const add = (n: number) => {
    if (!Number.isFinite(n)) return;
    for (const v of [n, round(n, 0), round(n, 1), round(n, 2), Math.abs(n)]) out.add(key(v));
    // A ratio may be written as a percentage, and a percentage as a ratio.
    if (Math.abs(n) <= 1) for (const v of [n * 100, round(n * 100, 0), round(n * 100, 1)]) out.add(key(Math.abs(v)));
  };
  const walk = (v: unknown, depth: number) => {
    if (depth > 8 || v === null || v === undefined) return;
    if (typeof v === "number") add(v);
    else if (typeof v === "string") extractNumbers(v).forEach(add);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (typeof v === "object") Object.values(v as Record<string, unknown>).forEach((x) => walk(x, depth + 1));
  };
  sources.forEach((s) => walk(s, 0));
  return out;
}

/** Numbers of `text` that are not in `allowed` (empty: the text passes). */
export function inventedNumbers(text: string, allowed: Set<string>): number[] {
  return extractNumbers(text).filter((n) => !allowed.has(key(n)));
}
