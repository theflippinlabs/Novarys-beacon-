import { and, desc, eq, gte, inArray, isNotNull, lte, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { crawledPages, crawlLinks, products, seoAudits, seoIssues, sitemapSnapshots, verifiedDomains } from "@/db/schema";
import { crawlSite, type CrawlOptions, type Fetcher } from "@/core/seo/crawl";
import { normalizeUrl, type PageFacts } from "@/core/seo/analyze";
import { diffAudits, type IssueSnapshot, type PageSnapshot } from "@/core/seo/diff";
import { hostCoveredBy, isLocalDevHost } from "@/core/seo/domains";
import { issueFingerprint } from "@/core/seo/rules";
import { assertSafeUrl } from "@/lib/security/ssrf";
import { audit, type Actor } from "@/lib/audit";
import { enqueue } from "@/jobs/queue";

/** A refused audit request (domain not verified, rate limit, audit already running). The message is shown to the user. */
export class AuditRefusedError extends Error {
  constructor(
    message: string,
    public code: "DOMAIN_NOT_VERIFIED" | "RATE_LIMITED" | "ALREADY_RUNNING",
  ) {
    super(message);
    this.name = "AuditRefusedError";
  }
}

export const AUDIT_RATE_LIMIT_PER_HOUR = 10;
/** A QUEUED / RUNNING audit older than this is considered abandoned and no longer blocks a new one. */
const ACTIVE_AUDIT_WINDOW_HOURS = 6;
export const VERIFY_DOMAINS_PATH = "/discovery/domains";

/**
 * Development-only bypass of domain verification: only for local fixture
 * hosts (localhost, loopback and private IPs), only when
 * BEACON_SSRF_ALLOW_PRIVATE=true and NODE_ENV is not production (the E2E
 * suite audits a fixture at 127.0.0.1). Public hosts always need verification.
 */
export function domainVerificationBypassed(host: string): boolean {
  return process.env.BEACON_SSRF_ALLOW_PRIVATE === "true" && process.env.NODE_ENV !== "production" && isLocalDevHost(host);
}

export async function verifiedDomainNames(tx: Tx, organizationId: string): Promise<string[]> {
  const rows = await tx.select({ domain: verifiedDomains.domain }).from(verifiedDomains).where(and(eq(verifiedDomains.organizationId, organizationId), isNotNull(verifiedDomains.verifiedAt)));
  return rows.map((r) => r.domain);
}

/** Refuse unverified hosts, more than 10 audits per hour per organisation, and a second active audit for the product. */
export async function assertAuditAllowed(tx: Tx, organizationId: string, productId: string, startUrl: string) {
  const host = new URL(startUrl).hostname.toLowerCase();
  if (!domainVerificationBypassed(host) && !hostCoveredBy(host, await verifiedDomainNames(tx, organizationId)))
    throw new AuditRefusedError(`${host} is not a verified domain for this workspace. Verify it (or a parent domain) under Discovery, Domains (${VERIFY_DOMAINS_PATH}) before running an audit.`, "DOMAIN_NOT_VERIFIED");
  // Serialise concurrent requests for the same product.
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`beacon-audit:${productId}`}))`);
  const recent = await tx.execute<{ n: number }>(sql`select count(*)::int as n from seo_audits where organization_id = ${organizationId} and created_at > now() - interval '1 hour'`);
  if (Number(recent.rows[0]?.n ?? 0) >= AUDIT_RATE_LIMIT_PER_HOUR) throw new AuditRefusedError(`Audit limit reached: at most ${AUDIT_RATE_LIMIT_PER_HOUR} audits per hour per workspace. Try again later.`, "RATE_LIMITED");
  const active = await tx.execute<{ id: string }>(
    sql`select id from seo_audits where organization_id = ${organizationId} and product_id = ${productId} and status in ('QUEUED','RUNNING') and created_at > now() - make_interval(hours => ${ACTIVE_AUDIT_WINDOW_HOURS}) limit 1`,
  );
  if (active.rows.length) throw new AuditRefusedError("An audit is already queued or running for this product. Wait for it to finish.", "ALREADY_RUNNING");
}

export async function createAudit(tx: Tx, organizationId: string, productId: string, opts: { startUrl?: string; maxPages?: number } = {}) {
  const product = await tx.query.products.findFirst({ where: and(eq(products.id, productId), eq(products.organizationId, organizationId)) });
  if (!product) throw new Error("Product not found");
  const startUrl = opts.startUrl || (product.domain ? `https://${product.domain.replace(/^https?:\/\//, "")}` : null);
  if (!startUrl) throw new Error("Set the product domain (or a start URL) before running an audit");
  assertSafeUrl(startUrl);
  await assertAuditAllowed(tx, organizationId, productId, startUrl);
  const [a] = await tx.insert(seoAudits).values({ organizationId, productId, startUrl, maxPages: Math.min(500, opts.maxPages ?? 50) }).returning();
  return a;
}

