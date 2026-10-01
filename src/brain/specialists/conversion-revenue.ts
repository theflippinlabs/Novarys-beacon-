import { and, eq, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { experiments } from "@/db/schema";
import { kpis } from "@/services/metrics";
import { loadAvailability, loadOpenOpportunities, loadProducts, opportunityFinding, ruleFinding, type OppRow, type ProductRow } from "../common";
import type { Coverage, Finding, SpecialistReport } from "../types";

/**
 * Conversion and revenue specialist: first-party tracking per product,
 * signups against the previous window, tracked visitors without signups,
 * experiments ready for a decision, and the CTA (conversion) opportunities.
 */
export const CONVERSION_TYPES = ["CONVERSION"];
export const CONVERSION_WINDOW_DAYS = 28;
/** A signup drop is flagged from this share lost, when the previous window had at least MIN_PREV_SIGNUPS. */
export const SIGNUP_DROP = 0.3;
export const MIN_PREV_SIGNUPS = 20;
/** Visitors without a single signup are flagged from this many visitors. */
export const MIN_VISITORS_NO_SIGNUP = 50;

export type ConversionRevenueSignals = {
  products: { product: ProductRow; events: number }[];
  trackerKey: boolean;
  events: boolean;
  revenueConnected: boolean;
  revenue: boolean;
  visitors: { now: number | null; prev: number | null };
  signups: { now: number | null; prev: number | null };
  readyExperiments: { id: string; name: string }[];
  opportunities: OppRow[];
};

export async function collectConversionRevenue(tx: Tx, organizationId: string, now: Date): Promise<ConversionRevenueSignals> {
  const prods = await loadProducts(tx, organizationId);
  const avail = await loadAvailability(tx, organizationId);
  const k = await kpis(tx, organizationId, { days: CONVERSION_WINDOW_DAYS, end: now });
  const perProduct = await tx.execute<{ product_id: string; n: number }>(sql`select product_id, count(*)::int as n from conversion_events where organization_id = ${organizationId} group by product_id`);
  const ready = await tx
    .select({ id: experiments.id, name: experiments.name })
    .from(experiments)
    .where(and(eq(experiments.organizationId, organizationId), inArray(experiments.status, ["READY_FOR_REVIEW"])))
    .orderBy(experiments.createdAt)
    .limit(5);
  const opps = await loadOpenOpportunities(tx, organizationId, CONVERSION_TYPES);
  const v = (kp: { state: string; now: number | null; prev: number | null }) => (kp.state === "OK" ? { now: kp.now, prev: kp.prev } : { now: null, prev: null });
  return {
    products: prods.map((p) => ({ product: p, events: Number(perProduct.rows.find((r) => r.product_id === p.id)?.n ?? 0) })),
    trackerKey: avail.trackerKey,
    events: avail.events,
    revenueConnected: avail.revenueConnected,
    revenue: avail.revenue,
    visitors: v(k.acquisition.visitors),
    signups: v(k.acquisition.signups),
    readyExperiments: ready,
    opportunities: opps,
  };
}

export function analyzeConversionRevenue(s: ConversionRevenueSignals): SpecialistReport {
  const findings: Finding[] = [];
  const missing: string[] = [];
  for (const pp of s.products) {
    if (pp.events > 0) continue;
    const href = `/products/${pp.product.slug}/tracking`;
    findings.push(
      ruleFinding("conversion_revenue", `conv:no_tracker:${pp.product.id}`, {
        title: "Install the Beacon tracker on {product}",
        summary: "No visit or conversion event was ever received from {product}, so its conversions and the impact of any action cannot be measured.",
        vars: { product: pp.product.name },
        severity: "MEDIUM",
        effort: 2,
        evidence: [{ label: "Tracked events (all time)", value: "0", href }],
        action: { label: "Open tracking", href, kind: "OPEN" },
        productId: pp.product.id,
      }),
    );
  }
  const sNow = s.signups.now;
  const sPrev = s.signups.prev;
  if (sNow !== null && sPrev !== null && sPrev >= MIN_PREV_SIGNUPS && (sPrev - sNow) / sPrev >= SIGNUP_DROP)
    findings.push(
      ruleFinding("conversion_revenue", "conv:signup_drop", {
        title: "Signups fell from {prev} to {now} over the last {days} days",
        summary: "Compare the pages, channels and releases of both windows before acting: this is a measured change, not its cause.",
        vars: { prev: sPrev, now: sNow, days: CONVERSION_WINDOW_DAYS },
        severity: "HIGH",
        effort: 3,
        evidence: [
          { label: "Signups (last 28 days)", value: String(sNow), href: "/conversions" },
          { label: "Signups (previous 28 days)", value: String(sPrev) },
        ],
        action: { label: "Open conversions", href: "/conversions", kind: "PROPOSE_RECOMMENDATION" },
        target: { productId: null, opportunityType: "CONVERSION" },
      }),
    );
  const vNow = s.visitors.now;
  if (vNow !== null && vNow >= MIN_VISITORS_NO_SIGNUP && sNow === 0)
    findings.push(
      ruleFinding("conversion_revenue", "conv:no_signups", {
        title: "{visitors} tracked visitors and no signup in the last {days} days",
        summary: "Check that the signup event is sent by your product, then review the calls to action on the most visited pages.",
        vars: { visitors: vNow, days: CONVERSION_WINDOW_DAYS },
        severity: "HIGH",
        effort: 2,
        evidence: [
          { label: "Visitors (last 28 days)", value: String(vNow), href: "/conversions" },
          { label: "Signups (last 28 days)", value: "0" },
        ],
        action: { label: "Open conversions", href: "/conversions", kind: "OPEN" },
      }),
    );
  for (const e of s.readyExperiments)
    findings.push(
      ruleFinding("conversion_revenue", `conv:experiment_ready:${e.id}`, {
        title: "Decide on the experiment {name}",
        summary: "It reached its planned sample size; a person reviews the result and decides.",
        vars: { name: e.name },
        severity: "MEDIUM",
        effort: 1,
        evidence: [{ label: "Experiment status", value: "Ready for review", href: "/autopilot#experiments" }],
        action: { label: "Open experiments", href: "/autopilot#experiments", kind: "OPEN" },
      }),
    );
  for (const o of s.opportunities) findings.push(opportunityFinding("conversion_revenue", o));

  if (!s.events) missing.push(s.trackerKey ? "First tracked events" : "Beacon tracker events");
  if (!s.revenue) missing.push(s.revenueConnected ? "First revenue events" : "A revenue source (Stripe or the revenue API)");
  const coverage: Coverage = !s.products.length || (!s.events && !s.revenue) ? "NOT_CONNECTED" : missing.length ? "PARTIAL" : "MEASURED";
  if (!s.products.length) missing.unshift("A product");
  return { specialist: "conversion_revenue", coverage, missing, findings };
}
