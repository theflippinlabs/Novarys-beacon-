import { slugify } from "@/core/util/text";

/**
 * Parsers for the onboarding wizard's line-based inputs. Each line is one
 * item; fields are separated by " | " (or a spaced dash for name/description).
 */
export function splitLines(text: string | null | undefined, max = 200): string[] {
  return (text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(0, max);
}

function splitFields(line: string): string[] {
  if (line.includes("|")) return line.split("|").map((s) => s.trim());
  const m = line.split(/\s+[\u2014\u2013]\s+|\s+-\s+/);
  return m.length > 1 ? [m[0].trim(), m.slice(1).join(" - ").trim()] : [line.trim()];
}

export function parseNamed(text: string | null | undefined): { name: string; slug: string; description: string | null }[] {
  const seen = new Set<string>();
  const out: { name: string; slug: string; description: string | null }[] = [];
  for (const line of splitLines(text)) {
    const [name, description] = splitFields(line);
    const slug = slugify(name);
    if (!name || !slug || seen.has(slug) || name.length > 200) continue;
    seen.add(slug);
    out.push({ name, slug, description: description?.slice(0, 2000) || null });
  }
  return out;
}

export const INTERVALS = ["ONE_TIME", "MONTH", "YEAR", "USAGE", "CUSTOM"] as const;

/** "Plan | price | currency | interval | trial days | description": blank price means unknown/not public. */
export function parsePricing(text: string | null | undefined) {
  return splitLines(text, 20).map((line, i) => {
    const [planName, price, currency, interval, trial, description] = line.split("|").map((s) => s?.trim() ?? "");
    const p = price ? Number(price.replace(/[^\d.]/g, "")) : NaN;
    const iv = (interval || "MONTH").toUpperCase();
    return {
      planName: planName.slice(0, 100),
      priceCents: Number.isFinite(p) ? Math.round(p * 100) : null,
      currency: /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : "EUR",
      interval: (INTERVALS as readonly string[]).includes(iv) ? (iv as (typeof INTERVALS)[number]) : "MONTH",
      trialDays: trial && /^\d+$/.test(trial) ? Number(trial) : null,
      description: description || null,
      sortOrder: i,
    };
  }).filter((p) => p.planName);
}

export const SOURCE_KINDS = ["WEBSITE", "DOCUMENTATION", "PRICING", "CHANGELOG", "CASE_STUDY", "PRESS", "REPOSITORY", "LEGAL", "OTHER"] as const;
export const CTA_KINDS = ["TRY_FREE", "START_NOW", "VIEW_DEMO", "COMPARE_PLANS", "BOOK_DEMO", "ASK", "OTHER"] as const;

const isHttps = (u: string) => {
  try {
    return new URL(u).protocol === "https:";
  } catch {
    return false;
  }
};

/** "Title | https://url | KIND" */
export function parseSources(text: string | null | undefined) {
  return splitLines(text, 50)
    .map((line) => {
      const [title, url, kind] = line.split("|").map((s) => s?.trim() ?? "");
      const k = (kind || "WEBSITE").toUpperCase();
      return { title: title.slice(0, 200), url, kind: (SOURCE_KINDS as readonly string[]).includes(k) ? (k as (typeof SOURCE_KINDS)[number]) : "OTHER" };
    })
    .filter((s) => s.title && isHttps(s.url));
}

/** "Label | https://url | KIND" */
export function parseCtas(text: string | null | undefined) {
  return splitLines(text, 10)
    .map((line) => {
      const [label, url, kind] = line.split("|").map((s) => s?.trim() ?? "");
      const k = (kind || "OTHER").toUpperCase();
      return { label: label.slice(0, 60), url, kind: (CTA_KINDS as readonly string[]).includes(k) ? (k as (typeof CTA_KINDS)[number]) : "OTHER" };
    })
    .filter((c) => c.label && isHttps(c.url));
}

/** "network | https://url" */
export function parseSocial(text: string | null | undefined) {
  return splitLines(text, 20)
    .map((line) => {
      const [network, url] = line.split("|").map((s) => s?.trim() ?? "");
      return { network: network.slice(0, 40), url };
    })
    .filter((s) => s.network && isHttps(s.url));
}

export function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  const d = input.trim().replace(/^https?:\/\//i, "").replace(/\/.*$/, "").toLowerCase();
  return /^[a-z0-9.-]+\.[a-z]{2,}$/.test(d) ? d : null;
}

export const facetLines = (facets: { name: string; description: string | null }[]) => facets.map((f) => (f.description ? `${f.name} | ${f.description}` : f.name)).join("\n");
