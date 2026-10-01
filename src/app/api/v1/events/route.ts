import { instrument } from "@/lib/metrics";
import { corsHeaders } from "@/lib/http";
import { err, ingestOne, json, openRequest } from "./ingest";

export const dynamic = "force-dynamic";

/** CORS preflight: allowed for any origin; the key + origin check happens on POST. */
export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

/**
 * Conversion event ingestion. Accepts `Authorization: Bearer <key>` or, for
 * browser beacons that cannot set headers, a `key` field in the body
 * (publishable keys only). Rate limited per IP and per key.
 */
export const POST = instrument("POST /api/v1/events", async (req: Request) => {
  const open = await openRequest(req, { maxBytes: 32_768, batch: false });
  if (!open.ok) return open.response;
  const { body, key, cors, origin, ipHash } = open;
  // Unknown fields (such as the body `key`) are stripped by the event schema.
  const res = await ingestOne(key, body, { origin, ipHash });
  if (!res.ok) return err(res.status, res.error, cors);
  return json({ ok: true, ...res.result }, 202, cors);
});
