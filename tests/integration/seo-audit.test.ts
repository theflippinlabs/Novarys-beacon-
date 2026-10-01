import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, systemDb, withOrg, type Tx } from "@/db";
import { HANDLERS, scheduleRecurring } from "@/jobs/handlers";
import { crawledPages, crawlLinks, jobs, products, seoAudits, seoIssues, sitemapSnapshots, verifiedDomains } from "@/db/schema";
import { AuditRefusedError, createAudit, createScheduledAudit, executeAudit, latestAudit, openIssueCounts, productsWithVerifiedDomain } from "@/services/seo";
import { addDomain, probeDomain, recordVerification } from "@/services/domains";
import { linkGraph } from "@/services/link-graph";
import { sitemapOverview } from "@/services/sitemaps";
import type { SafeResponse } from "@/lib/security/ssrf";
import { newOrg, uid } from "./helpers";

const ORIGINAL_SSRF = process.env.BEACON_SSRF_ALLOW_PRIVATE;
let orgId: string;
let orgSlug: string;
let productId: string;
let server: http.Server;
let base: string;
const requested: string[] = [];
const run = <T,>(fn: (tx: Tx) => Promise<T>) => withOrg(orgId, fn);

const page = (title: string | null, links: string[], extra = "") =>
  `<!doctype html><html lang="en"><head>${title ? `<title>${title}</title>` : ""}<meta name="description" content="A tiny test site used by the Beacon integration test suite."><meta name="viewport" content="width=device-width"></head><body><h1>${title ?? "Untitled"}</h1><h2>Section</h2>${links.map((l) => `<a href="${l}">${l}</a>`).join(" ")}${extra}</body></html>`;

const verify = (organizationId: string, domain: string) =>
  withOrg(organizationId, (tx) => tx.insert(verifiedDomains).values({ organizationId, domain, token: uid(), method: "DNS_TXT", verifiedAt: new Date() }).onConflictDoNothing());

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requested.push(req.url ?? "");
    const send = (status: number, type: string, body: string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": type, ...headers });
      res.end(body);
    };
    switch (req.url) {
      case "/robots.txt":
        return send(200, "text/plain", `User-agent: *\nAllow: /\nDisallow: /private\nSitemap: ${base}/sitemap.xml\n`);
      case "/sitemap.xml":
        return send(200, "application/xml", `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/</loc><lastmod>2026-09-01</lastmod></url><url><loc>${base}/about</loc></url><url><loc>${base}/orphan</loc></url><url><loc>${base}/moved</loc></url></urlset>`);
      case "/":
        return send(200, "text/html; charset=utf-8", page("Tiny Test Site | Home page", ["/about", "/broken", "/moved", "/private/x"], '<img src="/logo.png">'));
      case "/about":
        return send(200, "text/html; charset=utf-8", page(null, ["/"]));
      case "/orphan":
        return send(200, "text/html; charset=utf-8", page("Orphan page nobody links to", ["/"]));
      case "/moved":
        return send(301, "text/html", "", { location: "/about" });
      default:
        return send(404, "text/html", page("Not found | Tiny Test Site", []));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const o = await newOrg("seo");
  orgId = o.org.id;
  orgSlug = o.org.slug;
  productId = (await run((tx) => tx.insert(products).values({ organizationId: orgId, slug: `site-${uid()}`, name: "Site", domain: "site.example" }).returning()))[0].id;
});
afterAll(async () => {
  if (ORIGINAL_SSRF === undefined) delete process.env.BEACON_SSRF_ALLOW_PRIVATE;
  else process.env.BEACON_SSRF_ALLOW_PRIVATE = ORIGINAL_SSRF;
  await new Promise((r) => server.close(r));
  await closeDb();
});

