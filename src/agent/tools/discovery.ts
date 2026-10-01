import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import { z } from "zod";
import { pages, products, queries, queryClusters, seoAudits, seoIssues } from "@/db/schema";
import { syncPagePlan } from "@/services/discovery";
import { addCuratedQuery, generateQueryUniverse } from "@/services/queries";
import { openIssueCounts, queueAudit } from "@/services/seo";
import { audit } from "@/lib/audit";
import { defineTool } from "../types";
import { agentActor, capped, iso, limitInput, LIST_CAP, optionalProductRef, productRef, requirePermission, resolveOptionalProduct, resolveProduct, trim } from "./util";

const INTENT = z.enum(["INFORMATIONAL", "COMMERCIAL", "TRANSACTIONAL", "NAVIGATIONAL", "COMPARISON", "PROBLEM", "ALTERNATIVE"]);

export const listQueries = defineTool({
  name: "list_queries",
  label: "Reading queries",
  description:
    "List tracked search queries (with intent, funnel stage, importance 1 to 5, coverage NONE/PARTIAL/COVERED, status, cluster), plus status counts and the top clusters with their coverage. Filter by product, status, intent, coverage or a text search. CANDIDATE queries are suggestions awaiting human curation.",
  permission: "read",
  kind: "read",
  input: z.object({
    product: optionalProductRef(),
    status: z.enum(["CANDIDATE", "ACTIVE", "ARCHIVED", "ALL"]).optional().describe("Query status filter (default ACTIVE)."),
    intent: INTENT.optional().describe("Only this intent."),
    coverage: z.enum(["NONE", "PARTIAL", "COVERED"]).optional().describe("Only this coverage level."),
    search: z.string().trim().max(100).optional().describe("Text the query must contain."),
    limit: limitInput,
  }),
  run: async ({ tx, ctx }, i) => {
    const org = ctx.org.id;
    const product = await resolveOptionalProduct(tx, org, i.product);
    const status = i.status ?? "ACTIVE";
    const limit = i.limit ?? LIST_CAP;
    const rows = await tx
      .select({ q: queries, cluster: queryClusters.name, productSlug: products.slug })
      .from(queries)
      .leftJoin(queryClusters, eq(queryClusters.id, queries.clusterId))
      .leftJoin(products, eq(products.id, queries.productId))
      .where(
        and(
          eq(queries.organizationId, org),
          product ? eq(queries.productId, product.id) : undefined,
          status !== "ALL" ? eq(queries.status, status) : undefined,
          i.intent ? eq(queries.intent, i.intent) : undefined,
          i.coverage ? eq(queries.coverage, i.coverage) : undefined,
          i.search ? ilike(queries.normalized, `%${i.search.toLowerCase().replace(/[%_]/g, "")}%`) : undefined,
        ),
      )
      .orderBy(desc(queries.importance), asc(queries.normalized))
      .limit(limit + 1);
    const stats = await tx.execute<{ status: string; n: number }>(sql`select status, count(*)::int as n from queries where organization_id = ${org} ${product ? sql`and product_id = ${product.id}` : sql``} group by status`);
    const clusters = await tx.execute<{ name: string; n: number; covered: number }>(sql`
      select c.name, count(q.id)::int as n, count(q.id) filter (where q.coverage = 'COVERED')::int as covered
      from query_clusters c join queries q on q.cluster_id = c.id
      where c.organization_id = ${org} and q.status = 'ACTIVE' ${product ? sql`and c.product_id = ${product.id}` : sql``}
      group by c.name order by n desc limit 10`);
    return {
      ...capped(
        rows.map((r) => ({ id: r.q.id, query: r.q.query, product: r.productSlug, intent: r.q.intent, funnelStage: r.q.funnelStage, importance: r.q.importance, coverage: r.q.coverage, status: r.q.status, source: r.q.source, cluster: r.cluster, market: r.q.market, language: r.q.language })),
        limit,
      ),
      countsByStatus: Object.fromEntries(stats.rows.map((r) => [r.status, Number(r.n)])),
      topClusters: clusters.rows.map((c) => ({ name: c.name, activeQueries: Number(c.n), covered: Number(c.covered) })),
      link: product ? `/queries?product=${product.slug}` : "/queries",
    };
  },
});

