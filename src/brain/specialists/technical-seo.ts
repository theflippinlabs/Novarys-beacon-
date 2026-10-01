import { sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { daysBetween, isoDate, loadAvailability, loadOpenOpportunities, loadProducts, opportunityFinding, pct, ruleFinding, type OppRow, type ProductRow } from "../common";
import type { Coverage, Finding, SpecialistReport } from "../types";

/**
 * Technical SEO specialist: crawl coverage and freshness, open audit issues,
 * indexability, sitemaps, and the search-performance opportunities (striking
 * distance, low CTR, visibility drops, internal linking, technical rules).
 */
export const TECHNICAL_SEO_TYPES = ["TECHNICAL", "INTERNAL_LINKING", "STRIKING_DISTANCE", "LOW_CTR", "VISIBILITY_DROP"];
/** An audit older than this is stale. */
export const AUDIT_STALE_DAYS = 30;

export type ProductAudit = {
  product: ProductRow;
  /** Latest successful audit, if any. */
  audit: { id: string; finishedAt: string | null; pagesCrawled: number } | null;
  /** Status of the latest audit of any status (e.g. FAILED, RUNNING), if any. */
  latestStatus: string | null;
  openBySeverity: Record<string, number>;
  nonIndexable: number;
  crawled: number;
  sitemaps: number;
  sitemapErrors: number;
};

export type TechnicalSeoSignals = {
  now: string;
  products: ProductAudit[];
  searchConnected: boolean;
  searchData: boolean;
  opportunities: OppRow[];
};

export async function collectTechnicalSeo(tx: Tx, organizationId: string, now: Date): Promise<TechnicalSeoSignals> {
  const prods = await loadProducts(tx, organizationId);
  const avail = await loadAvailability(tx, organizationId);
  const latest = await tx.execute<{ product_id: string; status: string }>(sql`
    select distinct on (product_id) product_id, status::text as status from seo_audits
    where organization_id = ${organizationId} order by product_id, created_at desc`);
  const ok = await tx.execute<{ product_id: string; id: string; finished_at: string | null; pages_crawled: number }>(sql`
    select distinct on (product_id) product_id, id, finished_at, pages_crawled from seo_audits
    where organization_id = ${organizationId} and status = 'SUCCEEDED' order by product_id, created_at desc`);
  const auditIds = ok.rows.map((r) => r.id);
  const issues = auditIds.length
    ? await tx.execute<{ audit_id: string; severity: string; n: number }>(sql`
        select audit_id, severity::text as severity, count(*)::int as n from seo_issues
        where organization_id = ${organizationId} and status = 'OPEN' and audit_id in (${sql.join(auditIds.map((id) => sql`${id}`), sql`, `)})
        group by audit_id, severity`)
    : { rows: [] };
  const pages = auditIds.length
    ? await tx.execute<{ audit_id: string; crawled: number; non_indexable: number }>(sql`
        select audit_id, count(*)::int as crawled, (count(*) filter (where indexable = false))::int as non_indexable from crawled_pages
        where organization_id = ${organizationId} and audit_id in (${sql.join(auditIds.map((id) => sql`${id}`), sql`, `)})
        group by audit_id`)
    : { rows: [] };
  const maps = auditIds.length
    ? await tx.execute<{ audit_id: string; total: number; errors: number }>(sql`
        select audit_id, count(*)::int as total, (count(*) filter (where kind in ('invalid', 'error')))::int as errors from sitemap_snapshots
        where organization_id = ${organizationId} and audit_id in (${sql.join(auditIds.map((id) => sql`${id}`), sql`, `)})
        group by audit_id`)
    : { rows: [] };
  const opps = await loadOpenOpportunities(tx, organizationId, TECHNICAL_SEO_TYPES);
  return {
    now: now.toISOString(),
    searchConnected: avail.searchConnected,
    searchData: avail.searchData,
    opportunities: opps,
    products: prods.map((p) => {
      const a = ok.rows.find((r) => r.product_id === p.id);
      const openBySeverity: Record<string, number> = {};
      for (const r of issues.rows) if (a && r.audit_id === a.id) openBySeverity[r.severity] = Number(r.n);
      const pg = a ? pages.rows.find((r) => r.audit_id === a.id) : undefined;
      const sm = a ? maps.rows.find((r) => r.audit_id === a.id) : undefined;
      return {
        product: p,
        audit: a ? { id: a.id, finishedAt: a.finished_at ? new Date(a.finished_at).toISOString() : null, pagesCrawled: Number(a.pages_crawled) } : null,
        latestStatus: latest.rows.find((r) => r.product_id === p.id)?.status ?? null,
        openBySeverity,
        nonIndexable: Number(pg?.non_indexable ?? 0),
        crawled: Number(pg?.crawled ?? 0),
        sitemaps: Number(sm?.total ?? 0),
        sitemapErrors: Number(sm?.errors ?? 0),
      };
    }),
  };
}

export function analyzeTechnicalSeo(s: TechnicalSeoSignals): SpecialistReport {
  const now = new Date(s.now);
  const findings: Finding[] = [];
  const missing: string[] = [];
  if (!s.searchConnected) missing.push("Search Console or Bing Webmaster");
  else if (!s.searchData) missing.push("A first search data sync");

  for (const pa of s.products) {
    const p = pa.product;
    const vars = { product: p.name };
    const discovery = `/discovery?product=${encodeURIComponent(p.slug)}`;
    if (!pa.audit) {
      missing.push(`A completed site audit of ${p.name}`);
      if (!p.domain)
        findings.push(
          ruleFinding("technical_seo", `seo:no_domain:${p.id}`, {
            title: "Add the website domain of {product}",
            summary: "Without a domain Beacon cannot crawl the site of {product}, so its technical health is unknown.",
            vars,
            severity: "MEDIUM",
            effort: 1,
            evidence: [{ label: "Domain", value: "None" }],
            action: { label: "Open the product", href: `/products/${p.slug}`, kind: "OPEN" },
            productId: p.id,
          }),
        );
      else
        findings.push(
          ruleFinding("technical_seo", `seo:no_audit:${p.id}`, {
            title: "Run a first site audit of {product}",
            summary: "No completed technical audit exists for {product}: crawl, indexability and sitemap issues are unknown.",
            vars,
            severity: "HIGH",
            effort: 1,
            evidence: [
              { label: "Domain", value: p.domain },
              { label: "Latest audit", value: pa.latestStatus ?? "None" },
            ],
            action: { label: "Open discovery", href: discovery, kind: "OPEN" },
            productId: p.id,
          }),
        );
      continue;
    }
    const auditHref = `/discovery/audits/${pa.audit.id}`;
    const finished = pa.audit.finishedAt ? new Date(pa.audit.finishedAt) : null;
    const age = finished ? daysBetween(finished, now) : null;
    if (age !== null && age > AUDIT_STALE_DAYS)
      findings.push(
        ruleFinding("technical_seo", `seo:stale_audit:${p.id}`, {
          title: "Re-run the site audit of {product}",
          summary: "The latest completed audit of {product} is {days} days old; issues fixed or introduced since are not reflected.",
          vars: { ...vars, days: age },
          severity: "MEDIUM",
          effort: 1,
          evidence: [
            { label: "Latest completed audit", value: isoDate(finished)!, href: auditHref },
            { label: "Days since", value: String(age) },
          ],
          action: { label: "Open discovery", href: discovery, kind: "OPEN" },
          productId: p.id,
        }),
      );
    const critical = pa.openBySeverity.CRITICAL ?? 0;
    const high = pa.openBySeverity.HIGH ?? 0;
    // Each open critical or high rule is normally an opportunity; this roll-up only covers products whose opportunities were not generated yet.
    const hasTechOpp = s.opportunities.some((o) => o.productId === p.id && o.type === "TECHNICAL");
    if ((critical || high) && !hasTechOpp)
      findings.push(
        ruleFinding("technical_seo", `seo:open_issues:${p.id}`, {
          title: critical ? "Fix {n} critical technical issues on {product}" : "Fix {n} high-severity technical issues on {product}",
          summary: "The latest audit of {product} found open issues that can block crawling, indexing or rendering.",
          vars: { ...vars, n: critical || high },
          severity: critical ? "CRITICAL" : "HIGH",
          effort: 2,
          evidence: [
            { label: "Open critical issues", value: String(critical), href: auditHref },
            { label: "Open high-severity issues", value: String(high), href: auditHref },
            { label: "Pages crawled", value: String(pa.audit.pagesCrawled) },
          ],
          action: { label: "Open the audit", href: auditHref, kind: "PROPOSE_RECOMMENDATION" },
          productId: p.id,
          target: { productId: p.id, opportunityType: "TECHNICAL" },
        }),
      );
    if (pa.nonIndexable > 0 && pa.crawled > 0) {
      const ratio = pa.nonIndexable / pa.crawled;
      findings.push(
        ruleFinding("technical_seo", `seo:non_indexable:${p.id}`, {
          title: "Check the {n} non-indexable pages of {product}",
          summary: "Pages that cannot be indexed never appear in search results; confirm each one is excluded on purpose.",
          vars: { ...vars, n: pa.nonIndexable },
          severity: ratio >= 0.2 ? "MEDIUM" : "LOW",
          effort: 2,
          evidence: [
            { label: "Non-indexable pages", value: String(pa.nonIndexable), href: auditHref },
            { label: "Pages crawled", value: String(pa.crawled) },
            { label: "Share of crawled pages", value: pct(ratio) },
          ],
          action: { label: "Open the audit", href: auditHref, kind: "OPEN" },
          productId: p.id,
          target: { productId: p.id, opportunityType: "TECHNICAL" },
        }),
      );
    }
    if (pa.sitemapErrors > 0)
      findings.push(
        ruleFinding("technical_seo", `seo:sitemap_errors:${p.id}`, {
          title: "Fix the sitemap errors of {product}",
          summary: "Some sitemaps read during the latest audit of {product} were invalid or could not be fetched.",
          vars,
          severity: "MEDIUM",
          effort: 2,
          evidence: [
            { label: "Sitemaps with errors", value: String(pa.sitemapErrors), href: auditHref },
            { label: "Sitemaps read", value: String(pa.sitemaps) },
          ],
          action: { label: "Open the audit", href: auditHref, kind: "OPEN" },
          productId: p.id,
        }),
      );
    else if (pa.sitemaps === 0)
      findings.push(
        ruleFinding("technical_seo", `seo:no_sitemap:${p.id}`, {
          title: "Publish a sitemap for {product}",
          summary: "No sitemap was read during the latest audit of {product}; search engines discover its pages through links only.",
          vars,
          severity: "LOW",
          effort: 1,
          evidence: [{ label: "Sitemaps read", value: "0", href: auditHref }],
          action: { label: "Open the audit", href: auditHref, kind: "OPEN" },
          productId: p.id,
        }),
      );
  }

  for (const o of s.opportunities) findings.push(opportunityFinding("technical_seo", o));

  const audited = s.products.filter((p) => p.audit);
  const fresh = audited.filter((p) => p.audit?.finishedAt && daysBetween(new Date(p.audit.finishedAt), now) <= AUDIT_STALE_DAYS);
  let coverage: Coverage;
  if (!s.products.length) {
    coverage = "NOT_CONNECTED";
    missing.unshift("A product");
  } else if (!audited.length && !s.searchConnected) coverage = "NOT_CONNECTED";
  else if (fresh.length === s.products.length && s.searchData) coverage = "MEASURED";
  else coverage = "PARTIAL";
  return { specialist: "technical_seo", coverage, missing, findings };
}
