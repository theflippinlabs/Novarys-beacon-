import * as cheerio from "cheerio";
import { parsePrice } from "@/core/knowledge/parse";
import { slugify } from "@/core/util/text";

/**
 * Website extraction for onboarding (pure, unit tested). Reads the homepage
 * and a few key pages fetched by the SSRF-safe crawler and proposes facts,
 * each tied to the URL it was read from. Nothing is invented: a value is
 * only proposed when it is literally present in the page (text, link or
 * JSON-LD); currency and billing interval are never guessed. Every proposal
 * is UNVERIFIED and needs a human to accept it.
 */
export type ProposalKind = "CLAIM" | "FACET" | "PRICING" | "SOCIAL" | "LOGO";
export type ExtractedProposal = {
  kind: ProposalKind;
  /** CLAIM: short_description, category, documentation_url or pricing_url; FACET: FEATURE; PRICING: plan; SOCIAL: network; LOGO: logo. */
  field: string;
  value: string;
  details: Record<string, string | number | null>;
  origin: "title" | "meta_description" | "og_description" | "h1" | "heading" | "json_ld" | "link";
  sourceUrl: string;
};

export type FetchedPage = { url: string; html: string };
export type KeyPageRole = "pricing" | "docs" | "features" | "about";

export const MAX_KEY_PAGES = 4;
const MAX_FEATURES = 12;
const MAX_TEXT = 300;

const SOCIAL_HOSTS: [RegExp, string][] = [
  [/(^|\.)(x|twitter)\.com$/, "x"],
  [/(^|\.)linkedin\.com$/, "linkedin"],
  [/(^|\.)github\.com$/, "github"],
  [/(^|\.)(youtube\.com|youtu\.be)$/, "youtube"],
  [/(^|\.)tiktok\.com$/, "tiktok"],
  [/(^|\.)instagram\.com$/, "instagram"],
  [/(^|\.)facebook\.com$/, "facebook"],
  [/(^|\.)discord\.(gg|com)$/, "discord"],
  [/(^|\.)threads\.net$/, "threads"],
  [/(^|\.)bsky\.app$/, "bluesky"],
];

/** Headings that name a page section, not a product capability. */
const GENERIC_HEADING =
  /^(features?|pricing|plans?|faq|frequently asked questions|contact( us)?|about( us)?|blog|news|testimonials?|customers?|get started|sign ?up|log ?in|newsletter|resources|company|product|legal|support|menu|navigation|footer|follow us|social|why .+\?|how it works|our (team|story|mission)|fonctionnalit[ée]s|tarifs|prix|contact|[àa] propos)$/i;

const ROLE_PATTERNS: Record<KeyPageRole, RegExp> = {
  pricing: /\/(pricing|plans|prices|tarifs|prix|abonnements?)(\/|$|\.html?$)/i,
  docs: /\/(docs?|documentation|developers?|api-docs|help|guides?)(\/|$|\.html?$)/i,
  features: /\/(features?|product|fonctionnalites|fonctionnalités)(\/|$|\.html?$)/i,
  about: /\/(about|about-us|company|a-propos)(\/|$|\.html?$)/i,
};

/** Normalise extracted text: collapse whitespace, drop control characters, no long dashes, capped length. */
export function cleanText(s: string | null | undefined, max = MAX_TEXT): string {
  const t = (s ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/(\d)\s*[\u2013\u2014]\s*(\d)/g, "$1-$2")
    .replace(/\s*[\u2013\u2014]\s*/g, ", ")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).trim();
}

function absolute(href: string | undefined, base: string): URL | null {
  if (!href) return null;
  try {
    const u = new URL(href.trim(), base);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    u.hash = "";
    return u;
  } catch {
    return null;
  }
}

const registrable = (host: string) => host.toLowerCase().replace(/^www\./, "").split(".").slice(-2).join(".");
const sameSite = (a: URL, b: URL) => registrable(a.hostname) === registrable(b.hostname);

