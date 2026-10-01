/** Text utilities shared by discovery, classification and similarity scoring. */

export function slugify(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function normalizeQuery(q: string): string {
  return q
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[“”"?!.,;:()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const STOP = new Set(
  "a an and are as at be by for from how i in is it its of on or that the to what which who why with you your does do can my we our best top vs versus".split(" "),
);

export function tokens(text: string, { keepStop = false } = {}): string[] {
  return normalizeQuery(text)
    .split(/[^a-z0-9+#]+/)
    .filter((t) => t.length > 1 && (keepStop || !STOP.has(t)));
}

/** Word n-gram shingles for near-duplicate detection. */
export function shingles(text: string, n = 3): Set<string> {
  const t = tokens(text, { keepStop: true });
  const out = new Set<string>();
  if (t.length < n) {
    if (t.length) out.add(t.join(" "));
    return out;
  }
  for (let i = 0; i <= t.length - n; i++) out.add(t.slice(i, i + n).join(" "));
  return out;
}

export function jaccard<T>(a: Set<T>, b: Set<T>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export function textSimilarity(a: string, b: string, n = 3): number {
  return jaccard(shingles(a, n), shingles(b, n));
}

export const clamp = (v: number, min = 0, max = 1) => Math.min(max, Math.max(min, v));
export const round = (v: number, digits = 1) => Math.round(v * 10 ** digits) / 10 ** digits;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function formatMoney(cents: number, currency = "EUR"): string {
  return new Intl.NumberFormat("en-GB", { style: "currency", currency, maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
}

export function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86_400_000);
}

const LONG_DASH = "\u2014\u2013";

/**
 * Removes em dashes (U+2014) and en dashes (U+2013) from generated text, which
 * Beacon never displays. Numeric ranges become a hyphen ("1-5"), a dash that
 * opens a line (a list bullet) or stands alone in a table cell becomes "-",
 * an en dash joining two words becomes a hyphen, and every other dash (asides,
 * title separators) becomes a comma. Text without long dashes is returned as is.
 */
export function stripLongDashes(s: string): string {
  if (!/[\u2014\u2013]/.test(s)) return s;
  const D = `[${LONG_DASH}]+`;
  return (
    s
      // numeric ranges: "1<en>5", "2020 <en> 2024" become "1-5", "2020-2024"
      .replace(new RegExp(`(\\d)[ \\t]*${D}[ \\t]*(?=\\d)`, "g"), "$1-")
      // line-leading bullets and lone table cells or openers: "<dash> item", "| <dash> |"
      .replace(new RegExp(`^([ \\t>]*)${D}(?=[ \\t]|$)`, "gm"), "$1-")
      .replace(new RegExp(`([|(\\[])([ \\t]*)${D}`, "g"), "$1$2-")
      // already punctuated: "end. <dash> Next" becomes "end. Next"
      .replace(new RegExp(`([.,;:!?])[ \\t]*${D}[ \\t]*(?=\\S)`, "g"), "$1 ")
      // en dash joining two words: "Paris<en>Lyon" becomes "Paris-Lyon"
      .replace(/([\p{L}\p{N}])\u2013(?=[\p{L}\p{N}])/gu, "$1-")
      // dangling dash at the end of a line or of the text
      .replace(new RegExp(`[ \\t]*${D}[ \\t]*$`, "gm"), "")
      // every other aside or separator: "X <dash> Y" and "X<dash>Y" become "X, Y" (no comma before punctuation)
      .replace(new RegExp(`[ \\t]*${D}[ \\t]*(?=([.,;:!?])?)`, "g"), (_m, punct?: string) => (punct ? "" : ", "))
  );
}
