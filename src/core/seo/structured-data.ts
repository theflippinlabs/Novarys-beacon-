/**
 * JSON-LD validation: parse each block, collect its @types (including @graph
 * members) and check the properties search engines require for the types
 * Beacon cares about. Pure.
 */
export type JsonLdResult = { valid: boolean; error?: string; types: string[]; missing: { type: string; property: string }[] };

type Obj = Record<string, unknown>;

const present = (v: unknown): boolean => {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0 && v.some(present);
  return true;
};

const typesOf = (o: Obj): string[] => {
  const t = o["@type"];
  return typeof t === "string" ? [t] : Array.isArray(t) ? t.map(String) : [];
};

/** Required properties per type (missing ones are reported). Values must be real; Beacon never suggests inventing them. */
export const REQUIRED_PROPERTIES: Record<string, (o: Obj) => string[]> = {
  Organization: (o) => ["name", "url"].filter((p) => !present(o[p])),
  Product: (o) => [...(present(o.name) ? [] : ["name"]), ...(present(o.offers) || present(o.review) || present(o.aggregateRating) ? [] : ["offers | review | aggregateRating"])],
  SoftwareApplication: (o) => ["name", "offers"].filter((p) => !present(o[p])),
  WebApplication: (o) => ["name", "offers"].filter((p) => !present(o[p])),
  MobileApplication: (o) => ["name", "offers"].filter((p) => !present(o[p])),
  FAQPage: (o) => {
    const items = Array.isArray(o.mainEntity) ? (o.mainEntity as Obj[]) : o.mainEntity ? [o.mainEntity as Obj] : [];
    if (!items.length) return ["mainEntity"];
    const bad = items.some((q) => !q || typeof q !== "object" || !present(q.name) || !present((q.acceptedAnswer as Obj | undefined)?.text));
    return bad ? ["mainEntity.name | acceptedAnswer.text"] : [];
  },
  Article: (o) => ["headline", "author", "datePublished"].filter((p) => !present(o[p])),
  BlogPosting: (o) => ["headline", "author", "datePublished"].filter((p) => !present(o[p])),
  NewsArticle: (o) => ["headline", "author", "datePublished"].filter((p) => !present(o[p])),
  BreadcrumbList: (o) => {
    const items = Array.isArray(o.itemListElement) ? (o.itemListElement as Obj[]) : [];
    if (!items.length) return ["itemListElement"];
    const bad = items.some((i) => !i || typeof i !== "object" || !present(i.position) || !(present(i.name) || present((i.item as Obj | undefined)?.name)));
    return bad ? ["itemListElement.position | name"] : [];
  },
};

export function validateJsonLd(raw: string): JsonLdResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    return { valid: false, error: (e as Error).message.slice(0, 200), types: [], missing: [] };
  }
  const types: string[] = [];
  const missing: JsonLdResult["missing"] = [];
  const visit = (d: unknown, depth: number) => {
    if (depth > 4) return;
    if (Array.isArray(d)) return d.forEach((x) => visit(x, depth));
    if (!d || typeof d !== "object") return;
    const o = d as Obj;
    const ts = typesOf(o);
    types.push(...ts);
    for (const t of ts) {
      const check = REQUIRED_PROPERTIES[t];
      if (check) for (const property of check(o)) missing.push({ type: t, property });
    }
    if (o["@graph"]) visit(o["@graph"], depth + 1);
  };
  visit(data, 0);
  return { valid: true, types, missing };
}