export const addQueryTool = defineTool({
  name: "add_query",
  label: "Adding a query",
  description: "Add a search query to track (active immediately). Intent is classified automatically unless given. Fails if the same query already exists for the market and language.",
  permission: "query:write",
  kind: "write",
  input: z.object({
    query: z.string().trim().min(2).max(200).describe("The search query as people type it."),
    product: optionalProductRef("The product it relates to"),
    intent: INTENT.optional().describe("Override the automatic intent classification."),
    importance: z.number().int().min(1).max(5).optional().describe("Importance 1 (low) … 5 (critical); default 3."),
    market: z.string().trim().max(40).optional().describe("Market, default \"global\"."),
    language: z.string().trim().max(10).optional().describe("Language code, default \"en\"."),
    cluster: z.string().trim().max(80).optional().describe("Cluster (topic group) name."),
    notes: z.string().trim().max(500).optional().describe("Why this query matters."),
  }),
  run: async (c, i) => {
    requirePermission(c, "query:write");
    const product = await resolveOptionalProduct(c.tx, c.ctx.org.id, i.product);
    const row = await addCuratedQuery(c.tx, agentActor(c), {
      query: i.query,
      productId: product?.id ?? null,
      intent: i.intent,
      importance: i.importance ?? 3,
      market: i.market ?? "global",
      language: i.language ?? "en",
      clusterName: i.cluster,
      notes: i.notes,
    });
    return { added: { id: row.id, query: row.query, intent: row.intent, funnelStage: row.funnelStage, importance: row.importance, status: row.status }, link: product ? `/queries?product=${product.slug}` : "/queries" };
  },
});

export const generateQuerySuggestions = defineTool({
  name: "generate_query_suggestions",
  label: "Generating query suggestions",
  description:
    "Expand a product's query universe from its knowledge graph (category, audiences, problems, features, integrations, competitors). New queries are added as CANDIDATE for the user to curate on the Queries page; they are not tracked until a human activates them. Returns how many were generated and inserted.",
  permission: "query:write",
  kind: "write",
  input: z.object({ product: productRef(), max: z.number().int().min(10).max(150).optional().describe("Maximum candidates to generate (default 150).") }),
  run: async (c, i) => {
    requirePermission(c, "query:write");
    const p = await resolveProduct(c.tx, c.ctx.org.id, i.product);
    const r = await generateQueryUniverse(c.tx, c.ctx.org.id, p.id, { max: i.max });
    await audit(c.tx, agentActor(c), "queries.generate", "product", p.id, { candidates: r.candidates, inserted: r.inserted });
    return { candidatesGenerated: r.candidates, newCandidatesInserted: r.inserted, status: "CANDIDATE (awaiting human curation)", link: `/queries?product=${p.slug}` };
  },
});

export const listPlannedPages = defineTool({
  name: "list_planned_pages",
  label: "Reading the page plan",
  description:
    "List a product's discovery pages (planned and existing): type, path, title, status, whether it passes the publication quality gate (and the blockers), and the linked content asset. Use a page id with create_content_draft to draft content for that page.",
  permission: "read",
  kind: "read",
  input: z.object({
    product: productRef(),
    status: z.enum(["PLANNED", "DRAFT", "IN_REVIEW", "APPROVED", "PUBLISHED", "ARCHIVED"]).optional().describe("Only pages in this status."),
    limit: limitInput,
  }),
  run: async ({ tx, ctx }, i) => {
    const p = await resolveProduct(tx, ctx.org.id, i.product);
    const limit = i.limit ?? LIST_CAP;
    const rows = await tx
      .select()
      .from(pages)
      .where(and(eq(pages.organizationId, ctx.org.id), eq(pages.productId, p.id), i.status ? eq(pages.status, i.status) : undefined))
      .orderBy(pages.type, pages.path)
      .limit(limit + 1);
    return {
      ...capped(
        rows.map((r) => ({ id: r.id, type: r.type, path: r.path, title: r.title, status: r.status, publishable: r.quality.publishable ?? null, blockers: trim(String(r.quality.blockers ?? ""), 300) || null, contentAssetId: r.contentAssetId, contentLink: r.contentAssetId ? `/content/${r.contentAssetId}` : null })),
        limit,
      ),
      link: `/discovery?product=${p.slug}`,
    };
  },
});

