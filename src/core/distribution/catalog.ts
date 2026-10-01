import { slugify } from "@/core/util/text";
import { VENUES, type DistributionCategory, type DistributionKind } from "./venues";

/**
 * Distribution: venue catalogue (venues.ts), the target state machine,
 * approval rules and UTM campaign helpers. Beacon never submits to a
 * third-party platform: SUBMITTED and later states are recorded by a person
 * after a recorded approval of the listing.
 */

/** Catalogue used to seed targets (fit-based, see relevance.ts). */
export const DISTRIBUTION_CATALOG = VENUES;

export const DISTRIBUTION_STATUSES = ["DISCOVERED", "QUALIFIED", "PREPARED", "SUBMITTED", "PUBLISHED", "PERFORMING", "FOLLOW_UP", "REJECTED"] as const;
export type DistributionStatus = (typeof DISTRIBUTION_STATUSES)[number];
export const DISTRIBUTION_FLOW = ["DISCOVERED", "QUALIFIED", "PREPARED", "SUBMITTED", "PUBLISHED", "PERFORMING"] as const;

/** Allowed transitions, enforced server-side (services/distribution.ts). */
export const DISTRIBUTION_NEXT: Record<DistributionStatus, readonly DistributionStatus[]> = {
  DISCOVERED: ["QUALIFIED", "REJECTED"],
  QUALIFIED: ["PREPARED", "DISCOVERED", "REJECTED"],
  PREPARED: ["SUBMITTED", "QUALIFIED", "REJECTED"],
  SUBMITTED: ["PUBLISHED", "FOLLOW_UP", "REJECTED"],
  FOLLOW_UP: ["SUBMITTED", "PUBLISHED", "REJECTED"],
  PUBLISHED: ["PERFORMING", "FOLLOW_UP"],
  PERFORMING: ["FOLLOW_UP"],
  REJECTED: ["DISCOVERED"],
};

/** External submission states require an approval record first (no automated spam). */
export const REQUIRES_APPROVAL: ReadonlySet<string> = new Set(["SUBMITTED", "PUBLISHED", "PERFORMING"]);

export function canMoveDistribution(from: DistributionStatus, to: DistributionStatus) {
  return DISTRIBUTION_NEXT[from]?.includes(to) ?? false;
}

export function assertDistributionTransition(from: DistributionStatus, to: DistributionStatus) {
  if (!canMoveDistribution(from, to)) throw new Error(`A target cannot move from ${from} to ${to}.`);
}

/** Going back before submission (or rejecting) resets the submission approval. */
export const resetsApproval = (to: DistributionStatus) => to === "DISCOVERED" || to === "QUALIFIED" || to === "REJECTED";

/** Listing formats an approval can be tied to. */
export const LISTING_ASSET_TYPES = ["DIRECTORY_DESCRIPTION", "OUTREACH"] as const;
export type ListingAssetType = (typeof LISTING_ASSET_TYPES)[number];

/** The listing draft format for a venue category: directory copy, or an outreach message. */
export function listingTypeFor(category: DistributionCategory | null | undefined): ListingAssetType {
  return category === "NEWSLETTER" || category === "PUBLICATION" || category === "CREATOR" || category === "AGENCY" || category === "PARTNER" ? "OUTREACH" : "DIRECTORY_DESCRIPTION";
}

/**
 * Is a recorded submission approval still valid? Only when it is tied to a
 * listing asset (directory description or outreach) whose approved version is
 * the one approved for the target, and the asset is still APPROVED or
 * PUBLISHED (editing it opens a new draft and invalidates the approval).
 */
export function approvalValid(
  t: { submissionApprovedAt: Date | null; approvedAssetId: string | null; approvedVersionId: string | null },
  asset: { id: string; type: string; status: string; approvedVersionId: string | null } | null | undefined,
): boolean {
  if (!t.submissionApprovedAt || !t.approvedAssetId || !asset) return false;
  if (asset.id !== t.approvedAssetId || !(LISTING_ASSET_TYPES as readonly string[]).includes(asset.type)) return false;
  if (asset.status !== "APPROVED" && asset.status !== "PUBLISHED") return false;
  return Boolean(asset.approvedVersionId) && asset.approvedVersionId === t.approvedVersionId;
}

/** Why a target cannot be approved yet (empty when it can). */
export function approvalBlockers(t: { status: string }, asset: { type: string; status: string; approvedVersionId: string | null } | null | undefined): string[] {
  const out: string[] = [];
  if (t.status !== "PREPARED") out.push("Approval is only possible once the target is PREPARED.");
  if (!asset) out.push("Prepare the listing draft first.");
  else if (!(LISTING_ASSET_TYPES as readonly string[]).includes(asset.type)) out.push("The linked asset must be a directory description or an outreach message.");
  else if ((asset.status !== "APPROVED" && asset.status !== "PUBLISHED") || !asset.approvedVersionId) out.push("The listing draft must be approved in the Content studio first.");
  return out;
}

