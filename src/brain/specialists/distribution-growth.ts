import { sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { isoDate, loadAvailability, loadOpenOpportunities, loadProducts, opportunityFinding, ruleFinding, type OppRow } from "../common";
import type { Coverage, Finding, SpecialistReport } from "../types";

/**
 * Distribution and growth specialist: distribution targets waiting for a
 * human (submission approval, follow-ups), referral codes, cross-sell rules
 * between products, and the distribution, cross-sell and referral
 * opportunities. Submissions are always made by a person.
 */
export const DISTRIBUTION_TYPES = ["DISTRIBUTION", "CROSS_SELL", "REFERRAL"];

export type DistributionGrowthSignals = {
  today: string;
  products: number;
  events: boolean;
  targets: number;
  awaitingApproval: number;
  followUpsDue: number;
  activeReferralCodes: number;
  activeCrossSellRules: number;
  opportunities: OppRow[];
};

export async function collectDistributionGrowth(tx: Tx, organizationId: string, now: Date): Promise<DistributionGrowthSignals> {
  const prods = await loadProducts(tx, organizationId);
  const avail = await loadAvailability(tx, organizationId);
  const today = isoDate(now)!;
  const t = (
    await tx.execute<{ total: number; awaiting: number; due: number }>(sql`
      select count(*)::int as total,
        (count(*) filter (where status = 'PREPARED' and submission_approved_at is null))::int as awaiting,
        (count(*) filter (where status = 'FOLLOW_UP' and follow_up_on is not null and follow_up_on <= ${today}::date))::int as due
      from distribution_targets where organization_id = ${organizationId}`)
  ).rows[0];
  const codes = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from referral_codes where organization_id = ${organizationId} and active`)).rows[0];
  const rules = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from cross_sell_rules where organization_id = ${organizationId} and active`)).rows[0];
  const opps = await loadOpenOpportunities(tx, organizationId, DISTRIBUTION_TYPES);
  return {
    today,
    products: prods.length,
    events: avail.events,
    targets: Number(t?.total ?? 0),
    awaitingApproval: Number(t?.awaiting ?? 0),
    followUpsDue: Number(t?.due ?? 0),
    activeReferralCodes: Number(codes?.n ?? 0),
    activeCrossSellRules: Number(rules?.n ?? 0),
    opportunities: opps,
  };
}

export function analyzeDistributionGrowth(s: DistributionGrowthSignals): SpecialistReport {
  const findings: Finding[] = [];
  const missing: string[] = [];
  if (s.awaitingApproval > 0)
    findings.push(
      ruleFinding("distribution_growth", "dist:awaiting_approval", {
        title: "Approve or reject the {n} prepared distribution submissions",
        summary: "Listings are prepared; a person approves each submission and submits it on the external site.",
        vars: { n: s.awaitingApproval },
        severity: "MEDIUM",
        effort: 2,
        evidence: [{ label: "Prepared submissions awaiting approval", value: String(s.awaitingApproval), href: "/distribution" }],
        action: { label: "Open distribution", href: "/distribution", kind: "OPEN" },
      }),
    );
  if (s.followUpsDue > 0)
    findings.push(
      ruleFinding("distribution_growth", "dist:follow_ups", {
        title: "Follow up on {n} distribution targets",
        summary: "Their follow-up date is today or past.",
        vars: { n: s.followUpsDue },
        severity: "LOW",
        effort: 1,
        evidence: [
          { label: "Follow-ups due", value: String(s.followUpsDue), href: "/distribution" },
          { label: "As of", value: s.today },
        ],
        action: { label: "Open distribution", href: "/distribution", kind: "OPEN" },
      }),
    );
  const hasOpp = (type: string) => s.opportunities.some((o) => o.type === type);
  if (s.products >= 2 && s.activeCrossSellRules === 0 && !hasOpp("CROSS_SELL"))
    findings.push(
      ruleFinding("distribution_growth", "growth:no_cross_sell", {
        title: "Connect your {n} products with a cross-sell rule",
        summary: "No active cross-sell rule recommends one of your products to the users of another (consent-gated and capped).",
        vars: { n: s.products },
        severity: "LOW",
        effort: 2,
        evidence: [
          { label: "Products", value: String(s.products) },
          { label: "Active cross-sell rules", value: "0", href: "/autopilot#cross-sell" },
        ],
        action: { label: "Open cross-sell", href: "/autopilot#cross-sell", kind: "OPEN" },
      }),
    );
  if (s.products > 0 && s.activeReferralCodes === 0 && !hasOpp("REFERRAL"))
    findings.push(
      ruleFinding("distribution_growth", "growth:no_referral", {
        title: "Create a referral code",
        summary: "Referral and affiliate traffic is only attributed through referral codes.",
        severity: "LOW",
        effort: 1,
        evidence: [{ label: "Active referral codes", value: "0", href: "/referrals" }],
        action: { label: "Open referrals", href: "/referrals", kind: "OPEN" },
      }),
    );
  for (const o of s.opportunities) findings.push(opportunityFinding("distribution_growth", o));

  let coverage: Coverage;
  if (!s.products) {
    coverage = "NOT_CONNECTED";
    missing.push("A product");
  } else if (!s.events) {
    coverage = "NOT_CONNECTED";
    missing.push("Beacon tracker events");
  } else if (s.targets > 0 || s.activeReferralCodes > 0 || s.activeCrossSellRules > 0) coverage = "MEASURED";
  else {
    coverage = "PARTIAL";
    missing.push("Distribution targets or referral codes");
  }
  return { specialist: "distribution_growth", coverage, missing, findings };
}