describe("SEO audit", () => {
  it("createAudit rejects private / local start URLs when BEACON_SSRF_ALLOW_PRIVATE is not set", async () => {
    delete process.env.BEACON_SSRF_ALLOW_PRIVATE;
    for (const url of [`${base}/`, "http://127.0.0.1/", "http://10.0.0.5/", "http://169.254.169.254/latest/meta-data", "http://localhost/", "http://[::1]/", "ftp://site.example/"])
      await expect(run((tx) => createAudit(tx, orgId, productId, { startUrl: url })), url).rejects.toThrow(/not allowed|Only http/);
    const audits = await run((tx) => tx.select().from(seoAudits).where(eq(seoAudits.productId, productId)));
    expect(audits).toHaveLength(0);
  });

  it("requires a verified domain (host or parent) for the start URL, even with the local bypass enabled", async () => {
    process.env.BEACON_SSRF_ALLOW_PRIVATE = "true";
    await expect(run((tx) => createAudit(tx, orgId, productId, {}))).rejects.toThrow(/site\.example is not a verified domain.*\/discovery\/domains/);
    // A pending (unverified) domain does not count.
    await run((tx) => tx.insert(verifiedDomains).values({ organizationId: orgId, domain: "site.example", token: "t0" }));
    await expect(run((tx) => createAudit(tx, orgId, productId, {}))).rejects.toBeInstanceOf(AuditRefusedError);
    await run((tx) => tx.update(verifiedDomains).set({ verifiedAt: new Date() }).where(and(eq(verifiedDomains.organizationId, orgId), eq(verifiedDomains.domain, "site.example"))));
    const a = await run((tx) => createAudit(tx, orgId, productId, { startUrl: "https://www.site.example/start" }));
    expect(a.startUrl).toBe("https://www.site.example/start");
    await expect(run((tx) => createAudit(tx, orgId, productId, { startUrl: "https://evil-site.example/" }))).rejects.toThrow(/not a verified domain/);
    await run((tx) => tx.delete(seoAudits).where(eq(seoAudits.id, a.id)));
  });

  it("createAudit uses the product domain by default, caps maxPages and allows one active audit per product", async () => {
    const a = await run((tx) => createAudit(tx, orgId, productId, { maxPages: 10_000 }));
    expect(a).toMatchObject({ startUrl: "https://site.example", maxPages: 500, status: "QUEUED" });
    await expect(run((tx) => createAudit(tx, orgId, productId, {}))).rejects.toThrow(/already queued or running/);
    await run((tx) => tx.delete(seoAudits).where(eq(seoAudits.id, a.id)));
  });

  it("crawls a local site and stores page facts, link edges, sitemap snapshots and catalogue issues", async () => {
    process.env.BEACON_SSRF_ALLOW_PRIVATE = "true";
    const audit = await run((tx) => createAudit(tx, orgId, productId, { startUrl: `${base}/`, maxPages: 20 }));
    const progress: number[] = [];
    const res = await executeAudit(run, audit.id, undefined, { delayMs: 0, onProgress: (n) => void progress.push(n) });
    expect(requested).toEqual(expect.arrayContaining(["/robots.txt", "/sitemap.xml", "/", "/about", "/orphan", "/broken", "/moved"]));
    expect(requested).not.toContain("/private/x");
    expect(progress.length).toBeGreaterThan(0);
    expect(res.pages).toBe(5);

    const done = (await run((tx) => tx.query.seoAudits.findFirst({ where: eq(seoAudits.id, audit.id) })))!;
    expect(done).toMatchObject({ status: "SUCCEEDED", pagesCrawled: 5, error: null });
    expect(done.summary).toMatchObject({ sitemapUrls: 4, robotsBlocked: 1, redirects: 1, sitemaps: 1 });
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect(done.diff).toMatchObject({ previousAuditId: null });

    const crawled = await run((tx) => tx.select().from(crawledPages).where(eq(crawledPages.auditId, audit.id)));
    const byPath = new Map(crawled.map((c) => [new URL(c.url).pathname, c]));
    expect([...byPath.keys()].sort()).toEqual(["/", "/about", "/broken", "/moved", "/orphan"]);
    expect(byPath.get("/broken")!.status).toBe(404);
    expect(byPath.get("/about")!.title).toBeNull();
    // /about is linked from "/" directly and through the /moved redirect: one linking page.
    expect(byPath.get("/about")!.inlinks).toBe(1);
    expect(byPath.get("/orphan")!.inlinks).toBe(0);
    // The redirect is stored under the requested URL, with its final URL and chain (redirect map).
    expect(byPath.get("/moved")).toMatchObject({ status: 301, finalUrl: `${base}/about`, indexability: "REDIRECT", redirectChain: [`${base}/moved`, `${base}/about`], indexable: false });
    const home = byPath.get("/")!;
    expect(home).toMatchObject({ depth: 0, indexability: "INDEXABLE", outlinksCount: 4, h1: ["Tiny Test Site | Home page"] });
    expect(home.headings).toEqual([
      { level: 1, text: "Tiny Test Site | Home page" },
      { level: 2, text: "Section" },
    ]);
    expect(home.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(home.images).toEqual([{ src: `${base}/logo.png`, alt: null, hasWidth: false, hasHeight: false }]);
    expect(home.fetchedAt).toBeInstanceOf(Date);
    expect(byPath.get("/about")!.depth).toBe(1);

    const links = await run((tx) => tx.select().from(crawlLinks).where(eq(crawlLinks.auditId, audit.id)));
    expect(links.filter((l) => l.fromUrl === `${base}/`).map((l) => new URL(l.toUrl).pathname).sort()).toEqual(["/about", "/broken", "/moved", "/private/x"]);
    expect(links.find((l) => l.toUrl === `${base}/about` && l.fromUrl === `${base}/`)).toMatchObject({ anchor: "/about", nofollow: false, isInternal: true });

    const snaps = await run((tx) => tx.select().from(sitemapSnapshots).where(eq(sitemapSnapshots.auditId, audit.id)));
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ sitemapUrl: `${base}/sitemap.xml`, kind: "urlset", status: 200, urlCount: 4, compressed: false });
    expect(snaps[0].lastmodMax?.toISOString().slice(0, 10)).toBe("2026-09-01");

    const issues = await run((tx) => tx.select().from(seoIssues).where(eq(seoIssues.auditId, audit.id)));
    const has = (rule: string, path: string) => issues.some((i) => i.rule === rule && new URL(i.url).pathname === path);
    expect(has("meta.title_missing", "/about")).toBe(true);
    expect(has("links.orphan", "/orphan")).toBe(true);
    expect(has("links.orphan", "/about")).toBe(false);
    expect(has("links.broken_internal", "/")).toBe(true);
    expect(has("links.to_redirect", "/")).toBe(true);
    expect(has("sitemap.redirect_entry", "/moved")).toBe(true);
    expect(has("robots.blocked_url", "/private/x")).toBe(true);
    expect(has("images.alt_missing", "/")).toBe(true);
    expect(issues.find((i) => i.rule === "links.broken_internal")!.details).toMatchObject({ target: `${base}/broken` });
    expect(issues.find((i) => i.rule === "links.broken_internal")!.params).toEqual({ target: `${base}/broken`, status: 404 });
    expect(has("http.error", "/broken")).toBe(true);
    expect(issues.some((i) => i.rule === "robots.missing" || i.rule === "sitemap.missing")).toBe(false);
    expect(issues.every((i) => i.productId === productId && i.organizationId === orgId && i.fingerprint?.startsWith(`${productId}|${i.rule}|`))).toBe(true);
    expect(new Set(issues.map((i) => i.fingerprint)).size).toBe(issues.length);
    expect(done.summary.HIGH).toBe(issues.filter((i) => i.severity === "HIGH").length);

    const latest = await run((tx) => latestAudit(tx, orgId, productId));
    expect(latest!.id).toBe(audit.id);
    const counts = await run((tx) => openIssueCounts(tx, audit.id));
    expect(counts.HIGH).toBeGreaterThanOrEqual(3);

    // Link graph and sitemap control center read the stored crawl.
    const graph = (await run((tx) => linkGraph(tx, orgId, audit.id)))!;
    expect(graph.rows.find((r) => r.url === `${base}/orphan`)).toMatchObject({ orphan: true, inlinks: 0, cluster: "/orphan", clusterSource: "URL_PATH" });
    expect(graph.rows.find((r) => r.url === `${base}/`)).toMatchObject({ orphan: false, depth: 0, outlinks: 4 });
    const overview = await run((tx) => sitemapOverview(tx, orgId, orgSlug, productId));
    expect(overview).toMatchObject({ latestAuditId: audit.id, hosted: { urlCount: 0, generatedAt: null } });
    expect(overview.snapshots).toHaveLength(1);
    expect(overview.issueCounts.map((c) => c.rule)).toContain("sitemap.redirect_entry");

    // Tenant isolation of audit results, link edges and sitemap snapshots.
    const other = await newOrg("seo-other");
    await withOrg(other.org.id, async (tx) => {
      expect(await tx.select().from(seoIssues).where(eq(seoIssues.auditId, audit.id))).toHaveLength(0);
      expect(await tx.select().from(crawlLinks).where(eq(crawlLinks.auditId, audit.id))).toHaveLength(0);
      expect(await tx.select().from(sitemapSnapshots).where(eq(sitemapSnapshots.auditId, audit.id))).toHaveLength(0);
      expect(await tx.select().from(verifiedDomains)).toHaveLength(0);
      expect(await linkGraph(tx, other.org.id, audit.id)).toBeNull();
    });
  });

  it("re-running replaces results; the next audit diffs against the previous one and carries IGNORED/RESOLVED decisions", async () => {
    await verify(orgId, "fake.example");
    const site = "https://fake.example";
    let version = 1;
    const resp = (url: string, status: number, body: string, type = "text/html"): SafeResponse => ({ url, status, headers: { "content-type": type }, body, bytes: body.length, elapsedMs: 1, redirects: [], truncated: false });
    const fetcher = async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/") return resp(url, 200, page("Fake site home page title", version === 1 ? ["/a", "/b"] : ["/a", "/c"]));
      if (path === "/a") return resp(url, 200, page(version === 1 ? "Fake site page A title" : "Fake site page A new title", ["/"]));
      if (path === "/b") return resp(url, 200, page(null, ["/"]));
      if (path === "/c") return resp(url, 200, page(null, ["/"]));
      return resp(url, 404, "nope", "text/plain");
    };
    const first = await run((tx) => createAudit(tx, orgId, productId, { startUrl: `${site}/` }));
    const r1 = await executeAudit(run, first.id, fetcher);
    expect(r1.pages).toBe(3);
    const issues1 = await run((tx) => tx.select().from(seoIssues).where(eq(seoIssues.auditId, first.id)));
    expect(issues1.map((i) => i.rule)).toEqual(expect.arrayContaining(["robots.missing", "sitemap.missing"]));
    expect(issues1.find((i) => i.rule === "robots.missing")!.severity).toBe("LOW");
    const again = await executeAudit(run, first.id, fetcher);
    expect(again.issues).toBe(r1.issues);
    const rerun = await run((tx) => tx.select().from(seoIssues).where(eq(seoIssues.auditId, first.id)));
    expect(rerun).toHaveLength(issues1.length);
    expect(await run((tx) => tx.select().from(crawledPages).where(eq(crawledPages.auditId, first.id)))).toHaveLength(3);

    // Human decisions on the first audit.
    const ignored = rerun.find((i) => i.rule === "social.og_image" && new URL(i.url).pathname === "/")!;
    const resolved = rerun.find((i) => i.rule === "canonical.missing" && new URL(i.url).pathname === "/a")!;
    await run((tx) => tx.update(seoIssues).set({ status: "IGNORED" }).where(eq(seoIssues.id, ignored.id)));
    await run((tx) => tx.update(seoIssues).set({ status: "RESOLVED" }).where(eq(seoIssues.id, resolved.id)));

    version = 2;
    const second = await run((tx) => createAudit(tx, orgId, productId, { startUrl: `${site}/` }));
    await executeAudit(run, second.id, fetcher);
    const done = (await run((tx) => tx.query.seoAudits.findFirst({ where: eq(seoAudits.id, second.id) })))!;
    expect(done.diff).toMatchObject({ previousAuditId: first.id, newPages: 1, removedPages: 1, carriedIgnored: 1, stillDetectedResolved: 1 });
    expect(done.diff!.changed.title).toBe(1);
    expect(done.diff!.examples.newPages).toEqual([`${site}/c`]);
    expect(done.diff!.fixedIssues).toBeGreaterThan(0);
    const issues2 = await run((tx) => tx.select().from(seoIssues).where(eq(seoIssues.auditId, second.id)));
    expect(issues2.find((i) => i.fingerprint === ignored.fingerprint)!.status).toBe("IGNORED");
    expect(issues2.find((i) => i.fingerprint === resolved.fingerprint)!.status).toBe("RESOLVED");
    expect(issues2.filter((i) => i.status === "OPEN").length).toBe(issues2.length - 2);
  });

  it("robots.txt unreachable stops the audit with a clear error (FAILED)", async () => {
    await verify(orgId, "boom.example");
    const audit = await run((tx) => createAudit(tx, orgId, productId, { startUrl: "https://boom.example/" }));
    await expect(executeAudit(run, audit.id, async () => { throw new Error("network down"); })).rejects.toThrow(/robots\.txt could not be fetched/);
    const row = (await run((tx) => tx.query.seoAudits.findFirst({ where: eq(seoAudits.id, audit.id) })))!;
    expect(row.status).toBe("FAILED");
    expect(row.error).toMatch(/fully disallowed/);
    // An invalid start URL inside the crawler fails the audit.
    const bad = await run(async (tx) => (await tx.insert(seoAudits).values({ organizationId: orgId, productId, startUrl: "not a url" }).returning())[0]);
    await expect(executeAudit(run, bad.id, async () => { throw new Error("unused"); })).rejects.toThrow();
    expect((await run((tx) => tx.query.seoAudits.findFirst({ where: eq(seoAudits.id, bad.id) })))!.status).toBe("FAILED");
  });

  it("limits audits to 10 per hour per organisation", async () => {
    const o = await newOrg("seo-rate");
    await verify(o.org.id, "rate.example");
    const pid = (await withOrg(o.org.id, (tx) => tx.insert(products).values({ organizationId: o.org.id, slug: `r-${uid()}`, name: "R", domain: "rate.example" }).returning()))[0].id;
    await withOrg(o.org.id, (tx) => tx.insert(seoAudits).values(Array.from({ length: 10 }, () => ({ organizationId: o.org.id, productId: pid, startUrl: "https://rate.example/", status: "SUCCEEDED" as const }))));
    await expect(withOrg(o.org.id, (tx) => createAudit(tx, o.org.id, pid, {}))).rejects.toThrow(/at most 10 audits per hour/);
    // Scheduled audits respect the same rules and report why they were skipped.
    expect(await withOrg(o.org.id, (tx) => createScheduledAudit(tx, o.org.id, pid))).toEqual({ skipped: "RATE_LIMITED" });
    expect(await withOrg(o.org.id, (tx) => productsWithVerifiedDomain(tx, o.org.id))).toEqual([pid]);
    // The weekly scheduler enqueues one audit per verified product per week; the handler creates (or skips) it.
    await scheduleRecurring(new Date());
    await scheduleRecurring(new Date());
    const queued = await systemDb().select().from(jobs).where(and(eq(jobs.organizationId, o.org.id), eq(jobs.type, "seo.audit")));
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toEqual({ productId: pid, scheduled: true });
    expect(await HANDLERS["seo.audit"](queued[0], { heartbeat: async () => undefined })).toEqual({ skipped: "RATE_LIMITED" });
    await systemDb().update(jobs).set({ status: "CANCELLED" }).where(eq(jobs.id, queued[0].id));
  });
});

