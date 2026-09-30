import { normalizeQuery } from "@/core/util/text";

export type EntityRef = { id: string; name: string; aliases?: string[]; domain?: string | null };

export type ResponseAnalysis = {
  productsMentioned: { productId: string; name: string; position: number }[];
  competitorsMentioned: { competitorId: string; name: string; position: number }[];
  citations: string[];
  ownDomainCited: boolean;
  orgMentioned: boolean;
  /** 1-based rank of the first own product among all detected entities; null when none detected. */
  position: number | null;
};

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function firstIndex(text: string, names: string[]): number {
  let best = -1;
  for (const n of names) {
    const m = new RegExp(`(^|[^a-z0-9])${esc(normalizeQuery(n))}([^a-z0-9]|$)`, "i").exec(text);
    if (m && (best === -1 || m.index < best)) best = m.index;
  }
  return best;
}

/**
 * Objective parsing of one AI answer: which known entities appear, in what
 * order, and which URLs were cited. Position is only the order of first
 * appearance in the text — a measurable fact, not a claimed "ranking".
 */
export function analyzeAiResponse(response: string, citations: string[], products: EntityRef[], competitors: EntityRef[], orgNames: string[] = []): ResponseAnalysis {
  const text = normalizeQuery(response);
  const urlsInText = response.match(/https?:\/\/[^\s)\]>"']+/g) ?? [];
  const allCitations = [...new Set([...citations, ...urlsInText].map((u) => u.replace(/[.,;]+$/, "")))];
  const detected: { kind: "p" | "c"; id: string; name: string; idx: number }[] = [];
  for (const p of products) {
    const idx = firstIndex(text, [p.name, ...(p.aliases ?? [])]);
    if (idx >= 0) detected.push({ kind: "p", id: p.id, name: p.name, idx });
  }
  for (const c of competitors) {
    const idx = firstIndex(text, [c.name, ...(c.aliases ?? [])]);
    if (idx >= 0) detected.push({ kind: "c", id: c.id, name: c.name, idx });
  }
  detected.sort((a, b) => a.idx - b.idx);
  const ranked = detected.map((d, i) => ({ ...d, position: i + 1 }));
  const ownDomains = products.map((p) => p.domain?.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase()).filter((d): d is string => Boolean(d));
  const ownDomainCited = allCitations.some((u) => {
    try {
      const h = new URL(u).hostname.toLowerCase();
      return ownDomains.some((d) => h === d || h.endsWith(`.${d}`));
    } catch {
      return false;
    }
  });
  const productsMentioned = ranked.filter((d) => d.kind === "p").map((d) => ({ productId: d.id, name: d.name, position: d.position }));
  return {
    productsMentioned,
    competitorsMentioned: ranked.filter((d) => d.kind === "c").map((d) => ({ competitorId: d.id, name: d.name, position: d.position })),
    citations: allCitations,
    ownDomainCited,
    orgMentioned: productsMentioned.length > 0 || firstIndex(text, orgNames) >= 0,
    position: productsMentioned[0]?.position ?? null,
  };
}