/** Key pages linked from the homepage (same site only), at most one per role, in role order. */
export function findKeyPages(homeUrl: string, html: string): { role: KeyPageRole; url: string }[] {
  const $ = cheerio.load(html);
  const home = new URL(homeUrl);
  const found = new Map<KeyPageRole, string>();
  $("a[href]").each((_, el) => {
    const u = absolute($(el).attr("href"), homeUrl);
    if (!u || !sameSite(u, home)) return;
    const path = u.pathname;
    const text = cleanText($(el).text(), 60).toLowerCase();
    for (const role of Object.keys(ROLE_PATTERNS) as KeyPageRole[]) {
      if (found.has(role)) continue;
      const docsHost = role === "docs" && /^(docs|developers?|help)\./i.test(u.hostname);
      if (ROLE_PATTERNS[role].test(path) || docsHost || (role === "pricing" && /^(pricing|plans|tarifs)$/.test(text))) {
        u.search = "";
        found.set(role, u.toString());
        break;
      }
    }
  });
  return (["pricing", "docs", "features", "about"] as KeyPageRole[]).filter((r) => found.has(r)).map((role) => ({ role, url: found.get(role)! })).slice(0, MAX_KEY_PAGES);
}

type JsonObj = Record<string, unknown>;

/** Every JSON-LD object of the page (arrays and @graph flattened). Invalid blocks are ignored. */
export function jsonLdObjects(html: string): JsonObj[] {
  const $ = cheerio.load(html);
  const out: JsonObj[] = [];
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || !v) return;
    if (Array.isArray(v)) return v.forEach((x) => walk(x, depth + 1));
    if (typeof v !== "object") return;
    const o = v as JsonObj;
    out.push(o);
    if (Array.isArray(o["@graph"])) walk(o["@graph"], depth + 1);
  };
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      walk(JSON.parse($(el).contents().text()), 0);
    } catch {
      /* invalid JSON-LD is reported by the technical audit, not here */
    }
  });
  return out;
}

const types = (o: JsonObj): string[] => (Array.isArray(o["@type"]) ? (o["@type"] as unknown[]).map(String) : o["@type"] ? [String(o["@type"])] : []);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const httpsUrl = (v: unknown, base: string): string | null => {
  const raw = typeof v === "string" ? v : v && typeof v === "object" ? str((v as JsonObj).url) : null;
  const u = absolute(raw ?? undefined, base);
  return u && u.protocol === "https:" ? u.toString() : null;
};

function socialOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.pathname.replace(/\/+$/, "") === "") return null;
    if (/\/(share|intent|sharer)/i.test(u.pathname)) return null;
    const hit = SOCIAL_HOSTS.find(([re]) => re.test(u.hostname.toLowerCase()));
    return hit ? hit[1] : null;
  } catch {
    return null;
  }
}

const SOFTWARE_TYPES = ["SoftwareApplication", "WebApplication", "MobileApplication", "Product"];

