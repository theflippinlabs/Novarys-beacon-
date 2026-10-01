/**
 * Content formats: the single source of truth for every list, zod schema and
 * select in the app (actions, agent tools, pages). Mirrors the `content_type`
 * Postgres enum in src/db/schema.ts.
 */
export const CONTENT_TYPES = [
  "LANDING_PAGE",
  "ARTICLE",
  "FAQ",
  "TUTORIAL",
  "COMPARISON",
  "RELEASE_ANNOUNCEMENT",
  "X_POST",
  "LINKEDIN_POST",
  "TIKTOK_SCRIPT",
  "SHORT_VIDEO_SCRIPT",
  "NEWSLETTER",
  "DIRECTORY_DESCRIPTION",
  "OUTREACH",
] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];

/** English labels (translated in the UI through `t()`; enum keys go through `enumLabel`). */
export const CONTENT_TYPE_LABELS: Record<ContentType, string> = {
  LANDING_PAGE: "Landing page",
  ARTICLE: "Article",
  FAQ: "FAQ",
  TUTORIAL: "Tutorial",
  COMPARISON: "Comparison",
  RELEASE_ANNOUNCEMENT: "Release announcement",
  X_POST: "X post",
  LINKEDIN_POST: "LinkedIn post",
  TIKTOK_SCRIPT: "TikTok script",
  SHORT_VIDEO_SCRIPT: "Short video script",
  NEWSLETTER: "Newsletter",
  DIRECTORY_DESCRIPTION: "Directory description",
  OUTREACH: "Outreach",
};

/** Formats that can be drafted from an opportunity (they answer a search query). */
export const OPPORTUNITY_CONTENT_TYPES = ["LANDING_PAGE", "ARTICLE", "FAQ", "TUTORIAL", "COMPARISON"] as const satisfies readonly ContentType[];

/** Web formats: hosted pages that get the full SEO/GEO check. */
export const WEB_CONTENT_TYPES: ReadonlySet<ContentType> = new Set(["LANDING_PAGE", "ARTICLE", "TUTORIAL", "COMPARISON", "FAQ", "RELEASE_ANNOUNCEMENT"]);

/**
 * Derivatives that can be repurposed from an approved or published asset:
 * X post, LinkedIn post, TikTok script, short video script, newsletter block,
 * FAQ additions and a product update.
 */
export const REPURPOSE_TYPES = ["X_POST", "LINKEDIN_POST", "TIKTOK_SCRIPT", "SHORT_VIDEO_SCRIPT", "NEWSLETTER", "FAQ", "RELEASE_ANNOUNCEMENT"] as const satisfies readonly ContentType[];
export type RepurposeType = (typeof REPURPOSE_TYPES)[number];

export const REPURPOSE_LABELS: Record<RepurposeType, string> = {
  X_POST: "X post",
  LINKEDIN_POST: "LinkedIn post",
  TIKTOK_SCRIPT: "TikTok script",
  SHORT_VIDEO_SCRIPT: "Short video script",
  NEWSLETTER: "Newsletter block",
  FAQ: "FAQ additions",
  RELEASE_ANNOUNCEMENT: "Product update",
};

export const isContentType = (v: string): v is ContentType => (CONTENT_TYPES as readonly string[]).includes(v);
