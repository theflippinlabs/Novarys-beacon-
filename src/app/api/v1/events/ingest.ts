import { asSystem } from "@/db";
import { bearer, corsHeaders, err, ipHashOf, json, limited, PayloadTooLargeError, readJson } from "@/lib/http";
import { log } from "@/lib/logger";
import { EventSchema, IngestError, ingestEvent, resolveApiKey, type ResolvedKey } from "@/services/tracking";

/** Per-IP and per-key budgets (requests per minute). A batch counts as one request on the batch budget. */
export const LIMITS = { ip: 600, key: 6000, batchKey: 120 } as const;

/** A 429 that still carries the CORS headers, so browsers can read it. */
async function limitedCors(bucket: string, limit: number, cors: Record<string, string>) {
  const rl = await limited(bucket, limit, 60);
  if (rl) for (const [k, v] of Object.entries(cors)) rl.headers.set(k, v);
  return rl;
}

/**
 * Shared front door of /api/v1/events and /api/v1/events/batch: body size
 * cap, per-IP rate limit, key resolution (Authorization header, or a
 * publishable `key` field in the body for sendBeacon), per-key rate limit.
 */
export async function openRequest(req: Request, opts: { maxBytes: number; batch: boolean }) {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  // Keyed hash of the trusted-proxy client IP (shared clientIp helper).
  const ipHash = ipHashOf(req);
  const ipLimited = await limitedCors(`events:ip:${ipHash}`, LIMITS.ip, cors);
  if (ipLimited) return { ok: false as const, response: ipLimited };
  let body: Record<string, unknown>;
  try {
    body = (await readJson(req, opts.maxBytes)) as Record<string, unknown>;
  } catch (e) {
    return { ok: false as const, response: e instanceof PayloadTooLargeError ? err(413, "Payload too large", cors) : err(400, "Invalid JSON", cors) };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false as const, response: err(400, "Invalid JSON", cors) };
  const raw = bearer(req) ?? (typeof body.key === "string" && body.key.startsWith("bpk_") ? body.key : null);
  const key = await asSystem((tx) => resolveApiKey(tx, raw));
  if (!key) return { ok: false as const, response: err(401, "Invalid API key", cors) };
  const keyLimited = await limitedCors(opts.batch ? `events:batch:key:${key.id}` : `events:key:${key.id}`, opts.batch ? LIMITS.batchKey : LIMITS.key, cors);
  if (keyLimited) return { ok: false as const, response: keyLimited };
  return { ok: true as const, body, key, cors, origin, ipHash };
}

/** Validate and ingest one event in its own transaction; errors become a status + message, never an exception. */
type Ingested = Awaited<ReturnType<typeof ingestEvent>>;
export type IngestResult = { ok: true; status: 202; result: Ingested } | { ok: false; status: number; error: string };

export async function ingestOne(key: ResolvedKey, input: unknown, meta: { origin: string | null; ipHash: string }): Promise<IngestResult> {
  const parsed = EventSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, error: `Invalid event: ${parsed.error.issues[0].path.join(".")} ${parsed.error.issues[0].message}` };
  try {
    const result = await asSystem((tx) => ingestEvent(tx, key, parsed.data, meta));
    return { ok: true, status: 202, result };
  } catch (e) {
    if (e instanceof IngestError) return { ok: false, status: e.status, error: e.message };
    log.error("events.ingest_failed", { err: e });
    return { ok: false, status: 500, error: "Internal error" };
  }
}

export { json, err };
