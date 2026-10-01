import { jaccard, slugify } from "@/core/util/text";
import type { Intent, TopicType } from "./classify";
import { topicTerms } from "./terms";

/**
 * Semantic clustering of a query universe, deterministic and explainable.
 *
 * Every query is reduced to its topic terms (lemmatised tokens minus stop
 * words and intent/format modifiers such as "best", "pricing", "software").
 * Queries are processed by importance, then measured demand, then text; each
 * query joins the first existing cluster of the same asset family whose seed
 * it resembles:
 * - Jaccard similarity of topic terms >= `threshold` (default 0.5), or
 * - at least two shared head terms covering >= 60% of the smaller term set.
 * Otherwise it seeds a new cluster. Comparison/alternative queries and
 * branded navigational/transactional queries form their own families so a
 * "X vs Y" query never lands in a how-to guide cluster.
 *
 * A cluster maps to ONE recommended asset (never one page per keyword).
 */
export type AssetType =
  | "PRODUCT_PAGE"
  | "PRICING_PAGE"
  | "LANDING_PAGE"
  | "FEATURE_PAGE"
  | "USE_CASE_PAGE"
  | "INTEGRATION_PAGE"
  | "COMPARISON_PAGE"
  | "ALTERNATIVES_PAGE"
  | "GUIDE"
  | "FAQ";

export type ClusterInput = {
  id: string;
  query: string;
  intent: Intent;
  topicType?: TopicType | null;
  branded?: boolean;
  importance?: number;
  impressions?: number | null;
};

export type QueryCluster = {
  key: string;
  name: string;
  headTerms: string[];
  memberIds: string[];
  seedId: string;
  intent: Intent;
  topicType: TopicType;
  branded: boolean;
  recommendedAsset: AssetType;
  /** How the members were grouped, for the UI. */
  rationale: string;
};

type Family = "compare" | "brand" | "topic";
const familyOf = (q: ClusterInput): Family =>
  q.intent === "COMPARISON" || q.intent === "ALTERNATIVE" ? "compare" : q.branded && (q.intent === "NAVIGATIONAL" || q.intent === "TRANSACTIONAL") ? "brand" : "topic";

const weight = (q: ClusterInput) => (q.importance ?? 3) * 1000 + Math.min(999, q.impressions ?? 0);

/** Dominant value by summed weight; ties broken by first appearance (members are already ordered). */
function dominant<T extends string>(items: { v: T; w: number }[], fallback: T): T {
  const m = new Map<T, number>();
  for (const { v, w } of items) m.set(v, (m.get(v) ?? 0) + w);
  let best: T = fallback;
  let bw = -1;
  for (const [v, w] of m) if (w > bw) [best, bw] = [v, w];
  return best;
}

export function recommendAsset(intent: Intent, topicType: TopicType, branded: boolean): AssetType {
  if (intent === "COMPARISON") return "COMPARISON_PAGE";
  if (intent === "ALTERNATIVE") return "ALTERNATIVES_PAGE";
  if (topicType === "INTEGRATION") return "INTEGRATION_PAGE";
  if (intent === "NAVIGATIONAL") return "PRODUCT_PAGE";
  if (intent === "TRANSACTIONAL") return branded ? "PRICING_PAGE" : "LANDING_PAGE";
  if (intent === "INFORMATIONAL" && branded) return "FAQ";
  if (intent === "PROBLEM" || intent === "INFORMATIONAL") return "GUIDE";
  if (topicType === "USE_CASE") return "USE_CASE_PAGE";
  if (topicType === "FEATURE") return "FEATURE_PAGE";
  return "LANDING_PAGE";
}

/** Content studio format used when a draft is created for an asset type. */
export function assetContentType(a: AssetType): "LANDING_PAGE" | "ARTICLE" | "FAQ" | "TUTORIAL" | "COMPARISON" {
  if (a === "COMPARISON_PAGE" || a === "ALTERNATIVES_PAGE") return "COMPARISON";
  if (a === "FAQ") return "FAQ";
  if (a === "GUIDE") return "TUTORIAL";
  return "LANDING_PAGE";
}

export function clusterQueries(items: ClusterInput[], opts: { threshold?: number } = {}): QueryCluster[] {
  const threshold = opts.threshold ?? 0.5;
  const ordered = [...items].sort((a, b) => weight(b) - weight(a) || a.query.localeCompare(b.query) || a.id.localeCompare(b.id));
  type Acc = { family: Family; seed: ClusterInput; seedTerms: Set<string>; members: { q: ClusterInput; terms: string[] }[] };
  const acc: Acc[] = [];
  for (const q of ordered) {
    const terms = topicTerms(q.query);
    const set = new Set(terms);
    const family = familyOf(q);
    const home = acc.find((c) => {
      if (c.family !== family) return false;
      if (!set.size && !c.seedTerms.size) return true;
      if (!set.size || !c.seedTerms.size) return false;
      if (jaccard(set, c.seedTerms) >= threshold) return true;
      let shared = 0;
      for (const t of set) if (c.seedTerms.has(t)) shared++;
      return shared >= 2 && shared / Math.min(set.size, c.seedTerms.size) >= 0.6;
    });
    if (home) home.members.push({ q, terms });
    else acc.push({ family, seed: q, seedTerms: set, members: [{ q, terms }] });
  }
  return acc.map((c) => {
    // Head terms: most frequent topic terms, ties broken by first appearance (seed first).
    const freq = new Map<string, { n: number; first: number }>();
    let i = 0;
    for (const m of c.members) for (const t of new Set(m.terms)) freq.set(t, { n: (freq.get(t)?.n ?? 0) + 1, first: freq.get(t)?.first ?? i++ });
    const headTerms = [...freq.entries()]
      .sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first)
      .slice(0, 4)
      .map(([t]) => t);
    const intent = dominant(c.members.map((m) => ({ v: m.q.intent, w: weight(m.q) })), c.seed.intent);
    const topicType = dominant(c.members.map((m) => ({ v: (m.q.topicType ?? "CATEGORY") as TopicType, w: weight(m.q) })), "CATEGORY");
    const brandedCount = c.members.filter((m) => m.q.branded).length;
    const branded = brandedCount * 2 > c.members.length;
    const keyTerms = [...c.seedTerms].sort().slice(0, 5);
    const key = `${c.family}-${slugify(keyTerms.join(" ")) || "general"}`.slice(0, 80);
    // Named after its most important query: readable, and the head terms stay available separately.
    const name = c.seed.query;
    return {
      key,
      name,
      headTerms,
      memberIds: c.members.map((m) => m.q.id),
      seedId: c.seed.id,
      intent,
      topicType,
      branded,
      recommendedAsset: recommendAsset(intent, topicType, branded),
      rationale:
        c.members.length > 1
          ? `${c.members.length} queries share the topic terms "${headTerms.join(", ")}" (seed: "${c.seed.query}")`
          : `Single query; no other query shares its topic terms`,
    };
  });
}
