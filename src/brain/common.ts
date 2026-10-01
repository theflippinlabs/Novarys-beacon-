import { and, desc, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db";
import { opportunities, products } from "@/db/schema";
import { availability } from "@/services/metrics";
import type { Evidence, Finding, FindingSeverity, SpecialistKey } from "./types";

/**
 * Shared building blocks of the specialists: the common reads (products, open
 * opportunities of the specialist's categories, data availability) and the
 * conversion of an open opportunity into a finding.
 */

export type ProductRow = { id: string; slug: string; name: string; domain: string | null };
export type OppRow = Pick<
  typeof opportunities.$inferSelect,
  "id" | "productId" | "queryId" | "type" | "category" | "title" | "problem" | "evidence" | "potential" | "impact" | "urgency" | "effort" | "priorityScore" | "sources" | "nextAction"
>;
export type Availability = Awaited<ReturnType<typeof availability>>;

/** Open opportunities are capped per specialist (highest priority first). */
export const MAX_OPPORTUNITIES = 15;

export async function loadProducts(tx: Tx, organizationId: string): Promise<ProductRow[]> {
  return tx.select({ id: products.id, slug: products.slug, name: products.name, domain: products.domain }).from(products).where(eq(products.organizationId, organizationId)).orderBy(products.name);
}

/** Open opportunities of the given types, highest priority first (deterministic order). */
export async function loadOpenOpportunities(tx: Tx, organizationId: string, types: string[], limit = MAX_OPPORTUNITIES): Promise<OppRow[]> {
  if (!types.length) return [];
  return tx
    .select({
      id: opportunities.id,
      productId: opportunities.productId,
      queryId: opportunities.queryId,
      type: opportunities.type,
      category: opportunities.category,
      title: opportunities.title,
      problem: opportunities.problem,
      evidence: opportunities.evidence,
      potential: opportunities.potential,
      impact: opportunities.impact,
      urgency: opportunities.urgency,
      effort: opportunities.effort,
      priorityScore: opportunities.priorityScore,
      sources: opportunities.sources,
      nextAction: opportunities.nextAction,
    })
    .from(opportunities)
    .where(and(eq(opportunities.organizationId, organizationId), eq(opportunities.status, "OPEN"), inArray(opportunities.type, types)))
    .orderBy(desc(opportunities.priorityScore), opportunities.fingerprint)
    .limit(limit);
}

export const loadAvailability = (tx: Tx, organizationId: string) => availability(tx, organizationId, null);

/** Severity of an opportunity: maximal impact and urgency is critical, otherwise its potential. */
export function opportunitySeverity(o: Pick<OppRow, "impact" | "urgency" | "potential">): FindingSeverity {
  if (o.impact >= 5 && o.urgency >= 5) return "CRITICAL";
  return o.potential;
}

const uniq = <T,>(xs: T[]) => [...new Set(xs)];

/** An open opportunity as a finding: its own evidence, a target for the estimators and a "Propose" action. */
export function opportunityFinding(specialist: SpecialistKey, o: OppRow, extra: Evidence[] = []): Finding {
  const queryIds = uniq([...(o.sources.queryIds ?? []), ...(o.queryId ? [o.queryId] : [])]).slice(0, 50);
  return {
    id: `${specialist}:opp:${o.id}`,
    key: `opp:${o.id}`,
    specialist,
    title: o.title,
    summary: o.problem,
    severity: opportunitySeverity(o),
    effort: Math.min(5, Math.max(1, o.effort)),
    evidence: [...o.evidence.slice(0, 8).map((e) => ({ label: e.label, value: e.value })), ...extra],
    action: { label: "Open the opportunity", href: `/opportunities/${o.id}`, kind: "PROPOSE_RECOMMENDATION" },
    opportunityId: o.id,
    productId: o.productId,
    target: { productId: o.productId, ...(queryIds.length ? { queryIds } : {}), opportunityType: o.type },
  };
}

/** A finding produced by a specialist rule (not an opportunity). */
export function ruleFinding(specialist: SpecialistKey, key: string, f: Omit<Finding, "id" | "key" | "specialist">): Finding {
  return { id: `${specialist}:${key}`, key, specialist, ...f };
}

/** "45%" from a ratio (one decimal below 10%). */
export function pct(ratio: number): string {
  const v = ratio * 100;
  return `${v < 10 && v > 0 ? Math.round(v * 10) / 10 : Math.round(v)}%`;
}

export const isoDate = (d: Date | string | null | undefined) => (d ? (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10) : null);

export const daysBetween = (a: Date, b: Date) => Math.floor((b.getTime() - a.getTime()) / 86_400_000);
