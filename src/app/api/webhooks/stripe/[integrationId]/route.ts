import { and, eq } from "drizzle-orm";
import { asSystem } from "@/db";
import { integrations } from "@/db/schema";
import { instrument } from "@/lib/metrics";
import { err, json, limited, readCappedText } from "@/lib/http";
import { log } from "@/lib/logger";
import { processInboxRow, storeInbox, verifyStripeSignature, type StripeEvent } from "@/services/stripe";
import { loadSecret } from "@/services/visibility";

export const dynamic = "force-dynamic";

/**
 * Stripe webhook receiver (one endpoint per Stripe integration). The raw
 * body's HMAC signature is verified with the integration's encrypted signing
 * secret before anything is parsed or stored. Every verified event is stored
 * in the webhook inbox first (idempotent on the Stripe event id), then
 * processed: events that cannot be mapped to a product are kept as UNMAPPED
 * (answered 200 so Stripe stops retrying; reprocess them from Settings →
 * Integrations once the mapping is fixed); processing errors answer 500 so
 * Stripe retries.
 */
async function handler(req: Request, ctx: { params: Promise<{ integrationId: string }> }) {
  const { integrationId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(integrationId)) return err(404, "Not found");
  const rl = await limited(`stripe-webhook:${integrationId}`, 600, 60);
  if (rl) return rl;
  let raw: string;
  try {
    raw = await readCappedText(req, 512_000);
  } catch {
    return err(413, "Payload too large");
  }
  return asSystem(async (tx) => {
    const integ = await tx.query.integrations.findFirst({ where: and(eq(integrations.id, integrationId), eq(integrations.provider, "STRIPE")) });
    if (!integ || integ.status === "DISABLED") return err(404, "Not found");
    const secret = await loadSecret(tx, integ.id);
    if (!verifyStripeSignature(raw, req.headers.get("stripe-signature"), secret.webhookSecret ?? "")) {
      log.warn("stripe.signature_invalid", { integrationId });
      return err(400, "Invalid signature");
    }
    let event: StripeEvent;
    try {
      event = JSON.parse(raw);
    } catch {
      return err(400, "Invalid JSON");
    }
    if (typeof event?.id !== "string" || typeof event.type !== "string" || typeof event.created !== "number" || !event.data?.object) return err(400, "Not a Stripe event");
    const { row, existed } = await storeInbox(tx, integ, event);
    if (existed && row.status === "PROCESSED") return json({ received: true, duplicate: true });
    const out = await processInboxRow(tx, integ, row);
    if (out.status === "FAILED") {
      log.error("stripe.processing_failed", { integrationId, type: event.type, err: out.error });
      return err(500, "Processing failed; the event is kept in the inbox");
    }
    if (out.status === "UNMAPPED") {
      log.warn("stripe.unmapped_product", { integrationId, type: event.type });
      return json({ received: true, unmapped: out.unmapped });
    }
    if (out.ignored) return json({ received: true, ignored: event.type });
    return json({ received: true, duplicate: Boolean(out.duplicate) });
  });
}

export const POST = instrument("POST /api/webhooks/stripe", handler);
