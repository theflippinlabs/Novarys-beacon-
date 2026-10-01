import { instrument } from "@/lib/metrics";
import { corsHeaders } from "@/lib/http";
import { err, ingestOne, json, openRequest } from "../ingest";

export const dynamic = "force-dynamic";

const MAX_BATCH = 100;

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

/**
 * Batch ingestion: `{ "events": [ ... ] }` with up to 100 events, each
 * validated and stored independently (same rules as /api/v1/events: a
 * publishable key may not send identity, consent or traits). The response
 * lists one result per event, in order.
 */
export const POST = instrument("POST /api/v1/events/batch", async (req: Request) => {
  const open = await openRequest(req, { maxBytes: 512_000, batch: true });
  if (!open.ok) return open.response;
  const { body, key, cors, origin, ipHash } = open;
  const events = body.events;
  if (!Array.isArray(events) || events.length === 0) return err(400, "events must be a non-empty array", cors);
  if (events.length > MAX_BATCH) return err(413, `At most ${MAX_BATCH} events per batch`, cors);
  const results = [];
  for (const [index, ev] of events.entries()) {
    const r = await ingestOne(key, ev, { origin, ipHash });
    results.push(r.ok ? { index, status: r.status, ...r.result } : { index, status: r.status, error: r.error });
  }
  const accepted = results.filter((r) => r.status === 202).length;
  const status = accepted === results.length ? 202 : accepted ? 207 : 400;
  return json({ ok: accepted === results.length, accepted, rejected: results.length - accepted, results }, status, cors);
});
