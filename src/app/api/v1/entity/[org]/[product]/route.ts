import { and, eq } from "drizzle-orm";
import { asSystem } from "@/db";
import { products } from "@/db/schema";
import { buildAnswerBlocks, buildEntityProfile } from "@/core/geo/entity";
import { loadProductGraph } from "@/core/knowledge/load";
import { verifiedOnly } from "@/core/knowledge/types";
import { err, ipHashOf, limited } from "@/lib/http";
import { orgBySlug } from "@/services/public";

export const dynamic = "force-dynamic";

/** Public machine-readable entity profile + answer blocks (verified facts only). */
export async function GET(req: Request, { params }: { params: Promise<{ org: string; product: string }> }) {
  const rl = await limited(`entity:ip:${ipHashOf(req)}`, 120, 60);
  if (rl) return rl;
  const { org: orgSlug, product: slug } = await params;
  return asSystem(async (tx) => {
    const org = await orgBySlug(tx, orgSlug);
    if (!org) return err(404, "Not found");
    const p = await tx.query.products.findFirst({ where: and(eq(products.organizationId, org.id), eq(products.slug, slug)) });
    if (!p || !p.onboardingCompletedAt) return err(404, "Not found");
    const g = verifiedOnly((await loadProductGraph(tx, org.id, p.id))!);
    const body = { ...buildEntityProfile(g, org.branding.displayName ?? org.name), answers: buildAnswerBlocks(g).answers, generatedAt: new Date().toISOString(), policy: "Only human-verified facts are published. Unknown facts are listed under `unknowns`." };
    return new Response(JSON.stringify(body, null, 2), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300", "access-control-allow-origin": "*" } });
  });
}
