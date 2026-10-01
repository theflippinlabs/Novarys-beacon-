import { and, desc, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { crawledPages, products, seoAudits, seoIssues } from "@/db/schema";
import { crawlSite, type Fetcher } from "@/core/seo/crawl";
import { assertSafeUrl } from "@/lib/security/ssrf";
import { audit, type Actor } from "@/lib/audit";
import { enqueue } from "@/jobs/queue";

export async function createAudit(tx: Tx, organizationId: string, productId: string, opts: { startUrl?: string; maxPages?: number } = {}) {
  const product = await tx.query.products.findFirst({ where: and(eq(products.id, productId), eq(products.organizationId, organizationId)) });
  if (!product) throw new Error("Product not found");
  const startUrl = opts.startUrl || (product.domain ? `https://${product.domain.replace(/^https?:\/\//, "")}` : null);
  if (!startUrl) throw new Error("Set the product domain (or a start URL) before running an audit");
  assertSafeUrl(startUrl);
  const [a] = await tx.insert(seoAudits).values({ organizationId, productId, startUrl, maxPages: Math.min(500, opts.maxPages ?? 50) }).returning();
  return a;
}

/** Executes a queued audit (called by the job worker). Network I/O happens outside long DB transactions. */
export async function executeAudit(
  run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>,
  auditId: string,
  fetcher?: Fetcher,
) {
  const audit = await run((tx) => tx.query.seoAudits.findFirst({ where: eq(seoAudits.id, auditId) }));
  if (!audit) throw new Error("Audit not found");
  await run((tx) => tx.update(seoAudits).set({ status: "RUNNING", startedAt: new Date(), error: null }).where(eq(seoAudits.id, auditId)));
  try {
    const result = await crawlSite(audit.startUrl, { maxPages: audit.maxPages, fetcher, delayMs: fetcher ? 0 : 200 });
    await run(async (tx) => {
      await tx.delete(seoIssues).where(eq(seoIssues.auditId, auditId));
      await tx.delete(crawledPages).where(eq(crawledPages.auditId, auditId));
      const inlinks = new Map<string, number>();
      for (const p of result.pages) for (const l of p.internalLinks) if (l !== p.url) inlinks.set(l, (inlinks.get(l) ?? 0) + 1);
      for (let i = 0; i < result.pages.length; i += 200) {
        const chunk = result.pages.slice(i, i + 200);
        await tx
          .insert(crawledPages)
          .values(
            chunk.map((p) => ({
              organizationId: audit.organizationId,
              auditId,
              url: p.url,
              status: p.status,
              title: p.title,
              metaDescription: p.metaDescription,
              canonical: p.canonical,
              indexable: p.indexable,
              wordCount: p.wordCount,
              loadMs: p.loadMs,
              bytes: p.bytes,
              inlinks: inlinks.get(p.url) ?? 0,
              outlinks: p.internalLinks.slice(0, 200),
              structuredDataTypes: p.structuredDataTypes,
            })),
          )
          .onConflictDoNothing();
      }
      for (let i = 0; i < result.issues.length; i += 500) {
        const chunk = result.issues.slice(i, i + 500);
        await tx.insert(seoIssues).values(chunk.map((x) => ({ organizationId: audit.organizationId, auditId, productId: audit.productId, url: x.url, rule: x.rule, severity: x.severity, message: x.message, details: x.details ?? {} })));
      }
      const summary: Record<string, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0, sitemapUrls: result.sitemapUrls.length, indexable: result.pages.filter((p) => p.indexable).length };
      for (const x of result.issues) summary[x.severity]++;
      await tx.update(seoAudits).set({ status: "SUCCEEDED", finishedAt: new Date(), pagesCrawled: result.pages.length, summary }).where(eq(seoAudits.id, auditId));
    });
    return { pages: result.pages.length, issues: result.issues.length };
  } catch (e) {
    await run((tx) => tx.update(seoAudits).set({ status: "FAILED", finishedAt: new Date(), error: (e as Error).message.slice(0, 1000) }).where(eq(seoAudits.id, auditId)));
    throw e;
  }
}

export async function latestAudit(tx: Tx, organizationId: string, productId: string) {
  return tx.query.seoAudits.findFirst({
    where: and(eq(seoAudits.organizationId, organizationId), eq(seoAudits.productId, productId), eq(seoAudits.status, "SUCCEEDED")),
    orderBy: desc(seoAudits.createdAt),
  });
}

export async function openIssueCounts(tx: Tx, auditId: string) {
  const r = await tx.execute<{ severity: string; n: number }>(sql`select severity, count(*)::int as n from seo_issues where audit_id = ${auditId} and status = 'OPEN' group by severity`);
  const out = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const row of r.rows) out[row.severity as keyof typeof out] = Number(row.n);
  return out;
}

/** Create a technical audit for a product and queue it for the worker (the crawl itself runs in the background). */
export async function queueAudit(tx: Tx, actor: Actor, productId: string, opts: { startUrl?: string; maxPages?: number } = {}) {
  const a = await createAudit(tx, actor.organizationId, productId, opts);
  await enqueue("seo.audit", { auditId: a.id, productId }, { organizationId: actor.organizationId, idempotencyKey: `audit:${a.id}` });
  await audit(tx, actor, "seo.audit.queue", "seo_audit", a.id, { startUrl: a.startUrl });
  return a;
}
