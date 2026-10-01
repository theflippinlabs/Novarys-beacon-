/**
 * Distribution venue catalogue: legitimate, well-known venues per category,
 * each with its public URL and its listing requirements as published by the
 * venue. Beacon never scrapes or submits to them: a person prepares a listing
 * draft (approved by a human) and submits it themselves.
 *
 * `fit` drives relevance (core/distribution/relevance.ts): audience tags the
 * venue serves, optional keywords or integrations a product must mention,
 * and the product stage it suits.
 */
export type DistributionCategory =
  | "SOFTWARE_DIRECTORY"
  | "INDUSTRY_DIRECTORY"
  | "PRODUCT_DISCOVERY"
  | "REVIEW_PLATFORM"
  | "DEVELOPER_COMMUNITY"
  | "NEWSLETTER"
  | "PUBLICATION"
  | "PARTNER"
  | "CREATOR"
  | "AGENCY"
  | "COMMUNITY";

export const DISTRIBUTION_CATEGORIES: DistributionCategory[] = [
  "SOFTWARE_DIRECTORY",
  "INDUSTRY_DIRECTORY",
  "PRODUCT_DISCOVERY",
  "REVIEW_PLATFORM",
  "DEVELOPER_COMMUNITY",
  "NEWSLETTER",
  "PUBLICATION",
  "PARTNER",
  "CREATOR",
  "AGENCY",
  "COMMUNITY",
];

export type DistributionKind = "DIRECTORY" | "LAUNCH_PLATFORM" | "COMMUNITY" | "SOCIAL_CHANNEL" | "NEWSLETTER" | "PARTNER" | "AFFILIATE" | "INFLUENCER" | "AGENCY" | "MEDIA" | "BACKLINK";

/** Audience tags derived from the product's knowledge graph (see relevance.ts). */
export type AudienceTag = "b2b" | "b2c" | "dev" | "ai" | "open_source" | "service" | "creator";

export type Venue = {
  key: string;
  name: string;
  url: string;
  kind: DistributionKind;
  category: DistributionCategory;
  /** What the venue asks for, in plain words (from its public submission or vendor pages). */
  requirements: string;
  fit: {
    /** Audiences the venue serves; "any" suits every product. */
    audiences: (AudienceTag | "any")[];
    /** The product must mention one of these (feature, integration, category or keyword) for the venue to apply. */
    requires?: string[];
    /** Product stages the venue suits (default: any). */
    stages?: ("PRE_LAUNCH" | "LIVE")[];
  };
  /** Registrable domains of the venue (matched against AI citation sources). */
  domains: string[];
};

