import { tokens } from "@/core/util/text";

/**
 * Light, deterministic lemmatiser for English query terms. It only folds the
 * regular inflections that matter for grouping search queries ("tools" and
 * "tool", "moderating" and "moderate" stay distinct on purpose: we do not
 * guess stems that could merge unrelated words).
 */
export function lemma(word: string): string {
  const w = word.toLowerCase();
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (/ies$/.test(w) && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(ches|shes|sses|xes|zes)$/.test(w)) return w.slice(0, -2);
  if (/ss$/.test(w) || /us$/.test(w) || /is$/.test(w)) return w;
  if (/s$/.test(w)) return w.slice(0, -1);
  return w;
}

/**
 * Words that describe intent or format rather than the topic. They decide the
 * intent (see classify.ts) but must not decide which topic cluster a query
 * belongs to ("best moderation tools" and "moderation pricing" share a topic).
 */
export const MODIFIERS = new Set(
  (
    "best top free cheap cheapest pricing price prices cost costs buy plan plans trial demo discount coupon review reviews rating ratings " +
    "alternative alternatives compare comparison versus vs difference software tool tools app apps platform platforms solution solutions service services system systems " +
    "online guide tutorial tutorials example examples learn explained meaning definition list 2024 2025 2026 2027 new good great easy simple " +
    "what how why when where who which is are do does can should get use using way ways"
  ).split(" "),
);

/** All lemmatised, non-stop tokens. */
export function lemmas(text: string): string[] {
  return tokens(text).map(lemma);
}

/** Topic terms: lemmas minus intent/format modifiers, order preserved, de-duplicated. */
export function topicTerms(text: string): string[] {
  return [...new Set(lemmas(text).map(lemma).filter((t) => !MODIFIERS.has(t)))];
}

/** Share of `needle` terms present in `hay` (0 when needle is empty). */
export function termCoverage(needle: string[], hay: Set<string>): number {
  if (!needle.length) return 0;
  return needle.filter((t) => hay.has(t)).length / needle.length;
}