export const syncPagePlanTool = defineTool({
  name: "sync_page_plan",
  label: "Syncing the page plan",
  description:
    "Recompute a product's discovery page plan from its knowledge graph (product, features, use cases, integrations, comparisons, answers…) and re-score every page against the publication gate. Existing page statuses are preserved. Returns planned/new counts and pages skipped for insufficient facts (with the reason).",
  permission: "query:write",
  kind: "write",
  input: z.object({ product: productRef() }),
  run: async (c, i) => {
    requirePermission(c, "query:write");
    const p = await resolveProduct(c.tx, c.ctx.org.id, i.product);
    const r = await syncPagePlan(c.tx, c.ctx.org.id, p.id);
    await audit(c.tx, agentActor(c), "discovery.plan.sync", "product", p.id, { planned: r.planned, created: r.created });
    return { planned: r.planned, created: r.created, skipped: capped(r.skipped.map((s) => ({ ...s }))), link: `/discovery?product=${p.slug}` };
  },
});

export const getSeoAudits = defineTool({
  name: "get_seo_audits",
  label: "Reading technical audits",
  description:
    "Read a product's recent technical SEO audits (status, pages crawled, issue counts by severity) and the open issues of the latest successful audit, most severe first. Findings are server-side signals from Beacon's own crawler (not Core Web Vitals).",
  permission: "read",
  kind: "read",
  input: z.object({
    product: productRef(),
    severity: z.enum(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]).optional().describe("Only open issues of this severity."),
    limit: limitInput,
  }),
  run: async ({ tx, ctx }, i) => {
    const p = await resolveProduct(tx, ctx.org.id, i.product);
    const limit = i.limit ?? LIST_CAP;
    const audits = await tx.select().from(seoAudits).where(and(eq(seoAudits.organizationId, ctx.org.id), eq(seoAudits.productId, p.id))).orderBy(desc(seoAudits.createdAt)).limit(5);
    const latest = audits.find((a) => a.status === "SUCCEEDED") ?? null;
    let issues: { id: string; severity: string; rule: string; url: string; message: string | null }[] = [];
    let openBySeverity: Record<string, number> | null = null;
    if (latest) {
      openBySeverity = await openIssueCounts(tx, latest.id);
      const rows = await tx
        .select()
        .from(seoIssues)
        .where(and(eq(seoIssues.auditId, latest.id), eq(seoIssues.status, "OPEN"), i.severity ? eq(seoIssues.severity, i.severity) : undefined))
        .orderBy(sql`case ${seoIssues.severity} when 'CRITICAL' then 0 when 'HIGH' then 1 when 'MEDIUM' then 2 when 'LOW' then 3 else 4 end`, asc(seoIssues.rule))
        .limit(limit + 1);
      issues = rows.map((r) => ({ id: r.id, severity: r.severity, rule: r.rule, url: r.url, message: trim(r.message, 200) }));
    }
    return {
      audits: audits.map((a) => ({ id: a.id, status: a.status, startUrl: a.startUrl, pagesCrawled: a.pagesCrawled, summary: a.summary, error: trim(a.error, 200), createdAt: iso(a.createdAt), finishedAt: iso(a.finishedAt), link: `/discovery/audits/${a.id}` })),
      latestSucceededAuditId: latest?.id ?? null,
      openIssuesBySeverity: openBySeverity ?? "no successful audit yet",
      openIssues: capped(issues, limit),
      link: latest ? `/discovery/audits/${latest.id}` : `/discovery?product=${p.slug}`,
    };
  },
});

export const queueSeoAudit = defineTool({
  name: "queue_seo_audit",
  label: "Queuing a technical audit",
  description: "Queue a technical SEO crawl of a product's site (its domain, or a given https start URL). The crawl runs in the background; check results later with get_seo_audits.",
  permission: "job:run",
  kind: "write",
  input: z.object({
    product: productRef(),
    startUrl: z.string().trim().max(500).regex(/^https?:\/\/\S+$/i, "must be an http(s) URL").optional().describe("Start URL; defaults to https://<product domain>."),
    maxPages: z.number().int().min(1).max(500).optional().describe("Crawl budget in pages (default 50)."),
  }),
  run: async (c, i) => {
    requirePermission(c, "job:run");
    const p = await resolveProduct(c.tx, c.ctx.org.id, i.product);
    const a = await queueAudit(c.tx, agentActor(c), p.id, { startUrl: i.startUrl, maxPages: i.maxPages ?? 50 });
    return { queued: { auditId: a.id, startUrl: a.startUrl, maxPages: a.maxPages, status: a.status }, link: `/discovery/audits/${a.id}` };
  },
});