describe("domain verification", () => {
  it("adds a domain with a token, verifies it through DNS TXT or the well-known file, and records failures", async () => {
    const o = await newOrg("dom");
    const row = await withOrg(o.org.id, (tx) => addDomain(tx, o.actor, "https://WWW.Verify-Me.example/path"));
    expect(row).toMatchObject({ domain: "www.verify-me.example", verifiedAt: null });
    expect(row.token).toMatch(/^[0-9a-f]{32}$/);
    expect((await withOrg(o.org.id, (tx) => addDomain(tx, o.actor, "www.verify-me.example"))).id).toBe(row.id);
    await expect(withOrg(o.org.id, (tx) => addDomain(tx, o.actor, "co.uk"))).rejects.toThrow(/domain name you control/);

    const fail = await probeDomain(row.domain, row.token, { resolveTxt: async () => [["beacon-verification=wrong"]], fetchFile: async () => ({ status: 404, body: "" }) });
    expect(fail).toMatchObject({ ok: false, method: null });
    expect(fail.error).toMatch(/DNS: no matching TXT record; File: HTTP 404/);
    const failed = await withOrg(o.org.id, (tx) => recordVerification(tx, o.actor, row.id, fail));
    expect(failed.verifiedAt).toBeNull();
    expect(failed.lastError).toMatch(/HTTP 404/);

    const viaFile = await probeDomain(row.domain, row.token, { resolveTxt: async () => Promise.reject(Object.assign(new Error("x"), { code: "ENODATA" })), fetchFile: async (u) => (u === `https://${row.domain}/.well-known/beacon-verification.txt` ? { status: 200, body: `${row.token}\n` } : { status: 404, body: "" }) });
    expect(viaFile).toMatchObject({ ok: true, method: "WELL_KNOWN_FILE" });
    const viaDns = await probeDomain(row.domain, row.token, { resolveTxt: async () => [[`beacon-verification=${row.token}`]], fetchFile: async () => ({ status: 500, body: "" }) });
    expect(viaDns).toMatchObject({ ok: true, method: "DNS_TXT" });
    const ok = await withOrg(o.org.id, (tx) => recordVerification(tx, o.actor, row.id, viaDns));
    expect(ok).toMatchObject({ method: "DNS_TXT", lastError: null });
    expect(ok.verifiedAt).toBeInstanceOf(Date);

    // Another tenant cannot see or verify it.
    const other = await newOrg("dom-other");
    await expect(withOrg(other.org.id, (tx) => recordVerification(tx, other.actor, row.id, viaDns))).rejects.toThrow(/Domain not found/);
    expect(await withOrg(other.org.id, (tx) => tx.select().from(verifiedDomains))).toHaveLength(0);
  });
});
