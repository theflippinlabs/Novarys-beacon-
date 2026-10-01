import { withOrg } from "@/db";
import { getAuthContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { err, json, limited } from "@/lib/http";
import { paletteContext, searchWorkspace } from "@/services/search";

export const dynamic = "force-dynamic";

/**
 * Command palette search (read-only). Authenticated by the session cookie,
 * tenant-scoped by RLS (`withOrg`), limited per member and capped in size.
 * `?q=` searches entities; `?context=1` returns what the palette needs to
 * offer commands (products, crawlable ones, latest audit, permissions).
 */
export async function GET(req: Request) {
  const ctx = await getAuthContext();
  if (!ctx) return err(401, "Not signed in");
  if (!can(ctx.role, "read")) return err(403, "Forbidden");
  const tooMany = await limited(`search:${ctx.user.id}`, 120, 60);
  if (tooMany) return tooMany;
  const url = new URL(req.url);
  if (url.searchParams.get("context") === "1") {
    const data = await withOrg(ctx.org.id, (tx) => paletteContext(tx, ctx.org.id));
    return json({
      ...data,
      can: { productWrite: can(ctx.role, "product:write"), jobRun: can(ctx.role, "job:run"), contentWrite: can(ctx.role, "content:write") },
    });
  }
  const q = (url.searchParams.get("q") ?? "").slice(0, 100);
  if (!q.trim()) return json({ results: [] });
  const results = await withOrg(ctx.org.id, (tx) => searchWorkspace(tx, ctx.org.id, q));
  return json({ results });
}
