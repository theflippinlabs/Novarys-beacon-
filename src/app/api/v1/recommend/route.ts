import { z } from "zod";
import { asSystem } from "@/db";
import { crossSellRules } from "@/db/schema";
import { eq } from "drizzle-orm";
import { instrument } from "@/lib/metrics";
import { corsHeaders, err, ipHashOf, json, limited, readJson } from "@/lib/http";
import { recommendProduct } from "@/ai/tasks";
import { orgBySlug, publicGraphs } from "@/services/public";

export const dynamic = "force-dynamic";

const Schema = z.object({ org: z.string().max(80), need: z.string().trim().min(5).max(1000) });

export async function OPTIONS(req: Request) {
  return new Response(null, { status: 204, headers: corsHeaders(req.headers.get("origin")) });
}

/** Public AI sales agent: explainable recommendation from verified product facts only. */
export const POST = instrument("POST /api/v1/recommend", async (req: Request) => {
  const cors = corsHeaders(req.headers.get("origin"));
  const rl = await limited(`recommend:ip:${ipHashOf(req)}`, 30, 60);
  if (rl) return rl;
  let body: unknown;
  try {
    body = await readJson(req, 8192);
  } catch {
    return err(400, "Invalid JSON", cors);
  }
  const parsed = Schema.safeParse(body);
  if (!parsed.success) return err(400, "Provide { org, need } (need: 5 to 1000 chars)", cors);
  return asSystem(async (tx) => {
    const org = await orgBySlug(tx, parsed.data.org);
    if (!org) return err(404, "Unknown organisation", cors);
    const graphs = await publicGraphs(tx, org.id);
    const rules = await tx.select().from(crossSellRules).where(eq(crossSellRules.organizationId, org.id));
    const result = recommendProduct(parsed.data.need, graphs, new Set(rules.filter((r) => r.active).map((r) => `${r.sourceProductId}:${r.destinationProductId}`)));
    return json({ ...result, basis: "verified product facts only" }, 200, cors);
  });
});
