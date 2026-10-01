import { z } from "zod";
import { asSystem } from "@/db";
import { instrument } from "@/lib/metrics";
import { bearer, err, json, readJson } from "@/lib/http";
import { resolveApiKey } from "@/services/tracking";
import { recordCrossSellEvent } from "@/services/crosssell";

export const dynamic = "force-dynamic";

const Schema = z.object({ identityRef: z.string().min(1).max(200), ruleId: z.string().uuid(), type: z.enum(["CLICK", "CONVERSION", "DISMISS"]), revenueCents: z.number().int().min(0).optional() });

export const POST = instrument("POST /api/v1/cross-sell/event", async (req: Request) => {
  let body: unknown;
  try {
    body = await readJson(req);
  } catch {
    return err(400, "Invalid JSON");
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return err(400, "Invalid event");
  return asSystem(async (tx) => {
    const key = await resolveApiKey(tx, bearer(req));
    if (!key || key.kind !== "SECRET") return err(401, "A secret key is required");
    const ok = await recordCrossSellEvent(tx, key.organizationId, parsed.data.identityRef, parsed.data.ruleId, parsed.data.type, parsed.data.revenueCents);
    return ok ? json({ ok: true }, 201) : err(404, "Unknown identity or rule");
  });
});
