import type { Tx } from "@/db";
import type { SpecialistKey, SpecialistReport } from "../types";
import { analyzeAiVisibility, collectAiVisibility } from "./ai-visibility";
import { analyzeCompetitors, collectCompetitors } from "./competitors";
import { analyzeContentKnowledge, collectContentKnowledge } from "./content-knowledge";
import { analyzeConversionRevenue, collectConversionRevenue } from "./conversion-revenue";
import { analyzeDistributionGrowth, collectDistributionGrowth } from "./distribution-growth";
import { analyzeTechnicalSeo, collectTechnicalSeo } from "./technical-seo";

/**
 * Each specialist reads its signals (sequential queries on one tenant
 * transaction) and analyses them with a pure function, so the analysis is
 * unit-tested on fixtures and never needs an LLM.
 */
const RUNNERS: Record<SpecialistKey, (tx: Tx, organizationId: string, now: Date) => Promise<SpecialistReport>> = {
  technical_seo: async (tx, org, now) => analyzeTechnicalSeo(await collectTechnicalSeo(tx, org, now)),
  content_knowledge: async (tx, org) => analyzeContentKnowledge(await collectContentKnowledge(tx, org)),
  ai_visibility: async (tx, org, now) => analyzeAiVisibility(await collectAiVisibility(tx, org, now)),
  competitors: async (tx, org, now) => analyzeCompetitors(await collectCompetitors(tx, org, now)),
  conversion_revenue: async (tx, org, now) => analyzeConversionRevenue(await collectConversionRevenue(tx, org, now)),
  distribution_growth: async (tx, org, now) => analyzeDistributionGrowth(await collectDistributionGrowth(tx, org, now)),
};

/** Deterministic report of one specialist (call inside one `withOrg` transaction). */
export function runSpecialist(tx: Tx, organizationId: string, key: SpecialistKey, now = new Date()): Promise<SpecialistReport> {
  return RUNNERS[key](tx, organizationId, now);
}