const MEDIUM: Record<DistributionCategory, string> = {
  SOFTWARE_DIRECTORY: "directory",
  INDUSTRY_DIRECTORY: "directory",
  PRODUCT_DISCOVERY: "launch",
  REVIEW_PLATFORM: "review",
  DEVELOPER_COMMUNITY: "community",
  COMMUNITY: "community",
  NEWSLETTER: "newsletter",
  PUBLICATION: "pr",
  PARTNER: "partner",
  CREATOR: "creator",
  AGENCY: "agency",
};

const CHANNEL: Record<DistributionCategory, "REFERRAL" | "SOCIAL" | "EMAIL"> = {
  SOFTWARE_DIRECTORY: "REFERRAL",
  INDUSTRY_DIRECTORY: "REFERRAL",
  PRODUCT_DISCOVERY: "REFERRAL",
  REVIEW_PLATFORM: "REFERRAL",
  DEVELOPER_COMMUNITY: "SOCIAL",
  COMMUNITY: "SOCIAL",
  NEWSLETTER: "EMAIL",
  PUBLICATION: "REFERRAL",
  PARTNER: "REFERRAL",
  CREATOR: "SOCIAL",
  AGENCY: "REFERRAL",
};

export const utmMediumFor = (c: DistributionCategory | null | undefined) => MEDIUM[c ?? "SOFTWARE_DIRECTORY"];
export const channelFor = (c: DistributionCategory | null | undefined) => CHANNEL[c ?? "SOFTWARE_DIRECTORY"];
export const utmSourceFor = (name: string) => slugify(name).slice(0, 60) || "venue";

/** A per-target campaign name: dist-<venue>-<product>-<suffix> (lowercase, URL safe, unique per organisation with the suffix). */
export function utmCampaignFor(venueName: string, productSlug: string | null | undefined, suffix: string) {
  return ["dist", slugify(venueName).slice(0, 30), productSlug ? slugify(productSlug).slice(0, 30) : "ecosystem", suffix.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8)].filter(Boolean).join("-");
}

/** Tracking link: the destination URL with utm_source, utm_medium and utm_campaign (existing query parameters are kept). */
export function buildTrackingLink(destination: string, utm: { source: string; medium: string; campaign: string; content?: string | null }): string {
  const u = new URL(destination);
  u.searchParams.set("utm_source", utm.source);
  u.searchParams.set("utm_medium", utm.medium);
  u.searchParams.set("utm_campaign", utm.campaign);
  if (utm.content) u.searchParams.set("utm_content", utm.content);
  return u.toString();
}

/** Kind for a target added for a cited domain or a category (legacy `kind` column). */
export const KIND_FOR_CATEGORY: Record<DistributionCategory, DistributionKind> = {
  SOFTWARE_DIRECTORY: "DIRECTORY",
  INDUSTRY_DIRECTORY: "DIRECTORY",
  PRODUCT_DISCOVERY: "LAUNCH_PLATFORM",
  REVIEW_PLATFORM: "DIRECTORY",
  DEVELOPER_COMMUNITY: "COMMUNITY",
  COMMUNITY: "COMMUNITY",
  NEWSLETTER: "NEWSLETTER",
  PUBLICATION: "MEDIA",
  PARTNER: "PARTNER",
  CREATOR: "INFLUENCER",
  AGENCY: "AGENCY",
};

/** Category for a target created from its legacy kind. */
export const CATEGORY_FOR_KIND: Record<DistributionKind, DistributionCategory> = {
  DIRECTORY: "SOFTWARE_DIRECTORY",
  LAUNCH_PLATFORM: "PRODUCT_DISCOVERY",
  COMMUNITY: "COMMUNITY",
  SOCIAL_CHANNEL: "COMMUNITY",
  NEWSLETTER: "NEWSLETTER",
  PARTNER: "PARTNER",
  AFFILIATE: "PARTNER",
  INFLUENCER: "CREATOR",
  AGENCY: "AGENCY",
  MEDIA: "PUBLICATION",
  BACKLINK: "PUBLICATION",
};

/** Distribution category suggested by an AI citation source category (core/visibility/citations). */
export const CATEGORY_FOR_CITATION: Record<string, DistributionCategory> = { REVIEW_SITE: "REVIEW_PLATFORM", DIRECTORY: "SOFTWARE_DIRECTORY", COMMUNITY: "COMMUNITY", NEWS: "PUBLICATION" };