/** Search impressions per URL over 90 days, when Search Console rows exist (else undefined). */
async function loadImpressions(tx: Tx, organizationId: string, productId: string): Promise<Map<string, number> | undefined> {
  const r = await tx.execute<{ page: string; n: number }>(sql`
    select page, sum(impressions)::int as n from search_daily
    where organization_id = ${organizationId} and product_id = ${productId} and page is not null and day >= current_date - 90
    group by page having sum(impressions) > 0 order by n desc limit 5000`);
  if (!r.rows.length) return undefined;
  const m = new Map<string, number>();
  for (const row of r.rows) {
    const u = normalizeUrl(row.page, row.page);
    if (u) m.set(u, (m.get(u) ?? 0) + Number(row.n));
  }
  return m;
}

function pageRow(organizationId: string, auditId: string, p: PageFacts, inlinks: number) {
  return {
    organizationId,
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
    inlinks,
    outlinks: p.internalLinks.slice(0, 200),
    outlinksCount: p.internalLinks.length,
    structuredDataTypes: p.structuredDataTypes,
    finalUrl: p.finalUrl,
    redirectChain: p.redirectChain,
    robotsMeta: p.robotsMeta,
    xRobotsTag: p.xRobotsTag,
    indexability: p.indexability,
    h1: p.h1.slice(0, 20),
    headings: p.headings,
    externalLinks: p.externalLinks.slice(0, 200),
    jsonLd: p.jsonLd,
    hreflang: p.hreflang.slice(0, 100),
    openGraph: p.openGraph,
    twitter: p.twitter,
    images: p.images,
    contentHash: p.contentHash,
    textSample: p.textSample || null,
    depth: p.depth,
    lastModified: p.lastModified,
    fetchedAt: p.fetchedAt ? new Date(p.fetchedAt) : null,
  };
}

const validDate = (s: string | null) => {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d : null;
};

