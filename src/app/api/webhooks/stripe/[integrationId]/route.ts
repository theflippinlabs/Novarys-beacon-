import { and, eq } from "drizzle-orm";
import { asSystem } from "@/db";
import { integrations, products } from "@/db/schema";
import { instrument } from "@/lib/metrics";
import { err, json } from "@/lib/http";
import { log } from "@/lib/logger";
import { mapStripeEvent, verifyStripeSignature } from "@/services/stripe";
import { recordRevenue } from "@/services/tracking";
import { loadSecret } from "@/services/visibility";

export const dynamic = "force-dynamic";

/**
 * Stripe webhook receiver (one endpoint per Stripe integration). The raw
 * body's HMAC signature is verified with the integration's encrypted signing
 * secret before anything is parsed or stored. Processing is idempotent on the
 * Stripe event id.
 */
async function handler(req: Request, ctx: { params: Promise<{ integrationId: string }> }) {
  const { integrationId } = await ctx.params;
  if (!/^[0-9a-f-]{36}$/.test(integrationId)) return err(404, "Not found");
  const raw = await req.text();
  if (raw.length > 512_000) return err(413, "Payload too large");
  return asSystem(async (tx) => {
    const integ = await tx.query.integrations.findFirst({ where: and(eq(integrations.id, integrationId), eq(integrations.provider, "STRIPE")) });
    if (!integ || integ.status === "DISABLED") return err(404, "Not found");
    const secret = await loadSecret(tx, integ.id);
    if (!verifyStripeSignature(raw, req.headers.get("stripe-signature"), secret.webhookSecret ?? "")) {
      log.warn("stripe.signature_invalid", { integrationId });
      return err(400, "Invalid signature");
    }
    const event = JSON.parse(raw);
    const mapped = mapStripeEvent(event);
    if (!mapped) return json({ received: true, ignored: event.type });
    const slug = mapped.productSlug ?? integ.config.defaultProduct;
    const product = slug ? await tx.query.products.findFirst({ where: and(eq(products.organizationId, integ.organizationId), eq(products.slug, slug)) }) : null;
    if (!product) {
      log.warn("stripe.unmapped_product", { integrationId, type: event.type });
      return json({ received: true, ignored: "no product mapping (set metadata.beacon_product or a default product)" });
    }
    const res = await recordRevenue(tx, integ.organizationId, product.id, mapped);
    await tx.update(integrations).set({ lastSyncAt: new Date(), status: "CONNECTED", lastError: null }).where(eq(integrations.id, integ.id));
    return json({ received: true, duplicate: res.duplicate });
  });
}

export const POST = instrument("POST /api/webhooks/stripe", handler);
