import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { asSystem } from "@/db";
import { crossSellRules } from "@/db/schema";
import { instrument } from "@/lib/metrics";
import { bearer, err, ipHashOf, json, limited, PayloadTooLargeError, readJson } from "@/lib/http";
import { resolveApiKey } from "@/services/tracking";
import { recordCrossSellEvent } from "@/services/crosssell";

export const dynamic = "force-dynamic";

const Schema = z.object({ identityRef: z.string().min(1).max(200), ruleId: z.string().uuid(), type: z.enum(["CLICK", "CONVERSION", "DISMISS"]), revenueCents: z.number().int().min(0).optional() });

/**
 * A product back-end reports what happened to a cross-sell recommendation.
 * Requires a product-scoped secret key with a cross-sell scope, and the rule
 * must involve that product (as source or destination).
 */
export const POST = instrument("POST /api/v1/cross-sell/event", async (req: Request) => {
  const rl = await limited(`xsell-event:ip:${ipHashOf(req)}`, 300, 60);
  if (rl) return rl;
  let body: unknown;
  try {
    body = await readJson(req, 8192);
  } catch (e) {
    return e instanceof PayloadTooLargeError ? err(413, "Payload too large") : err(400, "Invalid JSON");
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return err(400, "Invalid event");
  return asSystem(async (tx) => {
    const key = await resolveApiKey(tx, bearer(req));
    if (!key || key.kind !== "SECRET" || !key.productId || !key.scopes.some((s) => s === "crosssell:read" || s === "crosssell:write")) return err(401, "A product-scoped secret key with a cross-sell scope is required");
    const rule = await tx.query.crossSellRules.findFirst({ where: and(eq(crossSellRules.id, parsed.data.ruleId), eq(crossSellRules.organizationId, key.organizationId)) });
    if (!rule || (rule.sourceProductId !== key.productId && rule.destinationProductId !== key.productId)) return err(404, "Unknown identity or rule");
    const ok = await recordCrossSellEvent(tx, key.organizationId, parsed.data.identityRef, parsed.data.ruleId, parsed.data.type, parsed.data.revenueCents);
    return ok ? json({ ok: true }, 201) : err(404, "Unknown identity or rule");
  });
});