/** Executes a queued audit (called by the job worker). Network I/O happens outside long DB transactions. */
export async function executeAudit(
  run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>,
  auditId: string,
  fetcher?: Fetcher,
  opts: { onProgress?: (done: number) => void | Promise<void>; sleep?: CrawlOptions["sleep"]; delayMs?: number } = {},
) {
  const a = await run((tx) => tx.query.seoAudits.findFirst({ where: eq(seoAudits.id, auditId) }));
  if (!a) throw new Error("Audit not found");
  await run((tx) => tx.update(seoAudits).set({ status: "RUNNING", startedAt: new Date(), error: null, pagesCrawled: 0 }).where(eq(seoAudits.id, auditId)));
  try {
    const impressions = await run((tx) => loadImpressions(tx, a.organizationId, a.productId)).catch(() => undefined);
    let lastReport = 0;
    const result = await crawlSite(a.startUrl, {
      maxPages: a.maxPages,
      fetcher,
      sleep: opts.sleep,
      delayMs: opts.delayMs ?? (fetcher ? 0 : undefined),
      impressions,
      onProgress: async (done) => {
        await opts.onProgress?.(done);
        // Progress for long crawls: visible on the audit page while it runs.
        if (done - lastReport >= 10) {
          lastReport = done;
          await run((tx) => tx.update(seoAudits).set({ pagesCrawled: done }).where(eq(seoAudits.id, auditId)));
        }
      },
    });
    const redirects = result.redirects;
    const resolve = (u: string) => redirects.get(u) ?? u;
    const counts = await run(async (tx) => {
      await tx.delete(seoIssues).where(eq(seoIssues.auditId, auditId));
      await tx.delete(crawledPages).where(eq(crawledPages.auditId, auditId));
      await tx.delete(crawlLinks).where(eq(crawlLinks.auditId, auditId));
      await tx.delete(sitemapSnapshots).where(eq(sitemapSnapshots.auditId, auditId));

      const inlinks = new Map<string, number>();
      for (const p of result.pages) for (const l of new Set(p.internalLinks.map(resolve))) if (l !== p.url && l !== resolve(p.url)) inlinks.set(l, (inlinks.get(l) ?? 0) + 1);
      for (let i = 0; i < result.pages.length; i += 100) {
        const chunk = result.pages.slice(i, i + 100);
        await tx
          .insert(crawledPages)
          .values(chunk.map((p) => pageRow(a.organizationId, auditId, p, inlinks.get(p.url) ?? 0)))
          .onConflictDoNothing();
      }

      const edges = result.pages.flatMap((p) => p.links.map((l) => ({ organizationId: a.organizationId, auditId, fromUrl: p.url, toUrl: l.href, anchor: l.anchor, nofollow: l.nofollow, isInternal: l.internal })));
      for (let i = 0; i < edges.length; i += 1000) await tx.insert(crawlLinks).values(edges.slice(i, i + 1000));

      if (result.sitemaps.length)
        await tx.insert(sitemapSnapshots).values(
          result.sitemaps.slice(0, 200).map((s) => ({
            organizationId: a.organizationId,
            auditId,
            sitemapUrl: s.sitemapUrl,
            parentUrl: s.parentUrl,
            kind: s.kind,
            status: s.status,
            urlCount: s.urlCount,
            compressed: s.compressed,
            lastmodMax: validDate(s.lastmodMax),
            errors: s.errors,
            fetchedAt: new Date(s.fetchedAt),
          })),
        );

      // Issues, one per fingerprint.
      const byFp = new Map<string, (typeof result.issues)[number] & { fingerprint: string }>();
      for (const x of result.issues) {
        const fingerprint = issueFingerprint(a.productId, x.rule, x.url, x.key);
        if (!byFp.has(fingerprint)) byFp.set(fingerprint, { ...x, fingerprint });
      }
      const issues = [...byFp.values()];

      // Change detection against the previous successful audit of the product.
      const prev = await tx.query.seoAudits.findFirst({
        where: and(eq(seoAudits.organizationId, a.organizationId), eq(seoAudits.productId, a.productId), eq(seoAudits.status, "SUCCEEDED"), ne(seoAudits.id, auditId), lte(seoAudits.createdAt, a.createdAt)),
        orderBy: desc(seoAudits.createdAt),
      });
      let previous: { auditId: string; pages: PageSnapshot[]; issues: IssueSnapshot[] } | null = null;
      if (prev) {
        const pp = await tx.select({ url: crawledPages.url, status: crawledPages.status, title: crawledPages.title, canonical: crawledPages.canonical, indexable: crawledPages.indexable, contentHash: crawledPages.contentHash }).from(crawledPages).where(eq(crawledPages.auditId, prev.id));
        const pi = await tx.select({ fingerprint: seoIssues.fingerprint, rule: seoIssues.rule, url: seoIssues.url, status: seoIssues.status }).from(seoIssues).where(eq(seoIssues.auditId, prev.id));
        previous = { auditId: prev.id, pages: pp, issues: pi.map((i) => ({ ...i, fingerprint: i.fingerprint ?? issueFingerprint(a.productId, i.rule, i.url) })) };
      }
      const { diff, carried } = diffAudits(previous, {
        pages: result.pages.map((p) => ({ url: p.url, status: p.status, title: p.title, canonical: p.canonical, indexable: p.indexable, contentHash: p.contentHash })),
        issues,
      });

      for (let i = 0; i < issues.length; i += 500) {
        const chunk = issues.slice(i, i + 500);
        await tx.insert(seoIssues).values(
          chunk.map((x) => ({
            organizationId: a.organizationId,
            auditId,
            productId: a.productId,
            url: x.url,
            rule: x.rule,
            severity: x.severity,
            message: x.message,
            params: x.params ?? {},
            details: x.details ?? {},
            fingerprint: x.fingerprint,
            status: carried.get(x.fingerprint) ?? ("OPEN" as const),
          })),
        );
      }
      const summary: Record<string, number> = {
        CRITICAL: 0,
        HIGH: 0,
        MEDIUM: 0,
        LOW: 0,
        INFO: 0,
        sitemapUrls: result.sitemapUrls.length,
        sitemaps: result.sitemaps.length,
        indexable: result.pages.filter((p) => p.indexable).length,
        robotsBlocked: result.robotsBlocked.length,
        redirects: redirects.size,
        links: edges.length,
        crawlDelayMs: result.crawlDelayMs,
      };
      for (const x of issues) summary[x.severity]++;
      await tx.update(seoAudits).set({ status: "SUCCEEDED", finishedAt: new Date(), pagesCrawled: result.pages.length, summary, diff }).where(eq(seoAudits.id, auditId));
      return { issues: issues.length };
    });
    return { pages: result.pages.length, issues: counts.issues };
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

/**
 * Weekly recurring audit (scheduled by the worker): creates the audit row for
 * the product's own domain, or returns a reason when it must be skipped
 * (domain no longer verified, an audit already running, rate limit).
 */
export async function createScheduledAudit(tx: Tx, organizationId: string, productId: string): Promise<{ auditId: string } | { skipped: string }> {
  try {
    const a = await createAudit(tx, organizationId, productId, {});
    await audit(tx, { organizationId, actorType: "SYSTEM" }, "seo.audit.schedule", "seo_audit", a.id, { startUrl: a.startUrl });
    return { auditId: a.id };
  } catch (e) {
    if (e instanceof AuditRefusedError) return { skipped: e.code };
    throw e;
  }
}

/** Products whose own domain is covered by a verified domain of the organisation (eligible for recurring audits). */
export async function productsWithVerifiedDomain(tx: Tx, organizationId: string): Promise<string[]> {
  const verified = await verifiedDomainNames(tx, organizationId);
  if (!verified.length) return [];
  const prods = await tx.select({ id: products.id, domain: products.domain, status: products.status }).from(products).where(and(eq(products.organizationId, organizationId), ne(products.status, "DEPRECATED")));
  return prods
    .filter((p) => {
      if (!p.domain) return false;
      try {
        return Boolean(hostCoveredBy(new URL(`https://${p.domain.replace(/^https?:\/\//, "")}`).hostname, verified));
      } catch {
        return false;
      }
    })
    .map((p) => p.id);
}

/** Crawl history of a product (most recent first) with the stored diff summaries. */
export async function auditHistory(tx: Tx, organizationId: string, productId: string, limit = 50) {
  return tx.select().from(seoAudits).where(and(eq(seoAudits.organizationId, organizationId), eq(seoAudits.productId, productId))).orderBy(desc(seoAudits.createdAt)).limit(limit);
}

/** Audits of the organisation in a time window (for the history and rate limit display). */
export async function auditsSince(tx: Tx, organizationId: string, since: Date) {
  return tx.select({ id: seoAudits.id }).from(seoAudits).where(and(eq(seoAudits.organizationId, organizationId), gte(seoAudits.createdAt, since)));
}

export async function setIssueStatus(tx: Tx, organizationId: string, ids: string[], status: "OPEN" | "RESOLVED" | "IGNORED") {
  if (!ids.length) return 0;
  const r = await tx.update(seoIssues).set({ status }).where(and(eq(seoIssues.organizationId, organizationId), inArray(seoIssues.id, ids))).returning({ id: seoIssues.id });
  return r.length;
}
