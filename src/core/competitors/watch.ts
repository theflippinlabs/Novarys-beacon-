import { createHash } from "node:crypto";
import * as cheerio from "cheerio";
import { stripLongDashes } from "@/core/util/text";
import { BEACON_ROBOTS_TOKEN, crawlDelayMs, isAllowed, parseRobots, robotsPath, robotsPolicy, type RobotsRules } from "@/core/seo/robots";

/**
 * Competitor page watch (pure): URL validation, main-text normalisation, the
 * content hash, a factual line diff with price-like tokens quoted from the
 * page, the robots.txt decision and the per-run selection. Nothing here
 * decides a fact: a change only ever produces a summary for a human to review.
 */
export const WATCH_KINDS = ["PRICING", "FEATURES", "HOME", "OTHER"] as const;
export type WatchKind = (typeof WATCH_KINDS)[number];

/** Outcome of the last check. PENDING: never checked. */
export const WATCH_STATUSES = ["PENDING", "OK", "BLOCKED_BY_ROBOTS", "HTTP_ERROR", "NOT_HTML", "FETCH_ERROR"] as const;
export type WatchStatus = (typeof WATCH_STATUSES)[number];

/** Watched pages per organisation (low budget: one page per watch, no crawling beyond it). */
export const MAX_WATCHES_PER_ORG = 25;
/** Pages fetched per organisation in one run (oldest checks first). */
export const MAX_CHECKS_PER_RUN = 25;
/** A scheduled run re-checks a page at most this often. */
export const RECHECK_AFTER_MS = 6 * 86_400_000;
/** "Check now" is refused for a page checked less than this long ago. */
export const MANUAL_MIN_INTERVAL_MS = 10 * 60_000;
/** Politeness between two requests to the same host (robots Crawl-delay may raise it, capped at 10 s). */
export const HOST_DELAY_MS = 2_000;
/** Response size cap for a watched page. */
export const MAX_PAGE_BYTES = 1024 * 1024;
/** Hard deadline per request (robots.txt or page). */
export const REQUEST_DEADLINE_MS = 15_000;
/** Excerpt stored on the watch and on each snapshot. */
export const MAX_EXCERPT = 600;
/** Normalised text kept for the next diff (never displayed in full). */
export const MAX_STORED_TEXT = 64 * 1024;
/** Lines kept from a page. */
export const MAX_LINES = 2_000;
const MAX_LINE = 500;
const SAMPLE_LINES = 5;
const MAX_TOKENS = 10;

export class WatchUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WatchUrlError";
  }
}

/**
 * A watched URL: https only (plain http only for local development hosts
 * when `allowLocalHttp`), no credentials, default port, fragment dropped.
 * SSRF checks on the resolved address happen again at fetch time.
 */
export function validateWatchUrl(raw: string, opts: { allowLocalHttp?: (host: string) => boolean } = {}): URL {
  const v = raw.trim();
  if (!v || v.length > 2000) throw new WatchUrlError("Enter a URL of at most 2000 characters.");
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new WatchUrlError("Enter a valid https:// URL.");
  }
  const local = !!opts.allowLocalHttp?.(u.hostname.replace(/^\[|\]$/g, ""));
  if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new WatchUrlError("Only https:// URLs can be watched.");
  if (u.username || u.password) throw new WatchUrlError("URLs with credentials cannot be watched.");
  if (u.port && !local) throw new WatchUrlError("Only the default https port can be watched.");
  u.hash = "";
  return u;
}

const DROP = "script, style, noscript, template, svg, canvas, iframe, object, embed, nav, header, footer, aside, form, button, select, dialog, [hidden], [aria-hidden='true'], [role='navigation'], [role='banner'], [role='contentinfo'], [role='dialog'], [role='search']";
const BLOCK = new Set(["p", "div", "section", "article", "main", "li", "ul", "ol", "dl", "dt", "dd", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "th", "table", "thead", "tbody", "tfoot", "caption", "blockquote", "pre", "figure", "figcaption", "br", "hr", "summary", "details", "address"]);
/** Boilerplate containers recognised by a class or id token (cookie banners, site menus, site header and footer). */
const BOILER_TOKEN = /^(?:(?:site|main|global|page|top|primary)[-_]?)?(?:header|footer|menu|nav|navbar|navigation)$/i;
const BOILER_PART = /cookie|consent|gdpr|breadcrumb|skip-link|announcement-bar/i;
const isBoilerplate = (v: string | undefined) => !!v && v.split(/\s+/).some((tok) => BOILER_TOKEN.test(tok) || BOILER_PART.test(tok));

