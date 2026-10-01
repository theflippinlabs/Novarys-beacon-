import { withOrg } from "@/db";
import { isUuid } from "@/core/media/image";
import { getAuthContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { err, ipHashOf, limited } from "@/lib/http";
import { exportApprovedAsset } from "@/services/content-export";

export const dynamic = "force-dynamic";

/**
 * "Export production-ready content" for teams publishing outside Beacon:
 * GET /api/content/{id}/export?format=zip (content.md, structured-data.jsonld,
 * meta.json) or ?format=md (one Markdown file with the JSON-LD). Signed-in
 * members of the owning organisation only; approved or published content only.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await getAuthContext();
  if (!ctx) return err(401, "Not signed in");
  if (!can(ctx.role, "read")) return err(403, "You do not have permission to do that.");
  if (!isUuid(id)) return err(404, "Not found");
  const tooMany = await limited(`content-export:${ctx.user.id}`, 60, 600);
  if (tooMany) return tooMany;
  const format = new URL(req.url).searchParams.get("format") === "md" ? "md" : "zip";
  try {
    const actor = { organizationId: ctx.org.id, userId: ctx.user.id, actorType: "USER" as const, ipHash: ipHashOf(req) };
    const out = await withOrg(ctx.org.id, (tx) => exportApprovedAsset(tx, actor, id, format));
    return new Response(Buffer.from(out.body), {
      status: 200,
      headers: { "content-type": out.contentType, "content-disposition": `attachment; filename="${out.filename}"`, "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  } catch (e) {
    const m = (e as Error).message;
    return err(/not found/i.test(m) ? 404 : 409, m);
  }
}
