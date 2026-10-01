import { withOrg } from "@/db";
import { getAuthContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { err, ipHashOf, json, limited, sameOrigin } from "@/lib/http";
import { insertImage, MAX_UPLOAD_BYTES, prepareImage } from "@/services/media";

export const dynamic = "force-dynamic";

/** Photo attached in the agent chat: stored PRIVATE (only members of the organisation can view it). */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return err(403, "Cross-origin request refused");
  const ctx = await getAuthContext();
  if (!ctx) return err(401, "Not signed in");
  if (!can(ctx.role, "read")) return err(403, "Forbidden");
  const tooMany = await limited(`agent-upload:${ctx.user.id}`, 40, 600);
  if (tooMany) return tooMany;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES + 64_000) return err(413, "Photo too large");

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return err(400, "No photo received");
  if (file.size > MAX_UPLOAD_BYTES) return err(413, "Photo too large");
  try {
    const actor = { organizationId: ctx.org.id, userId: ctx.user.id, actorType: "USER" as const, ipHash: ipHashOf(req) };
    const data = Buffer.from(await file.arrayBuffer());
    // Re-encode before opening the transaction (no connection held during sharp work).
    const img = await prepareImage({ data, filename: file.name || "photo", visibility: "PRIVATE" });
    const out = await withOrg(ctx.org.id, (tx) => insertImage(tx, actor, img));
    return json({ id: out.id, url: out.url, width: out.width, height: out.height });
  } catch (e) {
    return err(400, (e as Error).message);
  }
}
