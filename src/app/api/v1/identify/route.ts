import { z } from "zod";
import { asSystem } from "@/db";
import { identityProducts } from "@/db/schema";
import { instrument } from "@/lib/metrics";
import { bearer, err, ipHashOf, json, limited, readJson } from "@/lib/http";
import { hmac } from "@/lib/security/crypto";
import { resolveApiKey, upsertIdentity } from "@/services/tracking";

export const dynamic = "force-dynamic";

const Schema = z.object({
  identityRef: z.string().min(1).max(200),
  email: z.string().email().max(320).optional(),
  consent: z.object({ analytics: z.boolean(), marketing: z.boolean(), crossProduct: z.boolean() }).optional(),
  traits: z.array(z.string().regex(/^[a-z0-9_:.-]{1,60}$/)).max(20).optional(),
  plan: z.string().max(100).optional(),
});

/**
 * Novarys ID: a product registers/updates a user's identity, consent and the
 * non-sensitive traits it explicitly chooses to share. Raw emails are never
 * stored (keyed hash only); product data stays in the product.
 */
export const POST = instrument("POST /api/v1/identify", async (req: Request) => {
  const rl = await limited(`identify:ip:${ipHashOf(req)}`, 300, 60);
  if (rl) return rl;
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return err(400, "Invalid JSON");
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return err(400, `Invalid identity: ${parsed.error.issues[0].path.join(".")} ${parsed.error.issues[0].message}`);
  return asSystem(async (tx) => {
    const key = await resolveApiKey(tx, bearer(req));
    if (!key || key.kind !== "SECRET" || !key.scopes.includes("identity:write") || !key.productId) return err(401, "A product-scoped secret key with identity:write is required");
    const i = parsed.data;
    const identity = await upsertIdentity(tx, key.organizationId, i.identityRef, { emailHash: i.email ? hmac(i.email.trim().toLowerCase(), "email") : null, consent: i.consent });
    await tx
      .insert(identityProducts)
      .values({ organizationId: key.organizationId, identityId: identity.id, productId: key.productId, plan: i.plan, sharedTraits: i.traits ?? [] })
      .onConflictDoUpdate({ target: [identityProducts.identityId, identityProducts.productId], set: { lastSeenAt: new Date(), ...(i.plan ? { plan: i.plan } : {}), ...(i.traits ? { sharedTraits: i.traits } : {}) } });
    return json({ ok: true, identityId: identity.id, consent: identity.consent });
  });
});
