import { tokens } from "@/core/util/text";

/**
 * Internal linking suggestions. For each target page (orphans and weakly
 * linked pages first), find source pages whose visible text already mentions
 * one of the target's queries or most of its title / H1 words, and that do
 * not link to it yet. Anchors are varied (no exact-match anchor is suggested
 * twice for the same target) and suggestions are capped per target. Pure.
 */
export type LinkPage = {
  url: string;
  title: string | null;
  h1: string | null;
  text: string;
  cluster: string;
  inlinks: number;
  indexable: boolean;
  /** Queries this page targets (page plan or search data), if known. */
  queries?: string[];
};

export type LinkSuggestion = {
  source: string;
  target: string;
  anchor: string;
  reason: { code: "QUERY_MENTION" | "TOPIC_MENTION"; phrase: string; sameCluster: boolean; targetInlinks: number };
  score: number;
};

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();

/** Title without the brand part ("Pricing | Acme" → "Pricing"). */
export function titleCore(title: string, siteName?: string | null): string {
  const parts = title.split(/\s+[|·•:\-]\s+/).map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return title.trim();
  const brand = siteName ? norm(siteName) : null;
  const rest = parts.filter((p) => !brand || norm(p) !== brand);
  return (rest.length ? rest : parts).sort((a, b) => b.length - a.length)[0];
}

export function suggestLinks(input: {
  pages: LinkPage[];
  /** Existing internal edges "from\u0000to". */
  existing: Set<string>;
  siteName?: string | null;
  maxPerTarget?: number;
  maxTotal?: number;
}): LinkSuggestion[] {
  const maxPerTarget = input.maxPerTarget ?? 3;
  const maxTotal = input.maxTotal ?? 60;
  const eligible = input.pages.filter((p) => p.indexable);
  const sourceText = new Map(eligible.map((p) => [p.url, ` ${norm(p.text)} `]));
  const sourceTokens = new Map(eligible.map((p) => [p.url, new Set(tokens(p.text))]));
  const targets = [...eligible].sort((a, b) => a.inlinks - b.inlinks || a.url.localeCompare(b.url));
  const out: LinkSuggestion[] = [];

  for (const target of targets) {
    if (out.length >= maxTotal) break;
    const phrases: { phrase: string; code: LinkSuggestion["reason"]["code"] }[] = [];
    for (const q of target.queries ?? []) if (tokens(q).length >= 2) phrases.push({ phrase: norm(q), code: "QUERY_MENTION" });
    for (const t of [target.h1, target.title ? titleCore(target.title, input.siteName) : null]) if (t && tokens(t).length >= 1) phrases.push({ phrase: norm(t), code: "TOPIC_MENTION" });
    if (!phrases.length) continue;

    const candidates: LinkSuggestion[] = [];
    for (const source of eligible) {
      if (source.url === target.url || input.existing.has(`${source.url}\u0000${target.url}`)) continue;
      const text = sourceText.get(source.url)!;
      const toks = sourceTokens.get(source.url)!;
      for (const ph of phrases) {
        const exact = text.includes(` ${ph.phrase} `);
        const words = tokens(ph.phrase);
        const covered = words.filter((w) => toks.has(w)).length / words.length;
        if (!exact && (ph.code === "QUERY_MENTION" || covered < 0.75 || words.length < 2)) continue;
        const sameCluster = source.cluster === target.cluster;
        const score = (exact ? 2 : covered) + (ph.code === "QUERY_MENTION" ? 1 : 0) + (sameCluster ? 0.5 : 0) + (target.inlinks === 0 ? 1 : 1 / (1 + target.inlinks));
        candidates.push({ source: source.url, target: target.url, anchor: ph.phrase, reason: { code: ph.code, phrase: ph.phrase, sameCluster, targetInlinks: target.inlinks }, score: Math.round(score * 100) / 100 });
        break;
      }
    }
    candidates.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source));
    // Vary anchors: each exact anchor text at most once per target.
    const usedAnchors = new Set<string>();
    let n = 0;
    for (const c of candidates) {
      if (n >= maxPerTarget || out.length >= maxTotal) break;
      let anchor = c.anchor;
      if (usedAnchors.has(anchor)) {
        const alt = phrases.map((p) => p.phrase).find((p) => !usedAnchors.has(p) && sourceText.get(c.source)!.includes(` ${p} `));
        if (!alt) continue;
        anchor = alt;
      }
      usedAnchors.add(anchor);
      out.push({ ...c, anchor });
      n++;
    }
  }
  return out;
}

/** Topic cluster of a URL when no plan or query cluster is known: its first path segment. */
export function pathCluster(url: string): string {
  try {
    const seg = new URL(url).pathname.split("/").filter(Boolean)[0];
    return seg ? `/${seg}` : "/";
  } catch {
    return "/";
  }
}

/**
 * "Related" links for a Beacon-hosted page: other published pages of the same
 * product, those of the same topic cluster first, then the rest by path.
 */
export function relatedPages<T extends { id: string; productId: string | null; path: string; cluster: string }>(current: T, all: T[], max = 6): T[] {
  return all
    .filter((p) => p.id !== current.id && p.productId === current.productId)
    .sort((a, b) => Number(b.cluster === current.cluster) - Number(a.cluster === current.cluster) || a.path.localeCompare(b.path))
    .slice(0, max);
}
