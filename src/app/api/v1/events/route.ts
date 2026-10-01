import { asSystem } from "@/db";
import { instrument } from "@/lib/metrics";
import { bearer, corsHeaders, err, ipHashOf, json, limited, readJson } from "@/lib/http";
import { EventSchema, IngestError, ingestEvent, resolveApiKey } from "@/services/tracking";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** CORS preflight: allowed for any origin; the key + origin check happens on POST. */
export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

/**
 * Conversion event ingestion. Accepts `Authorization: Bearer <key>` or, for
 * browser beacons that cannot set headers, a `key` field in the body
 * (publishable keys only).
 */
export const POST = instrument("POST /api/v1/events", async (req: Request) => {
  const origin = req.headers.get("origin");
  const cors = corsHeaders(origin);
  let body: Record<string, unknown>;
  try {
    body = (await readJson(req)) as Record<string, unknown>;
  } catch {
    return err(400, "Invalid JSON", cors);
  }
  const raw = bearer(req) ?? (typeof body.key === "string" && body.key.startsWith("bpk_") ? body.key : null);
  const ipHash = ipHashOf(req);
  const rl = await limited(`events:ip:${ipHash}`, 600, 60);
  if (rl) return rl;
  const parsed = EventSchema.safeParse(body);
  if (!parsed.success) return err(400, `Invalid event: ${parsed.error.issues[0].path.join(".")} ${parsed.error.issues[0].message}`, cors);
  try {
    const res = await asSystem(async (tx) => {
      const key = await resolveApiKey(tx, raw);
      if (!key) throw new IngestError(401, "Invalid API key");
      return ingestEvent(tx, key, parsed.data, { origin, ipHash });
    });
    return json({ ok: true, ...res }, 202, cors);
  } catch (e) {
    if (e instanceof IngestError) return err(e.status, e.message, cors);
    log.error("events.ingest_failed", { err: e });
    return err(500, "Internal error", cors);
  }
});
