import { eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { products } from "@/db/schema";
import { computeCompleteness } from "@/core/knowledge/completeness";
import { loadProductGraphs } from "@/core/knowledge/load";
import { loadAvailability, loadOpenOpportunities, opportunityFinding, pct, ruleFinding, type OppRow, type ProductRow } from "../common";
import type { Coverage, Finding, SpecialistReport } from "../types";

/**
 * Content and knowledge specialist: knowledge-graph completeness and
 * verification, the content pipeline (drafts waiting for a human, drafts in
 * checks) and the content-gap and knowledge opportunities.
 */
export const CONTENT_KNOWLEDGE_TYPES = ["CONTENT_GAP", "PRODUCT_KNOWLEDGE"];
/** Below this completeness a product's knowledge graph is flagged (when no knowledge opportunity covers it). */
export const COMPLETENESS_TARGET = 0.8;

export type ProductKnowledge = { product: ProductRow; completeness: number; missingItems: string[]; facts: number; verifiedFacts: number };

export type ContentKnowledgeSignals = {
  products: ProductKnowledge[];
  searchConnected: boolean;
  searchData: boolean;
  content: { awaitingApproval: number; inChecks: number; published: number; total: number };
  opportunities: OppRow[];
};

export async function collectContentKnowledge(tx: Tx, organizationId: string): Promise<ContentKnowledgeSignals> {
  const rows = await tx.select().from(products).where(eq(products.organizationId, organizationId)).orderBy(products.name);
  const graphs = await loadProductGraphs(tx, organizationId, rows);
  const avail = await loadAvailability(tx, organizationId);
  const c = (
    await tx.execute<{ awaiting: number; checks: number; published: number; total: number }>(sql`
      select (count(*) filter (where status = 'HUMAN_APPROVAL'))::int as awaiting,
             (count(*) filter (where status in ('FACT_CHECK', 'SEO_CHECK')))::int as checks,
             (count(*) filter (where status = 'PUBLISHED'))::int as published,
             count(*)::int as total
      from content_assets where organization_id = ${organizationId}`)
  ).rows[0];
  const opps = await loadOpenOpportunities(tx, organizationId, CONTENT_KNOWLEDGE_TYPES);
  return {
    products: graphs.map((g) => {
      const comp = computeCompleteness(g);
      return {
        product: { id: g.product.id, slug: g.product.slug, name: g.product.name, domain: g.product.domain },
        completeness: comp.score,
        missingItems: comp.missing.slice(0, 3).map((m) => m.label),
        facts: comp.items.reduce((a, i) => a + i.facts, 0),
        verifiedFacts: comp.items.reduce((a, i) => a + i.verifiedFacts, 0),
      };
    }),
    searchConnected: avail.searchConnected,
    searchData: avail.searchData,
    content: { awaitingApproval: Number(c?.awaiting ?? 0), inChecks: Number(c?.checks ?? 0), published: Number(c?.published ?? 0), total: Number(c?.total ?? 0) },
    opportunities: opps,
  };
}

export function analyzeContentKnowledge(s: ContentKnowledgeSignals): SpecialistReport {
  const findings: Finding[] = [];
  const missing: string[] = [];
  for (const pk of s.products) {
    const p = pk.product;
    const knowledge = `/products/${p.slug}/knowledge`;
    const hasKnowledgeOpp = s.opportunities.some((o) => o.productId === p.id && o.type === "PRODUCT_KNOWLEDGE");
    if (pk.completeness < COMPLETENESS_TARGET && !hasKnowledgeOpp)
      findings.push(
        ruleFinding("content_knowledge", `knowledge:completeness:${p.id}`, {
          title: "Complete the knowledge graph of {product}",
          summary: "Missing facts limit what Beacon can generate for {product} and what answer engines can cite.",
          vars: { product: p.name },
          severity: pk.completeness < 0.5 ? "HIGH" : "MEDIUM",
          effort: 2,
          evidence: [{ label: "Knowledge completeness", value: pct(pk.completeness), href: knowledge }, ...pk.missingItems.map((m) => ({ label: "Missing", value: m }))],
          action: { label: "Open the knowledge graph", href: knowledge, kind: "OPEN" },
          productId: p.id,
        }),
      );
    const unverified = pk.facts - pk.verifiedFacts;
    if (unverified > 0)
      findings.push(
        ruleFinding("content_knowledge", `knowledge:unverified:${p.id}`, {
          title: "Review the {n} unverified facts of {product}",
          summary: "Only verified facts are published; a person who knows {product} must review the others.",
          vars: { product: p.name, n: unverified },
          severity: pk.verifiedFacts === 0 ? "HIGH" : "MEDIUM",
          effort: 2,
          evidence: [
            { label: "Unverified facts", value: String(unverified), href: knowledge },
            { label: "Verified facts", value: String(pk.verifiedFacts) },
          ],
          action: { label: "Open the knowledge graph", href: knowledge, kind: "OPEN" },
          productId: p.id,
        }),
      );
  }
  if (s.content.awaitingApproval > 0)
    findings.push(
      ruleFinding("content_knowledge", "content:awaiting_approval", {
        title: "Review the {n} drafts awaiting approval",
        summary: "Drafts only reach your sites after a human approves them.",
        vars: { n: s.content.awaitingApproval },
        severity: "MEDIUM",
        effort: 2,
        evidence: [{ label: "Drafts awaiting approval", value: String(s.content.awaitingApproval), href: "/content?status=HUMAN_APPROVAL" }],
        action: { label: "Open content", href: "/content?status=HUMAN_APPROVAL", kind: "OPEN" },
      }),
    );
  if (s.content.inChecks > 0)
    findings.push(
      ruleFinding("content_knowledge", "content:in_checks", {
        title: "Resolve the {n} drafts held in fact or SEO checks",
        summary: "These drafts did not pass the quality gate yet and cannot be approved.",
        vars: { n: s.content.inChecks },
        severity: "LOW",
        effort: 2,
        evidence: [{ label: "Drafts in checks", value: String(s.content.inChecks), href: "/content" }],
        action: { label: "Open content", href: "/content", kind: "OPEN" },
      }),
    );
  for (const o of s.opportunities) findings.push(opportunityFinding("content_knowledge", o));

  let coverage: Coverage;
  if (!s.products.length) {
    coverage = "NOT_CONNECTED";
    missing.push("A product");
  } else if (s.searchData) coverage = "MEASURED";
  else {
    coverage = "PARTIAL";
    missing.push(s.searchConnected ? "A first search data sync" : "Search Console or Bing Webmaster");
  }
  return { specialist: "content_knowledge", coverage, missing, findings };
}
