import { and, eq } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db";
import { products } from "@/db/schema";
import type { Actor } from "@/lib/audit";
import { can } from "@/lib/auth/rbac";
import type { Kpi } from "@/services/metrics";
import type { AgentTool, AgentToolContext } from "../types";

/** Default cap for list results sent back to the model. */
export const LIST_CAP = 25;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: string) => UUID_RE.test(v);

// ── Input schema helpers (kept to plain JSON-schema-friendly types) ─────
export const productRef = (what = "The product") => z.string().trim().min(1).max(100).describe(`${what}: its slug (preferred, e.g. "novus-live") or its id. Use list_products to find it.`);
export const optionalProductRef = (what = "Only this product") => z.string().trim().min(1).max(100).optional().describe(`${what}: slug or id. Omit for all products.`);
export const idRef = (what: string) => z.string().trim().regex(UUID_RE, "must be an id (uuid)").describe(what);
export const limitInput = z.number().int().min(1).max(LIST_CAP).optional().describe(`Maximum number of items to return (1 to ${LIST_CAP}, default ${LIST_CAP}).`);
export const daysInput = z.number().int().min(1).max(365).optional().describe("Reporting window in days (e.g. 7, 28 or 90; default 28). Compared with the previous window of equal length.");

// ── Output helpers ──────────────────────────────────────────────────────
/** Compact list with a `truncated` flag so the model knows more exist. */
export function capped<T>(items: T[], limit = LIST_CAP) {
  return { items: items.slice(0, limit), total: items.length, truncated: items.length > limit };
}

export function trim(s: string | null | undefined, max = 300): string | null {
  if (s === null || s === undefined) return null;
  const v = s.trim();
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}

export function iso(d: Date | string | null | undefined): string | null {
  if (d === null || d === undefined) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

/**
 * A measured KPI, or an explicit "not connected" / "no data yet" marker, never
 * an estimate or a zero standing in for missing data. Money in several
 * currencies is returned per currency (never summed); a rate without
 * denominator is "n/a".
 */
export function kpi(k: Kpi, unit: "count" | "money_minor_units" | "ratio" = "count") {
  if (k.state === "NOT_CONNECTED") return { status: "not connected" as const, source: k.source };
  if (k.state === "NO_DATA_YET") return { status: "no data yet" as const, source: k.source };
  if (k.byCurrency && k.byCurrency.length > 1) return { byCurrency: k.byCurrency.map((c) => ({ currency: c.currency, now: c.now, previous: c.prev })), unit, source: k.source };
  return { now: k.now ?? ("n/a" as const), previous: k.prev, unit, ...(k.currency ? { currency: k.currency } : {}), source: k.source };
}

// ── Context helpers ─────────────────────────────────────────────────────
/** The audit actor for agent writes: every audit entry records `via: "agent"`. */
export const agentActor = (c: AgentToolContext): Actor => ({ ...c.actor, via: "agent" });

export function requirePermission(c: AgentToolContext, permission: AgentTool["permission"]) {
  if (!can(c.ctx.role, permission)) throw new Error(`Your role (${c.ctx.role}) does not allow this action (${permission}).`);
}

/** Resolve a product by slug or id within the caller's organisation. */
export async function resolveProduct(tx: Tx, organizationId: string, ref: string) {
  const v = ref.trim();
  const p = await tx.query.products.findFirst({ where: and(eq(products.organizationId, organizationId), isUuid(v) ? eq(products.id, v) : eq(products.slug, v.toLowerCase())) });
  if (!p) throw new Error(`Product not found: "${v}". Use list_products to see the available slugs.`);
  return p;
}

export async function resolveOptionalProduct(tx: Tx, organizationId: string, ref: string | undefined) {
  return ref ? resolveProduct(tx, organizationId, ref) : null;
}

export const productLinks = (slug: string) => ({ link: `/products/${slug}`, knowledgeLink: `/products/${slug}/knowledge` });
