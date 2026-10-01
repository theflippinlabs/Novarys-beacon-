/**
 * Fuzzy matching for the command palette (pure, deterministic). Scores are
 * tiered so the order is explainable: exact > prefix > word prefix >
 * substring > every word found > in-order subsequence. Accents and case are
 * ignored. `null` means no match.
 */
export const normalizeText = (s: string) =>
  s
    .normalize("NFD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

export function fuzzyScore(query: string, text: string): number | null {
  const q = normalizeText(query);
  const s = normalizeText(text);
  if (!q) return 0;
  if (!s) return null;
  if (s === q) return 1000;
  if (s.startsWith(q)) return 900 - Math.min(99, s.length - q.length);
  const words = s.split(/[\s/:._-]+/).filter(Boolean);
  if (words.some((w) => w.startsWith(q))) return 800 - Math.min(99, s.length - q.length);
  const at = s.indexOf(q);
  if (at >= 0) return 700 - Math.min(99, at);
  const tokens = q.split(" ").filter(Boolean);
  if (tokens.length > 1 && tokens.every((tk) => s.includes(tk))) {
    const prefixHits = tokens.filter((tk) => words.some((w) => w.startsWith(tk))).length;
    return 600 + Math.min(50, prefixHits * 10) - Math.min(49, s.length - q.length);
  }
  // Subsequence: every query character in order; consecutive runs and word starts score higher, gaps lower.
  const needle = q.replace(/ /g, "");
  let i = 0;
  let score = 0;
  let prev = -2;
  for (let j = 0; j < s.length && i < needle.length; j++) {
    if (s[j] !== needle[i]) continue;
    score += j === prev + 1 ? 6 : 1;
    if (j === 0 || /[\s/:._-]/.test(s[j - 1])) score += 4;
    prev = j;
    i++;
  }
  if (i < needle.length) return null;
  return Math.max(1, Math.min(499, 100 + score * 4 - Math.min(99, s.length - needle.length)));
}

export type Rankable = { label: string; keywords?: string[] };

/** Matching items, best first (ties keep their input order). The best of label and keywords counts, keywords slightly lower. */
export function rankItems<T extends Rankable>(query: string, items: T[], limit = Infinity): T[] {
  const scored: { item: T; score: number; i: number }[] = [];
  items.forEach((item, i) => {
    let best = fuzzyScore(query, item.label);
    for (const k of item.keywords ?? []) {
      const ks = fuzzyScore(query, k);
      if (ks !== null && (best === null || ks - 5 > best)) best = ks - 5;
    }
    if (best !== null) scored.push({ item, score: best, i });
  });
  scored.sort((a, b) => b.score - a.score || a.i - b.i);
  return scored.slice(0, limit).map((x) => x.item);
}

/** Escapes LIKE wildcards so user input is matched literally. */
export const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);
