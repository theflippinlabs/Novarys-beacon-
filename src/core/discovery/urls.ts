import { slugify } from "@/core/util/text";

export type PageType =
  | "PRODUCT"
  | "FEATURE"
  | "USE_CASE"
  | "INDUSTRY"
  | "AUDIENCE"
  | "INTEGRATION"
  | "COMPARISON"
  | "ALTERNATIVE"
  | "GUIDE"
  | "ANSWER"
  | "DOCS"
  | "CHANGELOG"
  | "OTHER";

const SEGMENT: Partial<Record<PageType, string>> = {
  FEATURE: "features",
  USE_CASE: "use-cases",
  INDUSTRY: "industries",
  AUDIENCE: "for",
  INTEGRATION: "integrations",
  COMPARISON: "compare",
  ALTERNATIVE: "alternatives",
};

/** Canonical URL path for a discovery page. Paths are lowercase, hyphenated, and stable. */
export function pagePath(type: PageType, productSlug: string, item?: string): string {
  const p = slugify(productSlug);
  const s = item ? slugify(item) : "";
  switch (type) {
    case "PRODUCT":
      return `/${p}`;
    case "GUIDE":
      return `/guides/${s}`;
    case "ANSWER":
      return `/answers/${s}`;
    case "DOCS":
      return `/docs/${p}${s ? `/${s}` : ""}`;
    case "CHANGELOG":
      return `/changelog/${p}${s ? `/${s}` : ""}`;
    case "OTHER":
      return `/${p}/${s}`;
    default: {
      const seg = SEGMENT[type];
      if (!s) throw new Error(`${type} pages require an item slug`);
      return `/${p}/${seg}/${s}`;
    }
  }
}

/** Absolute canonical URL on the product's own domain (when known). */
export function canonicalUrl(domain: string | null | undefined, path: string): string | null {
  if (!domain) return null;
  const host = domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  return `https://${host}${path === "/" ? "" : path}`;
}

export function withTracking(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) if (v && !u.searchParams.has(k)) u.searchParams.set(k, v);
  return u.toString();
}
