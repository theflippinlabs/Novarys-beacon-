import { NextResponse } from "next/server";
import { hmac } from "@/lib/security/crypto";
import { rateLimit } from "@/lib/security/rate-limit";

export function ipHashOf(req: Request): string {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  return hmac(ip, "ip");
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (h?.startsWith("Bearer ")) return h.slice(7).trim();
  return req.headers.get("x-beacon-key");
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) => NextResponse.json(data, { status, headers: { "cache-control": "no-store", ...headers } });
export const err = (status: number, message: string, headers: Record<string, string> = {}) => json({ error: message }, status, headers);

export async function limited(key: string, limit: number, windowSec: number) {
  const r = await rateLimit(key, limit, windowSec);
  return r.allowed ? null : err(429, "Rate limit exceeded", { "retry-after": String(Math.ceil((r.resetAt.getTime() - Date.now()) / 1000)) });
}

/** Read a JSON body with a hard size cap (also accepts text/plain from navigator.sendBeacon). */
export async function readJson(req: Request, maxBytes = 32_768): Promise<unknown> {
  const text = await req.text();
  if (text.length > maxBytes) throw new Error("Payload too large");
  return JSON.parse(text || "{}");
}

export function corsHeaders(origin: string | null): Record<string, string> {
  if (!origin) return {};
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type, authorization, x-beacon-key", vary: "Origin", "access-control-max-age": "600" };
}
