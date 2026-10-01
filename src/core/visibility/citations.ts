/**
 * Citation classification for sampled AI answers. Pure and deterministic.
 *
 * Registrable domain: the last two host labels, or three when the second-level
 * label is a common generic second level under a country code (co.uk,
 * com.au, org.br...). This is a documented heuristic, not the full Public
 * Suffix List.
 *
 * Kind: OWN when the host is (a subdomain of) one of the organisation's
 * product domains, COMPETITOR for a registered competitor domain, otherwise
 * THIRD_PARTY.
 *
 * Category guess, first match wins:
 * 1. OWN / COMPETITOR: DOCUMENTATION for docs, developer, help, support, kb
 *    or learn subdomains or /docs, /documentation, /help paths; otherwise
 *    OFFICIAL_SITE.
 * 2. Known review sites (G2, Capterra, Trustpilot...): REVIEW_SITE.
 * 3. Known directories and app stores (Product Hunt, AlternativeTo...): DIRECTORY.
 * 4. Known communities (Reddit, Quora, Stack Overflow, GitHub, YouTube...): COMMUNITY.
 * 5. Known news publishers or a news. subdomain: NEWS.
 * 6. "vs", "versus", "alternative", "compare", "comparison" or "/best-" in the URL: COMPARISON.
 * 7. A documentation-style subdomain of a third party: DOCUMENTATION.
 * 8. OTHER.
 * The SQL backfill in migration 0011 mirrors these lists; keep them in sync.
 */
export type CitationKind = "OWN" | "COMPETITOR" | "THIRD_PARTY";
export type CitationCategory = "OFFICIAL_SITE" | "DOCUMENTATION" | "REVIEW_SITE" | "DIRECTORY" | "NEWS" | "COMMUNITY" | "COMPARISON" | "OTHER";

export const REVIEW_SITES = ["g2.com", "capterra.com", "trustpilot.com", "getapp.com", "softwareadvice.com", "trustradius.com", "gartner.com", "peerspot.com", "sitejabber.com"];
export const DIRECTORIES = ["producthunt.com", "alternativeto.net", "saashub.com", "crunchbase.com", "sourceforge.net", "slant.co", "stackshare.io", "futurepedia.io", "theresanaiforthat.com", "toolify.ai"];
export const DIRECTORY_HOSTS = ["apps.apple.com", "play.google.com", "chromewebstore.google.com", "marketplace.visualstudio.com"];
export const COMMUNITIES = ["reddit.com", "quora.com", "stackoverflow.com", "stackexchange.com", "ycombinator.com", "medium.com", "dev.to", "github.com", "youtube.com", "x.com", "twitter.com", "linkedin.com", "facebook.com", "discord.com", "indiehackers.com", "substack.com"];
export const NEWS_SITES = ["techcrunch.com", "theverge.com", "forbes.com", "reuters.com", "bloomberg.com", "wired.com", "venturebeat.com", "businessinsider.com", "zdnet.com", "cnet.com", "engadget.com", "bbc.co.uk", "bbc.com", "nytimes.com", "theguardian.com", "lemonde.fr", "lesechos.fr"];

const DOC_HOST = /^(docs|developers?|help|support|kb|learn)\./;
const DOC_PATH = /\/(docs|documentation|help)(\/|$|\?|#)/i;
const COMPARISON_URL = /(-vs-|\/vs\/|[-/_]versus[-/_]|alternative|compare|comparison|\/best-)/;

export function hostOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export function registrableDomain(host: string): string {
  const h = host.toLowerCase().replace(/^www\./, "");
  const m3 = /([^.]+\.(?:co|com|org|net|gov|ac|edu)\.[a-z]{2})$/.exec(h);
  if (m3) return m3[1];
  const m2 = /([^.]+\.[^.]+)$/.exec(h);
  return m2 ? m2[1] : h;
}

/** Bare host of a configured domain ("https://www.acme.io/x" becomes "acme.io"). */
export function bareDomain(d: string | null | undefined): string | null {
  if (!d) return null;
  const h = d.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "").replace(/^www\./, "");
  return h || null;
}

const onDomain = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export type DomainRef = { id: string; domain: string | null | undefined };

export type ClassifiedCitation = {
  url: string;
  host: string;
  registrableDomain: string;
  kind: CitationKind;
  category: CitationCategory;
  productId: string | null;
  competitorId: string | null;
};

export function classifyCitation(url: string, ctx: { products: DomainRef[]; competitors: DomainRef[] }): ClassifiedCitation | null {
  const host = hostOf(url);
  if (!host) return null;
  const reg = registrableDomain(host);
  const own = ctx.products.find((p) => {
    const d = bareDomain(p.domain);
    return d ? onDomain(host, d) : false;
  });
  const comp = own
    ? undefined
    : ctx.competitors.find((c) => {
        const d = bareDomain(c.domain);
        return d ? onDomain(host, d) : false;
      });
  const kind: CitationKind = own ? "OWN" : comp ? "COMPETITOR" : "THIRD_PARTY";
  const lower = url.toLowerCase();
  let category: CitationCategory;
  if (kind !== "THIRD_PARTY") category = DOC_HOST.test(host) || DOC_PATH.test(url) ? "DOCUMENTATION" : "OFFICIAL_SITE";
  else if (REVIEW_SITES.includes(reg)) category = "REVIEW_SITE";
  else if (DIRECTORIES.includes(reg) || DIRECTORY_HOSTS.includes(host)) category = "DIRECTORY";
  else if (COMMUNITIES.includes(reg)) category = "COMMUNITY";
  else if (NEWS_SITES.includes(reg) || /^news\./.test(host)) category = "NEWS";
  else if (COMPARISON_URL.test(lower)) category = "COMPARISON";
  else if (DOC_HOST.test(host)) category = "DOCUMENTATION";
  else category = "OTHER";
  return { url, host, registrableDomain: reg, kind, category, productId: own?.id ?? null, competitorId: comp?.id ?? null };
}

/**
 * Entities mentioned close to where a source is cited: within `window`
 * characters of any offset at which the citation is referenced in the answer
 * (inline URL, numbered marker or provider annotation). Without offsets the
 * proximity is unknown and nothing is associated.
 */
export function entitiesNear(citationOffsets: number[], mentions: { id: string; offsets: number[] }[], window = 300): string[] {
  if (!citationOffsets.length) return [];
  return mentions.filter((m) => m.offsets.some((o) => citationOffsets.some((c) => Math.abs(c - o) <= window))).map((m) => m.id);
}

/** Character offsets at which each citation is referenced: inline URLs and numbered markers like [1] (1-based list position). */
export function citationOffsets(text: string, url: string, position: number, known: number[] = []): number[] {
  const out = new Set(known);
  let i = text.indexOf(url);
  while (i >= 0) {
    out.add(i);
    i = text.indexOf(url, i + url.length);
  }
  const re = new RegExp(`\\[${position}\\]`, "g");
  for (const m of text.matchAll(re)) out.add(m.index ?? 0);
  return [...out].sort((a, b) => a - b);
}
