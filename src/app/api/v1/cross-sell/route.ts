import { asSystem } from "@/db";
import { instrument } from "@/lib/metrics";
import { bearer, err, ipHashOf, json, limited } from "@/lib/http";
import { resolveApiKey } from "@/services/tracking";
import { crossSellFor } from "@/services/crosssell";

export const dynamic = "force-dynamic";

/** Product back-ends ask which ecosystem recommendation (if any) to show a user. Consent and frequency caps enforced. */
export const GET = instrument("GET /api/v1/cross-sell", async (req: Request) => {
  const rl = await limited(`xsell:ip:${ipHashOf(req)}`, 600, 60);
  if (rl) return rl;
  const url = new URL(req.url);
  const identityRef = url.searchParams.get("identityRef");
  if (!identityRef || identityRef.length > 200) return err(400, "identityRef is required");
  return asSystem(async (tx) => {
    const key = await resolveApiKey(tx, bearer(req));
    if (!key || key.kind !== "SECRET" || !key.productId || !key.scopes.includes("crosssell:read")) return err(401, "A product-scoped secret key is required");
    const res = await crossSellFor(tx, key.organizationId, identityRef, key.productId, { recordImpression: url.searchParams.get("record") === "1" });
    return json(res);
  });
});
