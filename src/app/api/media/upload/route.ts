import { withOrg } from "@/db";
import { getAuthContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { err, ipHashOf, json, limited, sameOrigin } from "@/lib/http";
import { insertImage, MAX_UPLOAD_BYTES, mediaUrl, prepareImage, stageImages } from "@/services/media";

export const dynamic = "force-dynamic";

/**
 * Upload one public image from a form field (e.g. the product logo in
 * onboarding) without leaving the page: returns the absolute URL the field
 * then holds until the form is saved.
 */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return err(403, "Cross-origin request refused");
  const ctx = await getAuthContext();
  if (!ctx) return err(401, "Not signed in");
  if (!can(ctx.role, "product:write")) return err(403, "You do not have permission to do that.");
  const tooMany = await limited(`media-upload:${ctx.user.id}`, 60, 600);
  if (tooMany) return tooMany;
  if (Number(req.headers.get("content-length") ?? 0) > MAX_UPLOAD_BYTES + 64_000) return err(413, "Photo too large");

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) return err(400, "No photo received");
  if (file.size > MAX_UPLOAD_BYTES) return err(413, "Photo too large");
  const productId = typeof form?.get("productId") === "string" ? String(form?.get("productId")) : null;

  try {
    const actor = { organizationId: ctx.org.id, userId: ctx.user.id, actorType: "USER" as const, ipHash: ipHashOf(req) };
    const data = Buffer.from(await file.arrayBuffer());
    // Re-encode (and upload to object storage when configured) before opening the transaction; insertImage checks the product.
    const img = await prepareImage({ data, filename: file.name || "image", productId, visibility: "PUBLIC" });
    const out = await stageImages(ctx.org.id, [img], ([staged]) => withOrg(ctx.org.id, (tx) => insertImage(tx, actor, staged)));
    return json({ id: out.id, url: mediaUrl(out.id, true), width: out.width, height: out.height });
  } catch (e) {
    return err(400, (e as Error).message);
  }
}
