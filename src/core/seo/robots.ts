export type RobotsRules = { groups: { agents: string[]; allow: string[]; disallow: string[] }[]; sitemaps: string[] };

export function parseRobots(txt: string): RobotsRules {
  const groups: RobotsRules["groups"] = [];
  const sitemaps: string[] = [];
  let current: RobotsRules["groups"][number] | null = null;
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
  }
  return { groups, sitemaps };
}

function toRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp("^" + (escaped.endsWith("\\$") ? escaped.slice(0, -2) + "$" : escaped));
}

/** Longest-match semantics per RFC 9309. */
export function isAllowed(rules: RobotsRules, path: string, agent = "*"): boolean {
  const a = agent.toLowerCase();
  const group = rules.groups.find((g) => g.agents.some((x) => x !== "*" && a.includes(x))) ?? rules.groups.find((g) => g.agents.includes("*"));
  if (!group) return true;
  let best: { len: number; allow: boolean } = { len: -1, allow: true };
  for (const p of group.allow) if (p && toRegex(p).test(path) && p.length > best.len) best = { len: p.length, allow: true };
  for (const p of group.disallow) if (p && toRegex(p).test(path) && p.length > best.len) best = { len: p.length, allow: false };
  return best.allow;
}
