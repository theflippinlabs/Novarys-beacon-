import { can, type Role } from "@/lib/auth/rbac";
import type { AgentTool } from "../types";
import { addCompetitorTool, addComparisonFactTool, addPricingPlanTool, addProductFacet, addProductFaq, addProductSource } from "./knowledge";
import { addDistributionTargetTool, listDistributionTargets, setDistributionTargetStatus } from "./distribution";
import { addQueryTool, generateQuerySuggestions, getSeoAudits, listPlannedPages, listQueries, queueSeoAudit, syncPagePlanTool } from "./discovery";
import { createContentDraft, getContent, listContent, regenerateContentDraft } from "./content";
import { generateOpportunities, getOpportunity, listOpportunities, setOpportunityStatusTool } from "./opportunities";
import { getAiVisibility, getAutopilot, getConversionsSummary, getRevenueSummary, queueAiVisibilityTests } from "./growth";
import { createProductTool, getProduct, listProductPhotos, listProducts, recomputeBeaconScore, setProductLogoTool, updateProductTool } from "./products";
import { getWorkspaceOverview } from "./overview";

/**
 * Every tool the agent may call. Order is stable (it is part of the cached prompt prefix):
 * read tools first, then write tools, each grouped by area. Human-only steps (approving or
 * publishing content, verifying facts, external submissions, payouts, deletions, members,
 * integrations/keys, org settings) deliberately have no tool.
 */
export const AGENT_TOOLS: AgentTool[] = [
  // Read
  getWorkspaceOverview,
  listProducts,
  getProduct,
  listProductPhotos,
  listQueries,
  listPlannedPages,
  getSeoAudits,
  listOpportunities,
  getOpportunity,
  listContent,
  getContent,
  listDistributionTargets,
  getAiVisibility,
  getConversionsSummary,
  getRevenueSummary,
  getAutopilot,
  // Write: products & knowledge graph (facts are always saved UNVERIFIED)
  createProductTool,
  updateProductTool,
  addProductFacet,
  addPricingPlanTool,
  addProductFaq,
  addProductSource,
  addCompetitorTool,
  addComparisonFactTool,
  setProductLogoTool,
  // Write: discovery
  addQueryTool,
  generateQuerySuggestions,
  syncPagePlanTool,
  queueSeoAudit,
  recomputeBeaconScore,
  // Write: opportunities & content (never approve or publish)
  generateOpportunities,
  setOpportunityStatusTool,
  createContentDraft,
  regenerateContentDraft,
  // Write: distribution (never submits externally) & AI visibility
  addDistributionTargetTool,
  setDistributionTargetStatus,
  queueAiVisibilityTests,
];

/** The tools a member with `role` may use (RBAC permission per tool). */
export function toolsForRole(role: Role): AgentTool[] {
  return AGENT_TOOLS.filter((t) => can(role, t.permission));
}
