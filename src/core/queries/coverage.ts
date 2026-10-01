import { tokens } from "@/core/util/text";
import { lemma, termCoverage } from "./terms";

export type Coverage = "NONE" | "PARTIAL" | "COVERED";
export type CoverageSource = "BEACON_PAGE" | "SEARCH_DATA" | "CRAWLED_PAGE";

export type BeaconPageRef = { id: string; title: string; status: string; targetQueryId: string | null; url: string };
/** A page of the product's own website from the latest crawl. */
export type CrawledPageRef = { url: string; title: string | null; h1: string | null; headings: string[] };
/** Measured search data for this query: one row per landing page of the product. */
export type SearchPairRef = { page: string; impressions: number; clicks: number; position: number | null };

export type CoverageResult = {
  coverage: Coverage;
  reason: string;
  url: string | null;
  pageId: string | null;
  source: CoverageSource | null;
};

const RANK: Record<Coverage, number> = { NONE: 0, PARTIAL: 1, COVERED: 2 };

/** Content words of a text, lemmatised (stop words removed, modifiers kept: "pricing" matters for coverage). */
const words = (s: string | null | undefined) => tokens(s ?? "").map(lemma);
const urlWords = (u: string) => {
  try {
    return words(decodeURIComponent(new URL(u).pathname).replace(/[-_/.]+/g, " "));
  } catch {
    return words(u.replace(/[-_/.]+/g, " "));
  }
};

/**
 * Coverage of one query, with evidence. Sources, strongest first:
 * 1. A published Beacon page that targets the query: COVERED.
 * 2. Measured search data (query and landing page pairs): impressions on a
 *    product page mean the site is at least partially covering the query;
 *    an average position of 10 or better is COVERED.
 * 3. The product's latest crawl: every query word in the title or H1 of a
 *    page is COVERED; at least 60% of the words in the title, headings or
 *    URL is PARTIAL.
 * 4. A Beacon page that targets the query but is not published, or a
 *    published Beacon page whose title holds at least 75% of the words: PARTIAL.
 * The best result wins; on a tie the order above decides.
 */
export function assessQueryCoverage(
  q: { id: string; query: string },
  ctx: { beaconPages: BeaconPageRef[]; crawled: CrawledPageRef[]; search: SearchPairRef[] },
): CoverageResult {
  const qw = [...new Set(words(q.query))];
  const results: CoverageResult[] = [];

  const targeted = ctx.beaconPages.filter((p) => p.targetQueryId === q.id);
  const pub = targeted.find((p) => p.status === "PUBLISHED");
  if (pub) results.push({ coverage: "COVERED", reason: "A published Beacon page targets this query", url: pub.url, pageId: pub.id, source: "BEACON_PAGE" });

  const pairs = ctx.search.filter((s) => s.impressions > 0).sort((a, b) => b.impressions - a.impressions);
  const top = pairs[0];
  if (top) {
    const pos = top.position;
    if (pos !== null && pos <= 10)
      results.push({ coverage: "COVERED", reason: `Search data: ranks on page one (average position ${pos.toFixed(1)}, ${top.impressions} impressions)`, url: top.page, pageId: null, source: "SEARCH_DATA" });
    else
      results.push({
        coverage: "PARTIAL",
        reason: `Search data: ${top.impressions} impressions but average position ${pos === null ? "unknown" : pos.toFixed(1)}`,
        url: top.page,
        pageId: null,
        source: "SEARCH_DATA",
      });
  }

  if (qw.length) {
    let best: { page: CrawledPageRef; full: boolean; share: number } | null = null;
    for (const p of ctx.crawled) {
      const strong = new Set([...words(p.title), ...words(p.h1)]);
      const all = new Set([...strong, ...p.headings.flatMap(words), ...urlWords(p.url)]);
      const full = termCoverage(qw, strong) === 1;
      const share = termCoverage(qw, all);
      if (!best || (full && !best.full) || (full === best.full && share > best.share)) best = { page: p, full, share };
    }
    if (best?.full) results.push({ coverage: "COVERED", reason: "Crawled site: every query word appears in the page title or H1", url: best.page.url, pageId: null, source: "CRAWLED_PAGE" });
    else if (best && best.share >= 0.6)
      results.push({ coverage: "PARTIAL", reason: `Crawled site: ${Math.round(best.share * 100)}% of the query words appear in the title, headings or URL`, url: best.page.url, pageId: null, source: "CRAWLED_PAGE" });
  }

  const draft = targeted.find((p) => p.status !== "PUBLISHED" && p.status !== "ARCHIVED");
  if (draft) results.push({ coverage: "PARTIAL", reason: `A Beacon page targets this query but is not published (${draft.status.toLowerCase()})`, url: draft.url, pageId: draft.id, source: "BEACON_PAGE" });
  if (qw.length) {
    const titleMatch = ctx.beaconPages.find((p) => p.status === "PUBLISHED" && termCoverage(qw, new Set(words(p.title))) >= 0.75);
    if (titleMatch) results.push({ coverage: "PARTIAL", reason: "A published Beacon page title contains most query words", url: titleMatch.url, pageId: titleMatch.id, source: "BEACON_PAGE" });
  }

  let out: CoverageResult = { coverage: "NONE", reason: "No Beacon page, crawled page or search result covers this query", url: null, pageId: null, source: null };
  for (const r of results) if (RANK[r.coverage] > RANK[out.coverage]) out = r;
  return out;
}

/**
 * Cluster coverage from its members: COVERED when the seed query or at least
 * half of the members are covered, PARTIAL when any member is at least
 * partially covered, NONE otherwise. The evidence comes from the best member.
 */
export function clusterCoverage(members: { id: string; coverage: CoverageResult }[], seedId: string): CoverageResult & { covered: number; total: number } {
  const total = members.length;
  const covered = members.filter((m) => m.coverage.coverage === "COVERED").length;
  const seed = members.find((m) => m.id === seedId);
  const best = [...members].sort((a, b) => RANK[b.coverage.coverage] - RANK[a.coverage.coverage])[0];
  if (!best || best.coverage.coverage === "NONE") return { coverage: "NONE", reason: "No member query is covered", url: null, pageId: null, source: null, covered, total };
  const level: Coverage = seed?.coverage.coverage === "COVERED" || covered * 2 >= total ? "COVERED" : "PARTIAL";
  return { ...best.coverage, coverage: level, reason: `${covered} of ${total} queries covered. ${best.coverage.reason}`, covered, total };
}