function cleanLine(s: string): string {
  const t = stripLongDashes(s.normalize("NFKC").replace(/[\u0000-\u001f\u007f­​-‍﻿]/g, " ")).replace(/\s+/g, " ").trim();
  return t.length > MAX_LINE ? t.slice(0, MAX_LINE) : t;
}

/**
 * The page's main visible text as lines: scripts, styles, navigation,
 * header, footer, forms and recognisable boilerplate are removed; `main`
 * (or `[role=main]`, else a single `article`, else `body`) is read with one
 * line per block element; whitespace is collapsed, empty and consecutive
 * duplicate lines dropped, long dashes replaced (house style).
 */
export function extractMainLines(html: string): string[] {
  const $ = cheerio.load(html);
  $(DROP).remove();
  $("[class], [id]").each((_, el) => {
    const e = $(el);
    const tag = (el as { tagName?: string }).tagName?.toLowerCase();
    if (tag === "body" || tag === "html" || tag === "main") return;
    if (isBoilerplate(e.attr("class")) || isBoilerplate(e.attr("id"))) e.remove();
  });
  const main = $("main").first();
  const roleMain = $("[role='main']").first();
  const articles = $("article");
  const rootNodes: unknown[] = main.length ? main.toArray() : roleMain.length ? roleMain.toArray() : articles.length === 1 ? articles.first().toArray() : $("body").length ? $("body").toArray() : $.root().toArray();
  type Node = { type: string; data?: string; tagName?: string; children?: Node[] };
  const parts: string[] = [];
  const walk = (nodes: Node[]) => {
    for (const node of nodes) {
      if (node.type === "text") parts.push((node.data ?? "").replace(/\s+/g, " "));
      if (node.type !== "tag") continue;
      const block = BLOCK.has((node.tagName ?? "").toLowerCase());
      if (block) parts.push("\n");
      walk(node.children ?? []);
      if (block) parts.push("\n");
    }
  };
  walk((rootNodes as Node[]).flatMap((n) => n.children ?? []));
  return normaliseLines(parts.join("").split("\n"));
}

/** Clean, drop empty and consecutive duplicate lines, cap the count. */
export function normaliseLines(lines: string[]): string[] {
  const out: string[] = [];
  for (const l of lines) {
    const c = cleanLine(l);
    if (!c || out[out.length - 1] === c) continue;
    out.push(c);
    if (out.length >= MAX_LINES) break;
  }
  return out;
}

/** SHA-256 of the normalised lines (null for an empty page, which is never a baseline). */
export function textHash(lines: string[]): string | null {
  return lines.length ? createHash("sha256").update(lines.join("\n")).digest("hex") : null;
}

