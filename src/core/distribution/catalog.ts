/**
 * Well-known distribution venues suggested during onboarding. These are
 * suggestions only (status DISCOVERED) — a human qualifies relevance, and
 * nothing is ever submitted without approval.
 */
export const DISTRIBUTION_CATALOG: { kind: "DIRECTORY" | "LAUNCH_PLATFORM" | "COMMUNITY"; name: string; url: string; fit: "b2b" | "any" | "dev" }[] = [
  { kind: "LAUNCH_PLATFORM", name: "Product Hunt", url: "https://www.producthunt.com", fit: "any" },
  { kind: "DIRECTORY", name: "G2", url: "https://www.g2.com", fit: "b2b" },
  { kind: "DIRECTORY", name: "Capterra", url: "https://www.capterra.com", fit: "b2b" },
  { kind: "DIRECTORY", name: "AlternativeTo", url: "https://alternativeto.net", fit: "any" },
  { kind: "DIRECTORY", name: "SaaSHub", url: "https://www.saashub.com", fit: "any" },
  { kind: "COMMUNITY", name: "Hacker News (Show HN)", url: "https://news.ycombinator.com/show", fit: "dev" },
  { kind: "COMMUNITY", name: "Indie Hackers", url: "https://www.indiehackers.com", fit: "any" },
];

export const DISTRIBUTION_FLOW = ["DISCOVERED", "QUALIFIED", "PREPARED", "SUBMITTED", "PUBLISHED", "PERFORMING"] as const;

/** External submission states require an approval record first (no automated spam). */
export const REQUIRES_APPROVAL = new Set(["SUBMITTED", "PUBLISHED", "PERFORMING"]);
