import "server-only";
import { notFound } from "next/navigation";
import { and, eq } from "drizzle-orm";
import { withOrg, type Tx } from "@/db";
import { products } from "@/db/schema";
import { requireAuth } from "@/lib/auth/session";
import type { AuthContext } from "@/lib/auth/service";
import { can, type Permission } from "@/lib/auth/rbac";

export type SP = Record<string, string | string[] | undefined>;
export const sp1 = (sp: SP, k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : undefined);
export const daysParam = (sp: SP, def = 28) => {
  const d = Number(sp1(sp, "days"));
  return [7, 28, 90, 365].includes(d) ? d : def;
};

/** Authenticated, tenant-scoped data loading for a page. */
export async function pageData<T>(fn: (tx: Tx, ctx: AuthContext) => Promise<T>): Promise<{ ctx: AuthContext; data: T; can: (p: Permission) => boolean }> {
  const ctx = await requireAuth();
  const data = await withOrg(ctx.org.id, (tx) => fn(tx, ctx));
  return { ctx, data, can: (p) => can(ctx.role, p) };
}

export async function productOr404(tx: Tx, organizationId: string, slug: string) {
  const p = await tx.query.products.findFirst({ where: and(eq(products.organizationId, organizationId), eq(products.slug, slug)) });
  if (!p) notFound();
  return p;
}
