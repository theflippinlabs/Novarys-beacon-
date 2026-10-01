import { normalizeQuery } from "@/core/util/text";
import type { AudienceTag, Venue } from "./venues";

/**
 * Relevance of a venue for a product (0 to 100) with the reason, computed
 * from the product's category, knowledge-graph facets (audiences, features,
 * integrations, use cases), its stage, and the sources AI answers cite for
 * its prompts (ai_citations). Pure and deterministic.
 */
export type ProductFit = {
  category: string | null;
  status: string;
  /** Free text of the product: descriptions, keywords. */
  texts: string[];
  /** Facet names by kind (AUDIENCE, FEATURE, INTEGRATION, USE_CASE, ...). */
  facets: { kind: string; name: string }[];
};

export type CitationSignal = { domain: string; samples: number };

const TAG_WORDS: Record<AudienceTag, string[]> = {
  b2b: ["b2b", "saas", "team", "teams", "business", "businesses", "company", "companies", "enterprise", "agency", "agencies", "workspace", "crm", "sales", "marketing", "startup", "startups"],
  b2c: ["consumer", "consumers", "personal", "family", "students", "shoppers", "fans", "viewers", "players"],
  dev: ["developer", "developers", "api", "sdk", "cli", "github", "devops", "engineering", "engineers", "code", "open source"],
  ai: ["ai", "llm", "gpt", "machine learning", "artificial intelligence", "generative", "chatbot", "agent", "agents"],
  open_source: ["open source", "open-source", "self-hosted", "mit license", "apache license"],
  service: ["agency services", "consulting", "consultancy", "done for you", "service provider", "freelance"],
  creator: ["creator", "creators", "influencer", "influencers", "streamer", "streamers", "youtuber", "tiktok"],
};

/** Audience tags of a product, from its category, texts and facets. */
export function audienceTags(p: ProductFit): AudienceTag[] {
  const hay = ` ${normalizeQuery([p.category ?? "", ...p.texts, ...p.facets.map((f) => f.name)].join(" "))} `;
  return (Object.keys(TAG_WORDS) as AudienceTag[]).filter((tag) => TAG_WORDS[tag].some((w) => hay.includes(` ${w} `)));
}

const PRE_LAUNCH = new Set(["UNKNOWN", "IN_DEVELOPMENT", "BETA"]);

export type Relevance = { score: number; reasons: string[]; applicable: boolean };

export function venueRelevance(v: Venue, p: ProductFit, citations: CitationSignal[] = []): Relevance {
  const reasons: string[] = [];
  const tags = audienceTags(p);
  const hay = ` ${normalizeQuery([p.category ?? "", ...p.texts, ...p.facets.map((f) => f.name)].join(" "))} `;
  let score = 30;
  let applicable = true;

  const matched = v.fit.audiences.filter((a): a is AudienceTag => a !== "any" && tags.includes(a));
  if (matched.length) {
    score += 30;
    reasons.push(`Audience match: ${matched.join(", ")}`);
  } else if (v.fit.audiences.includes("any")) {
    score += 15;
    reasons.push("General venue for any product");
  } else {
    score -= 20;
    reasons.push(`Serves ${v.fit.audiences.join(", ")} products; no match in the knowledge graph`);
  }

  if (v.fit.requires?.length) {
    const hit = v.fit.requires.find((r) => hay.includes(` ${r} `));
    if (hit) {
      score += 20;
      reasons.push(`The knowledge graph mentions ${hit}`);
    } else {
      applicable = false;
      score = Math.min(score, 10);
      reasons.push(`Requires ${v.fit.requires.join(" or ")}, not found in the knowledge graph`);
    }
  }

  const preLaunch = PRE_LAUNCH.has(p.status);
  if (v.fit.stages?.includes("LIVE") && preLaunch) {
    score -= 25;
    reasons.push("Suits live products; this product is not live yet");
  } else if (v.fit.stages?.includes("PRE_LAUNCH")) {
    if (preLaunch) {
      score += 10;
      reasons.push("Suits pre-launch products");
    } else {
      score -= 15;
      reasons.push("Suits pre-launch products; this product is already live");
    }
  }

  const cited = citations.filter((c) => v.domains.some((d) => c.domain === d || c.domain.endsWith(`.${d}`))).reduce((n, c) => n + c.samples, 0);
  if (cited > 0) {
    score += Math.min(25, 10 + cited * 5);
    reasons.push(`Cited as a source in ${cited} sampled AI answer(s)`);
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), reasons, applicable };
}

/** Venues seeded during product analysis must reach this relevance and apply to the product. */
export const SEED_RELEVANCE = 50;

export function rankVenues(venues: Venue[], p: ProductFit, citations: CitationSignal[] = []) {
  return venues
    .map((v) => ({ venue: v, ...venueRelevance(v, p, citations) }))
    .sort((a, b) => b.score - a.score || a.venue.name.localeCompare(b.venue.name));
}

export function seedableVenues(venues: Venue[], p: ProductFit, citations: CitationSignal[] = []) {
  return rankVenues(venues, p, citations).filter((r) => r.applicable && r.score >= SEED_RELEVANCE);
}

/** Stored reason text: the parts joined by " · " (each part is translated on display). */
export const REASON_SEPARATOR = " · ";
export const relevanceReasonText = (r: Relevance) => r.reasons.join(REASON_SEPARATOR);