export const VENUES: Venue[] = [
  // Software directories
  { key: "alternativeto", name: "AlternativeTo", url: "https://alternativeto.net", kind: "DIRECTORY", category: "SOFTWARE_DIRECTORY", requirements: "Free listing: name, description, platforms, license and alternatives; community moderated.", fit: { audiences: ["any"] }, domains: ["alternativeto.net"] },
  { key: "saashub", name: "SaaSHub", url: "https://www.saashub.com", kind: "DIRECTORY", category: "SOFTWARE_DIRECTORY", requirements: "Free listing after a review: website, description, category and a verified contact.", fit: { audiences: ["b2b", "dev", "ai"] }, domains: ["saashub.com"] },
  { key: "sourceforge", name: "SourceForge business software", url: "https://sourceforge.net/software/", kind: "DIRECTORY", category: "SOFTWARE_DIRECTORY", requirements: "Free vendor profile through the vendor portal: description, features, pricing and screenshots.", fit: { audiences: ["b2b"] }, domains: ["sourceforge.net"] },
  { key: "stackshare", name: "StackShare", url: "https://stackshare.io", kind: "DIRECTORY", category: "SOFTWARE_DIRECTORY", requirements: "Developer tools only: tool page with description, category and integrations.", fit: { audiences: ["dev"] }, domains: ["stackshare.io"] },
  { key: "theresanaiforthat", name: "There's An AI For That", url: "https://theresanaiforthat.com", kind: "DIRECTORY", category: "SOFTWARE_DIRECTORY", requirements: "AI tools only: submission with use case, pricing model and a working product.", fit: { audiences: ["ai"] }, domains: ["theresanaiforthat.com"] },
  // Review platforms
  { key: "g2", name: "G2", url: "https://www.g2.com", kind: "DIRECTORY", category: "REVIEW_PLATFORM", requirements: "Free vendor profile for B2B software; reviews come from verified users (never incentivised without disclosure).", fit: { audiences: ["b2b"], stages: ["LIVE"] }, domains: ["g2.com"] },
  { key: "capterra", name: "Capterra", url: "https://www.capterra.com", kind: "DIRECTORY", category: "REVIEW_PLATFORM", requirements: "Free basic listing through the Gartner Digital Markets vendor portal: B2B software with a public website and pricing information.", fit: { audiences: ["b2b"], stages: ["LIVE"] }, domains: ["capterra.com", "getapp.com", "softwareadvice.com"] },
  { key: "trustradius", name: "TrustRadius", url: "https://www.trustradius.com", kind: "DIRECTORY", category: "REVIEW_PLATFORM", requirements: "Free vendor profile for B2B software; reviews are verified before publication.", fit: { audiences: ["b2b"], stages: ["LIVE"] }, domains: ["trustradius.com"] },
  { key: "trustpilot", name: "Trustpilot", url: "https://www.trustpilot.com", kind: "DIRECTORY", category: "REVIEW_PLATFORM", requirements: "Free business profile; invite real customers only and follow the review guidelines.", fit: { audiences: ["b2c", "creator"], stages: ["LIVE"] }, domains: ["trustpilot.com"] },
  // Product discovery
  { key: "producthunt", name: "Product Hunt", url: "https://www.producthunt.com", kind: "LAUNCH_PLATFORM", category: "PRODUCT_DISCOVERY", requirements: "Maker account, tagline, gallery images and a first comment; a working product; no vote solicitation.", fit: { audiences: ["any"] }, domains: ["producthunt.com"] },
  { key: "betalist", name: "BetaList", url: "https://betalist.com", kind: "LAUNCH_PLATFORM", category: "PRODUCT_DISCOVERY", requirements: "Pre-launch or recently launched startups; free submission with a review queue.", fit: { audiences: ["any"], stages: ["PRE_LAUNCH"] }, domains: ["betalist.com"] },
  { key: "launchingnext", name: "Launching Next", url: "https://www.launchingnext.com", kind: "LAUNCH_PLATFORM", category: "PRODUCT_DISCOVERY", requirements: "Free startup submission: name, URL, short description and launch stage.", fit: { audiences: ["any"] }, domains: ["launchingnext.com"] },
  // Developer communities
  { key: "showhn", name: "Hacker News (Show HN)", url: "https://news.ycombinator.com/showhn.html", kind: "COMMUNITY", category: "DEVELOPER_COMMUNITY", requirements: "Something people can try now (no sign-up walls or landing pages only); follow the Show HN guidelines.", fit: { audiences: ["dev", "open_source", "ai"], stages: ["LIVE"] }, domains: ["ycombinator.com"] },
  { key: "devto", name: "DEV Community", url: "https://dev.to", kind: "COMMUNITY", category: "DEVELOPER_COMMUNITY", requirements: "Useful technical articles; disclose affiliation; promotional-only posts are discouraged.", fit: { audiences: ["dev", "open_source"] }, domains: ["dev.to"] },
  { key: "awesome-lists", name: "Awesome lists on GitHub", url: "https://github.com/sindresorhus/awesome", kind: "BACKLINK", category: "DEVELOPER_COMMUNITY", requirements: "Pull request to a relevant list, following that list's contribution guidelines; usually open source or developer tools.", fit: { audiences: ["dev", "open_source"] }, domains: ["github.com"] },
  // Communities
  { key: "indiehackers", name: "Indie Hackers", url: "https://www.indiehackers.com", kind: "COMMUNITY", category: "COMMUNITY", requirements: "Product page and milestone posts; self-promotion only where the community allows it.", fit: { audiences: ["any"] }, domains: ["indiehackers.com"] },
  { key: "reddit", name: "Reddit (relevant subreddits)", url: "https://www.reddit.com", kind: "COMMUNITY", category: "COMMUNITY", requirements: "Follow each subreddit's self-promotion rules; disclose that you work on the product.", fit: { audiences: ["any"] }, domains: ["reddit.com"] },
  // Newsletters
  { key: "tldr", name: "TLDR newsletters", url: "https://tldr.tech", kind: "NEWSLETTER", category: "NEWSLETTER", requirements: "Editorial selection or a clearly labelled sponsorship; tech and developer audiences.", fit: { audiences: ["dev", "ai", "b2b"] }, domains: ["tldr.tech"] },
  { key: "console", name: "Console (developer tools newsletter)", url: "https://console.dev", kind: "NEWSLETTER", category: "NEWSLETTER", requirements: "Developer tools reviewed by the editors; submit the tool for consideration.", fit: { audiences: ["dev", "open_source"] }, domains: ["console.dev"] },
  { key: "bensbites", name: "Ben's Bites", url: "https://www.bensbites.com", kind: "NEWSLETTER", category: "NEWSLETTER", requirements: "AI products and news; editorial picks or labelled sponsorships.", fit: { audiences: ["ai"] }, domains: ["bensbites.com", "bensbites.co"] },
  // Publications
  { key: "hackernoon", name: "HackerNoon", url: "https://hackernoon.com", kind: "MEDIA", category: "PUBLICATION", requirements: "Original story submitted for editorial review; disclose any conflict of interest.", fit: { audiences: ["dev", "ai", "b2b"] }, domains: ["hackernoon.com"] },
  { key: "techcrunch", name: "TechCrunch (news tips)", url: "https://techcrunch.com/got-a-tip/", kind: "MEDIA", category: "PUBLICATION", requirements: "Real news only (launch, funding, notable milestone) pitched to the right reporter; coverage is never guaranteed.", fit: { audiences: ["any"], stages: ["LIVE"] }, domains: ["techcrunch.com"] },
  // Industry directories
  { key: "crunchbase", name: "Crunchbase", url: "https://www.crunchbase.com", kind: "DIRECTORY", category: "INDUSTRY_DIRECTORY", requirements: "Free company profile; keep every fact accurate and verifiable.", fit: { audiences: ["any"] }, domains: ["crunchbase.com"] },
  { key: "wellfound", name: "Wellfound (startup directory)", url: "https://wellfound.com", kind: "DIRECTORY", category: "INDUSTRY_DIRECTORY", requirements: "Free startup profile with team, stage and market.", fit: { audiences: ["b2b", "dev", "ai"] }, domains: ["wellfound.com", "angel.co"] },
  // Partners and marketplaces (require a real integration)
  { key: "zapier", name: "Zapier App Directory", url: "https://zapier.com/apps", kind: "PARTNER", category: "PARTNER", requirements: "A published Zapier integration that passes Zapier's review.", fit: { audiences: ["any"], requires: ["zapier"] }, domains: ["zapier.com"] },
  { key: "slack", name: "Slack Marketplace", url: "https://slack.com/marketplace", kind: "PARTNER", category: "PARTNER", requirements: "A Slack app that passes Slack's marketplace review and security requirements.", fit: { audiences: ["any"], requires: ["slack"] }, domains: ["slack.com"] },
  { key: "shopify", name: "Shopify App Store", url: "https://apps.shopify.com", kind: "PARTNER", category: "PARTNER", requirements: "A Shopify app that meets the App Store requirements and passes review.", fit: { audiences: ["any"], requires: ["shopify"] }, domains: ["shopify.com"] },
  // Creators and agencies
  { key: "youtube-creators", name: "YouTube creators in your niche", url: "https://www.youtube.com", kind: "INFLUENCER", category: "CREATOR", requirements: "Contact creators individually through their published business email; any sponsorship must be disclosed.", fit: { audiences: ["b2c", "creator"] }, domains: ["youtube.com"] },
  { key: "clutch", name: "Clutch", url: "https://clutch.co", kind: "AGENCY", category: "AGENCY", requirements: "For agencies and service providers: free profile with verified client reviews.", fit: { audiences: ["service"] }, domains: ["clutch.co"] },
];

export const venueByKey = (key: string | null | undefined) => (key ? VENUES.find((v) => v.key === key) : undefined);
