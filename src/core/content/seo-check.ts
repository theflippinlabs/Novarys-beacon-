import { tokens } from "@/core/util/text";
import { EDITOR_TODO } from "./markers";
import { WEB_CONTENT_TYPES as WEB_TYPES, type ContentType } from "./types";

export type SeoCheck = { rule: string; ok: boolean; message: string };

/** Share of the target query's terms that appear in `text` (the `query_in_title` rule needs 50%). */
export function queryTermCoverage(query: string, text: string): number {
  const q = tokens(query);
  const head = text.toLowerCase();
  return q.length ? q.filter((t) => head.includes(t)).length / q.length : 1;
}

const MIN_WORDS: Partial<Record<ContentType, number>> = { LANDING_PAGE: 250, ARTICLE: 400, TUTORIAL: 300, COMPARISON: 200, FAQ: 150 };

/** On-page SEO/GEO checks for a draft. Social formats only get length and TODO checks. */
export function seoCheck(input: { type: ContentType; body: string; metaTitle: string | null; metaDescription: string | null; targetQuery?: string | null; structuredData: unknown[]; brandTerms?: string[] }): { passed: boolean; checks: SeoCheck[] } {
  const checks: SeoCheck[] = [];
  const add = (rule: string, ok: boolean, message: string) => checks.push({ rule, ok, message });
  const body = input.body;

  add("no_editor_todos", !body.includes(EDITOR_TODO), body.includes(EDITOR_TODO) ? "Resolve editor TODO markers before approval." : "No unresolved editor TODOs.");

  if (input.type === "X_POST") add("length", body.trim().length <= 280, `${body.trim().length}/280 characters.`);

  if (WEB_TYPES.has(input.type)) {
    const h1 = body.match(/^# .+$/gm) ?? [];
    add("single_h1", h1.length === 1, `${h1.length} H1 heading(s).`);
    add("has_sections", (body.match(/^## .+$/gm) ?? []).length >= 2, "At least two H2 sections structure the page for readers and answer engines.");
    const tl = input.metaTitle?.length ?? 0;
    add("meta_title", tl >= 15 && tl <= 65, input.metaTitle ? `Meta title ${tl} chars (15 to 65).` : "Missing meta title.");
    const dl = input.metaDescription?.length ?? 0;
    add("meta_description", dl >= 50 && dl <= 160, input.metaDescription ? `Meta description ${dl} chars (50 to 160).` : "Missing meta description.");
    const words = body.split(/\s+/).filter(Boolean).length;
    const min = MIN_WORDS[input.type] ?? 120;
    add("depth", words >= min, `${words} words (minimum ${min} for this format).`);
    add("structured_data", input.structuredData.length > 0 || input.type === "RELEASE_ANNOUNCEMENT", input.structuredData.length ? `${input.structuredData.length} JSON-LD block(s).` : "No structured data.");
    add("sources_cited", /^## Sources$/m.test(body), "Sources section present so answer engines can verify claims.");
    if (input.targetQuery) {
      const q = tokens(input.targetQuery);
      const coverage = queryTermCoverage(input.targetQuery, `${input.metaTitle ?? ""} ${h1[0] ?? ""}`);
      add("query_in_title", coverage >= 0.5, `${Math.round(coverage * 100)}% of target query terms in title/H1.`);
      // Brand/product-name terms naturally repeat on their own page; stuffing is measured on the other terms.
      const brand = new Set((input.brandTerms ?? []).flatMap((b) => tokens(b)));
      const bt = tokens(body, { keepStop: true });
      const nonBrand = q.filter((t) => !brand.has(t));
      const density = nonBrand.length ? Math.max(...nonBrand.map((t) => bt.filter((x) => x === t).length / Math.max(1, bt.length))) : 0;
      add("no_keyword_stuffing", density <= 0.04, `Max target-term density ${(density * 100).toFixed(1)}% (≤ 4%).`);
    }
  }
  return { passed: checks.every((c) => c.ok), checks };
}
