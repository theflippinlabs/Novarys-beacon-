import { sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { availableProviders } from "@/ai/registry";
import { loadOpenOpportunities, loadProducts, opportunityFinding, pct, ruleFinding, type OppRow, type ProductRow } from "../common";
import type { Coverage, Finding, SpecialistReport } from "../types";

/**
 * AI visibility and GEO specialist: sampled AI answers (official APIs) over
 * the last 30 days, the share that mention each product, whether the
 * organisation's own sites are cited, and the AI-visibility and citation
 * opportunities. Samples are observations, never totals.
 */
export const AI_VISIBILITY_TYPES = ["AI_VISIBILITY_GAP", "CITATION"];
export const AI_WINDOW_DAYS = 30;
/** Fewer sampled answers than this are not enough to judge a mention rate. */
export const MIN_AI_SAMPLES = 10;

export type AiVisibilitySignals = {
  providers: number;
  activePrompts: number;
  tests: number;
  orgMentioned: number;
  ownDomainCited: number;
  products: { product: ProductRow; tests: number; mentioned: number }[];
  opportunities: OppRow[];
};

export async function collectAiVisibility(tx: Tx, organizationId: string, now: Date): Promise<AiVisibilitySignals> {
  const prods = await loadProducts(tx, organizationId);
  const providers = (await availableProviders(tx, organizationId)).length;
  const since = new Date(now.getTime() - AI_WINDOW_DAYS * 86_400_000).toISOString();
  const prompts = (await tx.execute<{ n: number }>(sql`select count(*)::int as n from ai_visibility_prompts where organization_id = ${organizationId} and active`)).rows[0];
  const totals = (
    await tx.execute<{ tests: number; org_mentioned: number; own_cited: number }>(sql`
      select count(*)::int as tests, (count(*) filter (where org_mentioned))::int as org_mentioned, (count(*) filter (where own_domain_cited))::int as own_cited
      from ai_visibility_tests where organization_id = ${organizationId} and ran_at >= ${since}`)
  ).rows[0];
  // Per product: answers to that product's prompts, and those mentioning it.
  const perProduct = await tx.execute<{ product_id: string; tests: number; mentioned: number }>(sql`
    select pr.product_id, count(*)::int as tests,
      (count(*) filter (where exists (select 1 from jsonb_array_elements(t.products_mentioned) m where m->>'productId' = pr.product_id::text)))::int as mentioned
    from ai_visibility_tests t join ai_visibility_prompts pr on pr.id = t.prompt_id
    where t.organization_id = ${organizationId} and t.ran_at >= ${since} and pr.product_id is not null
    group by pr.product_id`);
  const opps = await loadOpenOpportunities(tx, organizationId, AI_VISIBILITY_TYPES);
  return {
    providers,
    activePrompts: Number(prompts?.n ?? 0),
    tests: Number(totals?.tests ?? 0),
    orgMentioned: Number(totals?.org_mentioned ?? 0),
    ownDomainCited: Number(totals?.own_cited ?? 0),
    products: prods.map((p) => {
      const r = perProduct.rows.find((x) => x.product_id === p.id);
      return { product: p, tests: Number(r?.tests ?? 0), mentioned: Number(r?.mentioned ?? 0) };
    }),
    opportunities: opps,
  };
}

export function analyzeAiVisibility(s: AiVisibilitySignals): SpecialistReport {
  const findings: Finding[] = [];
  const missing: string[] = [];
  const href = "/ai-visibility";
  if (s.providers > 0 && s.activePrompts === 0)
    findings.push(
      ruleFinding("ai_visibility", "ai:no_prompts", {
        title: "Add the prompts your buyers ask AI assistants",
        summary: "An AI provider is connected but no active prompt is tested, so AI visibility is not measured.",
        severity: "MEDIUM",
        effort: 1,
        evidence: [{ label: "Active prompts", value: "0", href }],
        action: { label: "Open AI visibility", href, kind: "OPEN" },
      }),
    );
  else if (s.providers > 0 && s.tests === 0)
    findings.push(
      ruleFinding("ai_visibility", "ai:no_recent_tests", {
        title: "Run the AI visibility tests",
        summary: "No AI answer was sampled in the last {days} days for the {n} active prompts.",
        vars: { days: AI_WINDOW_DAYS, n: s.activePrompts },
        severity: "MEDIUM",
        effort: 1,
        evidence: [
          { label: "Active prompts", value: String(s.activePrompts), href },
          { label: "Sampled answers (30 days)", value: "0" },
        ],
        action: { label: "Open AI visibility", href, kind: "OPEN" },
      }),
    );

  for (const pp of s.products) {
    if (pp.tests < MIN_AI_SAMPLES) continue;
    const rate = pp.mentioned / pp.tests;
    if (rate >= 0.5) continue;
    findings.push(
      ruleFinding("ai_visibility", `ai:low_mentions:${pp.product.id}`, {
        title: pp.mentioned === 0 ? "{product} is absent from its sampled AI answers" : "{product} appears in only {rate} of its sampled AI answers",
        summary: "Answer engines rarely name {product} for the prompts you track; sourced public information and citations raise the chance of being mentioned.",
        vars: { product: pp.product.name, rate: pct(rate) },
        severity: pp.mentioned === 0 ? "HIGH" : "MEDIUM",
        effort: 3,
        evidence: [
          { label: "Sampled answers (30 days)", value: String(pp.tests), href },
          { label: "Answers mentioning the product", value: String(pp.mentioned) },
          { label: "Mention rate", value: pct(rate) },
        ],
        action: { label: "Open AI visibility", href, kind: "PROPOSE_RECOMMENDATION" },
        productId: pp.product.id,
        target: { productId: pp.product.id, opportunityType: "AI_VISIBILITY_GAP" },
      }),
    );
  }
  if (s.tests >= MIN_AI_SAMPLES && s.ownDomainCited === 0)
    findings.push(
      ruleFinding("ai_visibility", "ai:own_domain_not_cited", {
        title: "Get your own sites cited by answer engines",
        summary: "None of the {n} sampled AI answers of the last {days} days cited one of your domains.",
        vars: { n: s.tests, days: AI_WINDOW_DAYS },
        severity: "MEDIUM",
        effort: 3,
        evidence: [
          { label: "Sampled answers (30 days)", value: String(s.tests), href },
          { label: "Answers citing your domains", value: "0" },
        ],
        action: { label: "Open AI visibility", href, kind: "PROPOSE_RECOMMENDATION" },
        target: { productId: null, opportunityType: "CITATION" },
      }),
    );
  for (const o of s.opportunities) findings.push(opportunityFinding("ai_visibility", o));

  let coverage: Coverage;
  if (s.providers === 0) {
    coverage = "NOT_CONNECTED";
    missing.push("An AI provider key (Settings, Integrations)");
  } else if (s.activePrompts === 0 || s.tests < MIN_AI_SAMPLES) {
    coverage = "PARTIAL";
    if (s.activePrompts === 0) missing.push("Active AI visibility prompts");
    missing.push("10 sampled AI answers in the last 30 days");
  } else coverage = "MEASURED";
  return { specialist: "ai_visibility", coverage, missing, findings };
}