/** Extract proposals from the fetched pages (the first page is the homepage). Deduplicated by kind, field and value. */
export function extractProposals(pages: FetchedPage[], roles: Partial<Record<KeyPageRole, string>> = {}): ExtractedProposal[] {
  const out: ExtractedProposal[] = [];
  const seen = new Set<string>();
  const add = (p: ExtractedProposal) => {
    if (!p.value) return;
    const key = `${p.kind}|${p.field}|${p.kind === "FACET" ? slugify(p.value) : p.value.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(p);
  };
  if (!pages.length) return out;
  const home = pages[0];

  for (const [i, page] of pages.entries()) {
    const $ = cheerio.load(page.html);
    const isHome = i === 0;
    const isFeatures = roles.features === page.url;
    if (isHome) {
      const title = cleanText($("head > title").first().text());
      if (title.length >= 10) add({ kind: "CLAIM", field: "short_description", value: title, details: {}, origin: "title", sourceUrl: page.url });
      const meta = cleanText($('meta[name="description"]').attr("content"));
      if (meta.length >= 20) add({ kind: "CLAIM", field: "short_description", value: meta, details: {}, origin: "meta_description", sourceUrl: page.url });
      const og = cleanText($('meta[property="og:description"]').attr("content"));
      if (og.length >= 20) add({ kind: "CLAIM", field: "short_description", value: og, details: {}, origin: "og_description", sourceUrl: page.url });
      const h1 = cleanText($("h1").first().text());
      if (h1.length >= 10) add({ kind: "CLAIM", field: "short_description", value: h1, details: {}, origin: "h1", sourceUrl: page.url });
    }

    // Section headings of the homepage and features page: candidate features with the paragraph that follows.
    if (isHome || isFeatures) {
      let n = out.filter((p) => p.kind === "FACET").length;
      $("h2, h3").each((_, el) => {
        if (n >= MAX_FEATURES) return false;
        const name = cleanText($(el).text(), 80);
        if (name.length < 3 || name.length > 80 || GENERIC_HEADING.test(name) || !slugify(name)) return;
        const next = $(el).nextAll("p").first();
        const description = cleanText(next.text(), MAX_TEXT) || null;
        add({ kind: "FACET", field: "FEATURE", value: name, details: { description }, origin: "heading", sourceUrl: page.url });
        n = out.filter((p) => p.kind === "FACET").length;
      });
    }

    // Links: pricing page, documentation, social accounts.
    $("a[href]").each((_, el) => {
      const u = absolute($(el).attr("href"), page.url);
      if (!u) return;
      const network = socialOf(u.toString());
      if (network) {
        u.search = "";
        add({ kind: "SOCIAL", field: network, value: u.toString(), details: {}, origin: "link", sourceUrl: page.url });
      }
    });

    for (const o of jsonLdObjects(page.html)) {
      const ts = types(o);
      if (ts.includes("Organization") || ts.includes("Corporation")) {
        const logo = httpsUrl(o.logo, page.url);
        if (logo) add({ kind: "LOGO", field: "logo", value: logo, details: {}, origin: "json_ld", sourceUrl: page.url });
        const sameAs = Array.isArray(o.sameAs) ? o.sameAs : o.sameAs ? [o.sameAs] : [];
        for (const s of sameAs) {
          const url = httpsUrl(s, page.url);
          const network = url ? socialOf(url) : null;
          if (url && network) add({ kind: "SOCIAL", field: network, value: url, details: {}, origin: "json_ld", sourceUrl: page.url });
        }
        const d = cleanText(str(o.description));
        if (d.length >= 20) add({ kind: "CLAIM", field: "short_description", value: d, details: {}, origin: "json_ld", sourceUrl: page.url });
      }
      if (ts.some((t) => SOFTWARE_TYPES.includes(t))) {
        const d = cleanText(str(o.description));
        if (d.length >= 20) add({ kind: "CLAIM", field: "short_description", value: d, details: {}, origin: "json_ld", sourceUrl: page.url });
        const cat = cleanText(str(o.applicationCategory), 120);
        if (cat.length >= 3) add({ kind: "CLAIM", field: "category", value: cat, details: {}, origin: "json_ld", sourceUrl: page.url });
        const featureList = Array.isArray(o.featureList) ? o.featureList.map(String) : str(o.featureList)?.split(/[,\n;]/) ?? [];
        for (const f of featureList.slice(0, MAX_FEATURES)) {
          const name = cleanText(f, 80);
          if (name.length >= 3 && slugify(name)) add({ kind: "FACET", field: "FEATURE", value: name, details: { description: null }, origin: "json_ld", sourceUrl: page.url });
        }
        const offers = Array.isArray(o.offers) ? o.offers : o.offers ? [o.offers] : [];
        for (const raw of offers.slice(0, 10)) {
          if (!raw || typeof raw !== "object") continue;
          const offer = raw as JsonObj;
          const name = cleanText(str(offer.name) ?? str(o.name) ?? "", 100);
          const priceCents = parsePrice(str(offer.price) ?? str(offer.lowPrice));
          const currency = /^[A-Z]{3}$/.test(str(offer.priceCurrency) ?? "") ? str(offer.priceCurrency) : null;
          if (!name) continue;
          // The interval is not part of schema.org Offer: it stays unknown for a human to give.
          add({ kind: "PRICING", field: "plan", value: name, details: { priceCents, currency, interval: null }, origin: "json_ld", sourceUrl: page.url });
        }
      }
    }
  }

  if (roles.pricing && new URL(roles.pricing).protocol === "https:") add({ kind: "CLAIM", field: "pricing_url", value: roles.pricing, details: {}, origin: "link", sourceUrl: home.url });
  if (roles.docs && new URL(roles.docs).protocol === "https:") add({ kind: "CLAIM", field: "documentation_url", value: roles.docs, details: {}, origin: "link", sourceUrl: home.url });
  return out;
}

/** Source kind recorded for a proposal's crawled URL when it is accepted. */
export function sourceKindFor(url: string, roles: Partial<Record<KeyPageRole, string>> = {}): "WEBSITE" | "PRICING" | "DOCUMENTATION" {
  if (roles.pricing === url || ROLE_PATTERNS.pricing.test(safePath(url))) return "PRICING";
  if (roles.docs === url || ROLE_PATTERNS.docs.test(safePath(url))) return "DOCUMENTATION";
  return "WEBSITE";
}

function safePath(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}
