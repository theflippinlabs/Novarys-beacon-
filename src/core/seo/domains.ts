/**
 * Domain ownership rules for crawling: an organisation may only audit hosts
 * it has verified (the host itself or a parent domain). Pure.
 */
import { isIP } from "node:net";

/** Common multi-label public suffixes; a verified domain must sit below them. */
const MULTI_LABEL_SUFFIXES = new Set([
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "ltd.uk", "plc.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "co.jp", "ne.jp", "or.jp", "co.kr", "co.in", "co.za", "co.il",
  "com.br", "com.mx", "com.ar", "com.tr", "com.cn", "com.hk", "com.sg", "com.tw", "com.my",
  "gouv.fr", "asso.fr", "github.io", "vercel.app", "netlify.app", "herokuapp.com", "pages.dev", "web.app", "firebaseapp.com", "azurewebsites.net", "cloudfront.net", "blogspot.com",
]);

export const VERIFICATION_TXT_PREFIX = "beacon-verification=";
export const VERIFICATION_FILE_PATH = "/.well-known/beacon-verification.txt";

/** Lowercase host from a domain or URL typed by a user; null when it is not a usable domain name. */
export function normalizeDomain(input: string): string | null {
  let s = input.trim().toLowerCase();
  if (!s) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = `https://${s}`;
  let host: string;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    host = u.hostname.replace(/\.$/, "");
  } catch {
    return null;
  }
  if (!host || isIP(host.replace(/^\[|\]$/g, ""))) return null;
  if (!/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/.test(host)) return null;
  return host;
}

/** Registrable domain (eTLD+1) using a small built-in suffix list. */
export function registrableDomain(host: string): string {
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const last2 = labels.slice(-2).join(".");
  return MULTI_LABEL_SUFFIXES.has(last2) ? labels.slice(-3).join(".") : last2;
}

/** A domain can be verified only at or below the registrable level (never a bare public suffix). */
export function isVerifiableDomain(domain: string): boolean {
  if (!domain.includes(".")) return false;
  if (MULTI_LABEL_SUFFIXES.has(domain)) return false;
  return domain.split(".").length >= registrableDomain(domain).split(".").length;
}

/** Whether `host` is covered by one of the verified domains (exact host or a parent domain). */
export function hostCoveredBy(host: string, verified: string[]): string | null {
  const h = host.toLowerCase().replace(/\.$/, "");
  for (const d of verified) if (h === d || h.endsWith(`.${d}`)) return d;
  return null;
}

/** The TXT records / file body contain the token (exact token, whitespace trimmed). */
export function txtRecordsMatch(records: string[][], token: string): boolean {
  return records.some((chunks) => chunks.join("").trim() === `${VERIFICATION_TXT_PREFIX}${token}`);
}

export function fileBodyMatches(body: string, token: string): boolean {
  return body.split(/\r?\n/).some((l) => {
    const v = l.trim();
    return v === token || v === `${VERIFICATION_TXT_PREFIX}${token}`;
  });
}

/**
 * Development-only bypass: local fixture hosts (loopback / private IPs and
 * localhost) may be audited without verification when
 * BEACON_SSRF_ALLOW_PRIVATE=true and NODE_ENV is not production. Public
 * hosts always need verification.
 */
export function isLocalDevHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (isIP(h) === 4) return /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h);
  if (isIP(h) === 6) return h === "::1" || h.startsWith("fc") || h.startsWith("fd");
  return false;
}

/** Search Console access levels that only a verified owner can grant. */
export const SEARCH_CONSOLE_OWNER_LEVELS = ["siteOwner", "siteFullUser"] as const;

/**
 * The domain a Search Console property proves: `sc-domain:example.com` covers
 * example.com and its subdomains; a URL-prefix property its host. Null for
 * anything else.
 */
export function domainFromSearchConsoleProperty(siteUrl: string): string | null {
  const v = siteUrl.trim();
  if (/^sc-domain:/i.test(v)) return normalizeDomain(v.slice("sc-domain:".length));
  if (/^https?:\/\//i.test(v)) return normalizeDomain(v);
  return null;
}
