import { and, eq } from "drizzle-orm";
import { asSystem } from "@/db";
import { products } from "@/db/schema";
import { instrument } from "@/lib/metrics";
import { bearer, err, ipHashOf, json, limited, readJson } from "@/lib/http";
import { RevenueSchema, recordRevenue, resolveApiKey } from "@/services/tracking";

export const dynamic = "force-dynamic";

/** Server-to-server revenue events (secret key only). Idempotent on provider + externalId. */
export const POST = instrument("POST /api/v1/revenue", async (req: Request) => {
  const rl = await limited(`revenue:ip:${ipHashOf(req)}`, 300, 60);
  if (rl) return rl;
  let body: unknown;
  try {
    body = await readJson(req, 65_536);
  } catch {
    return err(400, "Invalid JSON");
  }
  const parsed = RevenueSchema.safeParse(body);
  if (!parsed.success) return err(400, `Invalid revenue event: ${parsed.error.issues[0].path.join(".")} ${parsed.error.issues[0].message}`);
  return asSystem(async (tx) => {
    const key = await resolveApiKey(tx, bearer(req));
    if (!key || key.kind !== "SECRET" || !key.scopes.includes("revenue:write")) return err(401, "A secret key with revenue:write is required");
    const productId = key.productId ?? (parsed.data.product ? (await tx.query.products.findFirst({ where: and(eq(products.organizationId, key.organizationId), eq(products.slug, parsed.data.product)) }))?.id : undefined);
    if (!productId) return err(404, "Unknown product");
    const res = await recordRevenue(tx, key.organizationId, productId, parsed.data);
    return json({ ok: true, ...res }, res.duplicate ? 200 : 201);
  });
});
