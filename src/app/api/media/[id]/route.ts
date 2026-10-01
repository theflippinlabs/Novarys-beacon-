import { eq } from "drizzle-orm";
import { asSystem } from "@/db";
import { media } from "@/db/schema";
import { isUuid } from "@/core/media/image";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { resolveSession } from "@/lib/auth/service";

export const dynamic = "force-dynamic";

const BASE_HEADERS = { "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'", "cross-origin-resource-policy": "cross-origin" };

function notFound() {
  return new Response("Not found", { status: 404, headers: { ...BASE_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

/**
 * Serves uploaded images. PUBLIC media is served to anyone holding the
 * (unguessable, random UUID) id; PRIVATE media only to the member who uploaded
 * it, signed in to the owning organisation. Lookup by id runs with system privileges because
 * the tenant is not known until the row is found.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) return notFound();
  const row = await asSystem(async (tx) => (await tx.select({ organizationId: media.organizationId, createdBy: media.createdBy, visibility: media.visibility, mime: media.mime, bytes: media.bytes }).from(media).where(eq(media.id, id.toLowerCase())).limit(1))[0]);
  if (!row) return notFound();
  if (row.visibility === "PRIVATE") {
    const ctx = await resolveSession(cookieValue(req, SESSION_COOKIE));
    // Private photos (agent chat attachments) are visible to their uploader only.
    if (!ctx || ctx.org.id !== row.organizationId || !row.createdBy || ctx.user.id !== row.createdBy) return notFound();
  }
  const etag = `"${id.toLowerCase()}"`;
  const headers: Record<string, string> = {
    ...BASE_HEADERS,
    "content-type": row.mime,
    "cache-control": row.visibility === "PUBLIC" ? "public, max-age=31536000, immutable" : "private, max-age=3600",
    etag,
  };
  if (row.visibility === "PRIVATE") headers.vary = "Cookie";
  const inm = req.headers.get("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) return new Response(null, { status: 304, headers });
  return new Response(new Uint8Array(row.bytes), { status: 200, headers: { ...headers, "content-length": String(row.bytes.length) } });
}