/** Leading text of the page, capped at `max` characters on a word boundary. */
export function excerptOf(lines: string[], max = MAX_EXCERPT): string {
  const t = lines.join(" ");
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp = cut.lastIndexOf(" ");
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).trim()}...`;
}

/** Text kept for the next diff: whole lines up to MAX_STORED_TEXT characters. */
export function storedText(lines: string[]): string {
  const out: string[] = [];
  let n = 0;
  for (const l of lines) {
    if (n + l.length + 1 > MAX_STORED_TEXT) break;
    out.push(l);
    n += l.length + 1;
  }
  return out.join("\n");
}

const CUR = "(?:US\\$|CA\\$|A\\$|[$€£¥₹]|(?:USD|EUR|GBP|CHF|CAD|AUD|JPY|INR)\\b)";
const NUM = "\\d{1,3}(?:[ ,.\\u00a0\\u202f]\\d{3})*(?:[.,]\\d{1,2})?";
const PER = "(?:\\s?(?:/|per|par)\\s?(?:month|mois|mo|year|yr|année|an|user|seat|utilisateur|siège|week|semaine|day|jour)(?![\\p{L}]))?";
const PRICE_RE = new RegExp(`(?:${CUR}\\s?${NUM}|${NUM}\\s?${CUR})${PER}`, "giu");

/** Price-like tokens as written on the page ("$29/mo", "29 € par mois", "EUR 1,200"), in order, de-duplicated. */
export function priceTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of text.matchAll(PRICE_RE)) {
    const tok = m[0].replace(/\s+/g, " ").trim();
    const key = tok.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tok);
  }
  return out;
}

export type WatchDiff = {
  linesAdded: number;
  linesRemoved: number;
  /** Up to 5 added / removed lines, quoted from the page. */
  added: string[];
  removed: string[];
  /** Price-like tokens present now and not before, and the reverse, quoted from the page. */
  pricesAppeared: string[];
  pricesDisappeared: string[];
};

const counts = (lines: string[]) => {
  const m = new Map<string, number>();
  for (const l of lines) m.set(l, (m.get(l) ?? 0) + 1);
  return m;
};

/** Lines of `a` not matched in `b` (multiset difference, order of `a` kept). */
function minus(a: string[], b: string[]): string[] {
  const left = counts(b);
  const out: string[] = [];
  for (const l of a) {
    const n = left.get(l) ?? 0;
    if (n > 0) left.set(l, n - 1);
    else out.push(l);
  }
  return out;
}

/**
 * Factual summary of a change: how many lines were added and removed (a
 * moved line counts as neither), a few of them, and the price-like tokens
 * that appeared or disappeared. Never interprets the change.
 */
export function diffSummary(before: string[], after: string[]): WatchDiff {
  const added = minus(after, before);
  const removed = minus(before, after);
  const pricesBefore = priceTokens(before.join("\n"));
  const pricesAfter = priceTokens(after.join("\n"));
  const lower = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase()));
  const pb = lower(pricesBefore);
  const pa = lower(pricesAfter);
  return {
    linesAdded: added.length,
    linesRemoved: removed.length,
    added: added.slice(0, SAMPLE_LINES).map((l) => (l.length > 200 ? `${l.slice(0, 200)}...` : l)),
    removed: removed.slice(0, SAMPLE_LINES).map((l) => (l.length > 200 ? `${l.slice(0, 200)}...` : l)),
    pricesAppeared: pricesAfter.filter((p) => !pb.has(p.toLowerCase())).slice(0, MAX_TOKENS),
    pricesDisappeared: pricesBefore.filter((p) => !pa.has(p.toLowerCase())).slice(0, MAX_TOKENS),
  };
}

export type RobotsDecision = { allowed: boolean; reason: "ALLOWED" | "DISALLOWED" | "ROBOTS_UNAVAILABLE"; delayMs: number };

/**
 * Whether Beacon may fetch `url` given the site's robots.txt answer
 * (status null: unreachable). RFC 9309: 2xx parse (Beacon's token, then
 * "*"), 4xx allow all, 5xx / 429 / unreachable disallow all. The delay is
 * the politeness delay for the host (Crawl-delay honoured, capped at 10 s).
 */
export function robotsDecision(status: number | null, body: string | null, url: string, defaultDelayMs = HOST_DELAY_MS): RobotsDecision {
  const policy = robotsPolicy(status);
  if (policy === "DISALLOW_ALL") return { allowed: false, reason: "ROBOTS_UNAVAILABLE", delayMs: defaultDelayMs };
  const rules: RobotsRules | null = policy === "PARSE" ? parseRobots(body ?? "") : null;
  const delayMs = crawlDelayMs(rules, BEACON_ROBOTS_TOKEN, defaultDelayMs);
  if (rules && !isAllowed(rules, robotsPath(url), BEACON_ROBOTS_TOKEN)) return { allowed: false, reason: "DISALLOWED", delayMs };
  return { allowed: true, reason: "ALLOWED", delayMs };
}

export type WatchCandidate = { id: string; url: string; active: boolean; lastFetchedAt: Date | null };

/**
 * Watches to check in one run: active ones, explicit ids when given (a
 * "Check now"), else those not checked for RECHECK_AFTER_MS; never-checked
 * first, then oldest; at most `max`.
 */
export function selectDue<T extends WatchCandidate>(watches: T[], now: Date, opts: { ids?: string[]; max?: number } = {}): T[] {
  const max = opts.max ?? MAX_CHECKS_PER_RUN;
  const pool = watches.filter((w) => w.active && (opts.ids ? opts.ids.includes(w.id) : !w.lastFetchedAt || now.getTime() - w.lastFetchedAt.getTime() >= RECHECK_AFTER_MS));
  return pool.sort((a, b) => (a.lastFetchedAt?.getTime() ?? 0) - (b.lastFetchedAt?.getTime() ?? 0) || a.id.localeCompare(b.id)).slice(0, max);
}

/** Round-robin by host, so consecutive requests rarely hit the same host and politeness waits stay short. */
export function interleaveByHost<T extends { url: string }>(items: T[]): T[] {
  const groups = new Map<string, T[]>();
  for (const it of items) {
    const h = new URL(it.url).host.toLowerCase();
    groups.set(h, [...(groups.get(h) ?? []), it]);
  }
  const out: T[] = [];
  const queues = [...groups.values()];
  for (let i = 0; out.length < items.length; i++) for (const q of queues) if (q[i]) out.push(q[i]);
  return out;
}
