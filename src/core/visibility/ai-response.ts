import { normalizeQuery } from "@/core/util/text";

export type EntityRef = { id: string; name: string; aliases?: string[]; domain?: string | null };

/** `position` is the order of first appearance among detected entities (never a ranking); `offset` is the character offset of the first mention in the raw answer; `offsets` lists every mention. */
export type MentionDetail = { name: string; position: number; offset: number | null; offsets: number[]; snippet: string | null };

export type ResponseAnalysis = {
  productsMentioned: (MentionDetail & { productId: string })[];
  competitorsMentioned: (MentionDetail & { competitorId: string })[];
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

/** Every character offset of a name (or alias) in the raw answer, case-insensitive, on word boundaries. */
export function mentionOffsets(raw: string, names: string[]): number[] {
  const lower = raw.toLowerCase();
  const out = new Set<number>();
  for (const n of names) {
    const variants = [...new Set([n.trim().toLowerCase(), normalizeQuery(n)])].filter((v) => v.length > 1);
    for (const v of variants) {
      const re = new RegExp(`(^|[^a-z0-9])(${esc(v)})(?=[^a-z0-9]|$)`, "g");
      for (const m of lower.matchAll(re)) out.add((m.index ?? 0) + m[1].length);
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** About `size` characters of the answer centred on `offset`, on word boundaries, with ellipses when cut. */
export function snippetAround(raw: string, offset: number, length: number, size = 200): string {
  const pad = Math.max(0, Math.floor((size - length) / 2));
  let start = Math.max(0, offset - pad);
  let end = Math.min(raw.length, offset + length + pad);
  if (start > 0) {
    const sp = raw.indexOf(" ", start);
    if (sp >= 0 && sp < offset) start = sp + 1;
  }
  if (end < raw.length) {
    const sp = raw.lastIndexOf(" ", end);
    if (sp > offset + length) end = sp;
  }
  const body = raw.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < raw.length ? "…" : ""}`;
}

/**
 * Objective parsing of one AI answer: which known entities appear, in what
 * order, and which URLs were cited. Position is only the order of first
 * appearance in the text: a measurable fact, not a claimed "ranking".
 */
export function analyzeAiResponse(response: string, citations: string[], products: EntityRef[], competitors: EntityRef[], orgNames: string[] = []): ResponseAnalysis {
  const text = normalizeQuery(response);
  const urlsInText = response.match(/https?:\/\/[^\s)\]>"']+/g) ?? [];
  const allCitations = [...new Set([...citations, ...urlsInText].map((u) => u.replace(/[.,;]+$/, "")))];
  const detected: { kind: "p" | "c"; id: string; name: string; idx: number; names: string[] }[] = [];
  for (const p of products) {
    const names = [p.name, ...(p.aliases ?? [])];
    const idx = firstIndex(text, names);
    if (idx >= 0) detected.push({ kind: "p", id: p.id, name: p.name, idx, names });
  }
  for (const c of competitors) {
    const names = [c.name, ...(c.aliases ?? [])];
    const idx = firstIndex(text, names);
    if (idx >= 0) detected.push({ kind: "c", id: c.id, name: c.name, idx, names });
  }
  detected.sort((a, b) => a.idx - b.idx);
  const ranked = detected.map((d, i) => {
    const offsets = mentionOffsets(response, d.names);
    const offset = offsets[0] ?? null;
    const matchLen = offset === null ? 0 : Math.max(...d.names.map((n) => (response.toLowerCase().startsWith(n.trim().toLowerCase(), offset) ? n.trim().length : 0)), d.name.length);
    return { ...d, position: i + 1, offset, offsets, snippet: offset === null ? null : snippetAround(response, offset, matchLen) };
  });
  const detail = (d: (typeof ranked)[number]): MentionDetail => ({ name: d.name, position: d.position, offset: d.offset, offsets: d.offsets, snippet: d.snippet });
  const ownDomains = products.map((p) => p.domain?.replace(/^https?:\/\//, "").replace(/\/.*$/, "").toLowerCase()).filter((d): d is string => Boolean(d));
  const ownDomainCited = allCitations.some((u) => {
    try {
      const h = new URL(u).hostname.toLowerCase();
      return ownDomains.some((d) => h === d || h.endsWith(`.${d}`));
    } catch {
      return false;
    }
  });
  const productsMentioned = ranked.filter((d) => d.kind === "p").map((d) => ({ productId: d.id, ...detail(d) }));
  return {
    productsMentioned,
    competitorsMentioned: ranked.filter((d) => d.kind === "c").map((d) => ({ competitorId: d.id, ...detail(d) })),
    citations: allCitations,
    ownDomainCited,
    orgMentioned: productsMentioned.length > 0 || firstIndex(text, orgNames) >= 0,
    position: productsMentioned[0]?.position ?? null,
  };
}
