import { NextResponse } from "next/server";
import { hmac } from "@/lib/security/crypto";
import { rateLimit } from "@/lib/security/rate-limit";
import { env } from "@/lib/env";

/**
 * Client IP behind `hops` trusted reverse proxies. Each proxy appends the
 * address it received the connection from to X-Forwarded-For, so the only
 * trustworthy entry is the one added by our outermost trusted proxy: the
 * `hops`-th from the right. Anything to its left is client-controlled.
 * With `hops = 0` (no proxy) the header is ignored entirely.
 */
export function pickClientIp(xff: string | null | undefined, realIp: string | null | undefined, hops: number): string {
  if (hops <= 0) return "unknown";
  const entries = (xff ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!entries.length) return realIp?.trim() || "unknown";
  return entries[Math.max(0, entries.length - hops)];
}

/** Client IP of a request (or its headers), honouring BEACON_TRUSTED_PROXY_HOPS. */
export function clientIp(src: Request | Headers): string {
  const h = src instanceof Headers ? src : src.headers;
  return pickClientIp(h.get("x-forwarded-for"), h.get("x-real-ip"), env().BEACON_TRUSTED_PROXY_HOPS);
}

/** Keyed hash of the client IP (never stored or logged in clear). */
export function ipHashOf(src: Request | Headers): string {
  return hmac(clientIp(src), "ip");
}

/**
 * CSRF guard for cookie-authenticated POST route handlers: the Origin header
 * must be present, parseable (so `Origin: null` from sandboxed frames or
 * privacy redirects is refused with 403, not a 500) and equal to this
 * deployment's origin or the request host.
 */
export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin || origin === "null") return false;
  let o: URL;
  try {
    o = new URL(origin);
  } catch {
    return false;
  }
  try {
    if (o.origin === new URL(env().BEACON_BASE_URL).origin) return true;
  } catch {
    // ignore a malformed base URL; fall through to the host comparison
  }
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  return Boolean(host) && o.host === host;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  return req.headers.get("x-beacon-key");
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => NextResponse.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
export const err = (status: number, message: string, headers: Record<string, string> = {}) => json({ error: message }, status, headers);

/**
 * Rate limit for Server Component pages (no Response to return): true when the
 * caller (by trusted client IP) exceeded `limit` requests per `windowSec`.
 */
export async function pageRateLimited(prefix: string, limit: number, windowSec: number): Promise<boolean> {
  const { headers } = await import("next/headers");
  const r = await rateLimit(`${prefix}:ip:${ipHashOf(await headers())}`, limit, windowSec);
  return !r.allowed;
}

export async function limited(key: string, limit: number, windowSec: number) {
  const r = await rateLimit(key, limit, windowSec);
  return r.allowed ? null : err(429, "Rate limit exceeded", { "retry-after": String(Math.ceil((r.resetAt.getTime() - Date.now()) / 1000)) });
}

export class PayloadTooLargeError extends Error {
  constructor() {
    super("Payload too large");
    this.name = "PayloadTooLargeError";
  }
}

/**
 * Read a request body as text with a hard byte cap: refuses early on a large
 * Content-Length, then streams and aborts as soon as the cap is exceeded, so
 * a lying or absent Content-Length cannot make the server buffer more.
 */
export async function readCappedText(req: Request, maxBytes: number): Promise<string> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > maxBytes) throw new PayloadTooLargeError();
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new PayloadTooLargeError();
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Read a JSON body with a hard size cap (also accepts text/plain from navigator.sendBeacon). */
export async function readJson(req: Request, maxBytes = 32_768): Promise<unknown> {
  const text = await readCappedText(req, maxBytes);
  return JSON.parse(text || "{}");
}

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, authorization, x-beacon-key", vary: "Origin", "access-control-max-age": "600" };
}
