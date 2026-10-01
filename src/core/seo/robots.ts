export type RobotsGroup = { agents: string[]; allow: string[]; disallow: string[]; crawlDelay?: number };
export type RobotsRules = { groups: RobotsGroup[]; sitemaps: string[] };

/** Beacon's own robots.txt product token (matched case-insensitively, "*" is the fallback). */
export const BEACON_ROBOTS_TOKEN = "NovarysBeacon";
/** Agent used for the search-engine perspective (site rules such as "robots blocks the site"). */
export const SEARCH_ENGINE_TOKEN = "Googlebot";

export const DEFAULT_CRAWL_DELAY_MS = 200;
export const MAX_CRAWL_DELAY_MS = 10_000;

export function parseRobots(txt: string): RobotsRules {
  const groups: RobotsRules["groups"] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], allow: [], disallow: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") sitemaps.push(value);
    else if (current && key === "allow") current.allow.push(value);
    else if (current && key === "disallow") current.disallow.push(value);
    else if (current && key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n) && n >= 0) current.crawlDelay = n;
    }
  }
  return { groups, sitemaps };
}

function toRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + (escaped.endsWith("\\$") ? escaped.slice(0, -2) + "$" : escaped));
}

/** The group that applies to an agent: the most specific (longest) matching token, else "*". */
export function selectGroup(rules: RobotsRules, agent = "*"): RobotsGroup | undefined {
  const a = agent.toLowerCase();
  let group: RobotsGroup | undefined;
  let bestLen = 0;
  for (const g of rules.groups)
    for (const x of g.agents)
      if (x !== "*" && x && a.includes(x) && x.length > bestLen) {
        group = g;
        bestLen = x.length;
      }
  return group ?? rules.groups.find((g) => g.agents.includes("*"));
}

/** Longest-match semantics per RFC 9309. */
export function isAllowed(rules: RobotsRules, path: string, agent = "*"): boolean {
  const group = selectGroup(rules, agent);
  if (!group) return true;
  let best: { len: number; allow: boolean } = { len: -1, allow: true };
  for (const p of group.allow) if (p && toRegex(p).test(path) && p.length > best.len) best = { len: p.length, allow: true };
  for (const p of group.disallow) if (p && toRegex(p).test(path) && p.length > best.len) best = { len: p.length, allow: false };
  return best.allow;
}

/** Delay between requests: the group's Crawl-delay (capped at 10 s), never below the default politeness delay. */
export function crawlDelayMs(rules: RobotsRules | null, agent = BEACON_ROBOTS_TOKEN, defaultMs = DEFAULT_CRAWL_DELAY_MS): number {
  const d = rules ? selectGroup(rules, agent)?.crawlDelay : undefined;
  if (d === undefined) return defaultMs;
  return Math.max(defaultMs, Math.min(MAX_CRAWL_DELAY_MS, Math.round(d * 1000)));
}

/**
 * How to treat a robots.txt response (RFC 9309 §2.3.1): 2xx parse it,
 * 4xx means no restrictions, 5xx / 429 / network failure means the whole
 * site is disallowed.
 */
export function robotsPolicy(status: number | null): "PARSE" | "ALLOW_ALL" | "DISALLOW_ALL" {
  if (status === null) return "DISALLOW_ALL";
  if (status >= 200 && status < 300) return "PARSE";
  if (status === 429) return "DISALLOW_ALL";
  if (status >= 400 && status < 500) return "ALLOW_ALL";
  return "DISALLOW_ALL";
}

/** Path + query used for matching. */
export function robotsPath(url: string): string {
  const u = new URL(url);
  return u.pathname + u.search;
}
