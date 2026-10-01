import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, withOrg, type Tx } from "@/db";
import { crawledPages, products, seoAudits, seoIssues } from "@/db/schema";
import { createAudit, executeAudit, latestAudit, openIssueCounts } from "@/services/seo";
import type { SafeResponse } from "@/lib/security/ssrf";
import { newOrg, uid } from "./helpers";

const ORIGINAL_SSRF = process.env.BEACON_SSRF_ALLOW_PRIVATE;
let orgId: string;
let productId: string;
let server: http.Server;
let base: string;
const requested: string[] = [];
const run = <T,>(fn: (tx: Tx) => Promise<T>) => withOrg(orgId, fn);

const page = (title: string | null, links: string[], extra = "") =>
  `<!doctype html><html lang="en"><head>${title ? `<title>${title}</title>` : ""}<meta name="description" content="A tiny test site used by the Beacon integration test suite."><meta name="viewport" content="width=device-width"></head><body><h1>${title ?? "Untitled"}</h1>${links.map((l) => `<a href="${l}">${l}</a>`).join(" ")}${extra}</body></html>`;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    requested.push(req.url ?? "");
    const send = (status: number, type: string, body: string) => {
      res.writeHead(status, { "content-type": type });
      res.end(body);
    };
    switch (req.url) {
      case "/robots.txt":
        return send(200, "text/plain", `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`);
      case "/sitemap.xml":
        return send(200, "application/xml", `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${base}/</loc></url><url><loc>${base}/about</loc></url><url><loc>${base}/orphan</loc></url></urlset>`);
      case "/":
        return send(200, "text/html; charset=utf-8", page("Tiny Test Site — Home page", ["/about", "/broken"]));
      case "/about":
        return send(200, "text/html; charset=utf-8", page(null, ["/"]));
      case "/orphan":
        return send(200, "text/html; charset=utf-8", page("Orphan page nobody links to", ["/"]));
      default:
        return send(404, "text/html", page("Not found — Tiny Test Site", []));
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  orgId = (await newOrg("seo")).org.id;
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

  it("createAudit uses the product domain by default and caps maxPages", async () => {
    const a = await run((tx) => createAudit(tx, orgId, productId, { maxPages: 10_000 }));
    expect(a).toMatchObject({ startUrl: "https://site.example", maxPages: 500, status: "QUEUED" });
    await run((tx) => tx.delete(seoAudits).where(eq(seoAudits.id, a.id)));
  });

  it("crawls a local site and stores crawled pages + issues (robots, sitemap, missing title, orphan, broken link)", async () => {
    process.env.BEACON_SSRF_ALLOW_PRIVATE = "true";
    const audit = await run((tx) => createAudit(tx, orgId, productId, { startUrl: `${base}/`, maxPages: 20 }));
    const res = await executeAudit(run, audit.id);
    expect(requested).toEqual(expect.arrayContaining(["/robots.txt", "/sitemap.xml", "/", "/about", "/orphan", "/broken"]));
    expect(res.pages).toBe(4);

    const done = (await run((tx) => tx.query.seoAudits.findFirst({ where: eq(seoAudits.id, audit.id) })))!;
    expect(done).toMatchObject({ status: "SUCCEEDED", pagesCrawled: 4, error: null });
    expect(done.summary.sitemapUrls).toBe(3);
    expect(done.finishedAt).toBeInstanceOf(Date);

    const crawled = await run((tx) => tx.select().from(crawledPages).where(eq(crawledPages.auditId, audit.id)));
    const byPath = new Map(crawled.map((c) => [new URL(c.url).pathname, c]));
    expect([...byPath.keys()].sort()).toEqual(["/", "/about", "/broken", "/orphan"]);
    expect(byPath.get("/broken")!.status).toBe(404);
    expect(byPath.get("/about")!.title).toBeNull();
    expect(byPath.get("/about")!.inlinks).toBe(1);
    expect(byPath.get("/orphan")!.inlinks).toBe(0);

    const issues = await run((tx) => tx.select().from(seoIssues).where(eq(seoIssues.auditId, audit.id)));
    const has = (rule: string, path: string) => issues.some((i) => i.rule === rule && new URL(i.url).pathname === path);
    expect(has("meta.title_missing", "/about")).toBe(true);
    expect(has("links.orphan", "/orphan")).toBe(true);
    expect(has("links.orphan", "/about")).toBe(false);
    expect(has("links.broken_internal", "/")).toBe(true);
    expect(issues.find((i) => i.rule === "links.broken_internal")!.details).toMatchObject({ target: `${base}/broken` });
    expect(has("http.error", "/broken")).toBe(true);
    expect(issues.some((i) => i.rule === "robots.missing" || i.rule === "sitemap.missing")).toBe(false);
    expect(issues.every((i) => i.productId === productId && i.organizationId === orgId)).toBe(true);
    expect(done.summary.HIGH).toBe(issues.filter((i) => i.severity === "HIGH").length);

    const latest = await run((tx) => latestAudit(tx, orgId, productId));
    expect(latest!.id).toBe(audit.id);
    const counts = await run((tx) => openIssueCounts(tx, audit.id));
    expect(counts.HIGH).toBeGreaterThanOrEqual(3);

    // Tenant isolation of audit results.
    const other = await newOrg("seo-other");
    expect(await withOrg(other.org.id, (tx) => tx.select().from(seoIssues).where(eq(seoIssues.auditId, audit.id)))).toHaveLength(0);
  });

  it("executeAudit with an injected fetcher; missing robots/sitemap are reported and re-running replaces results", async () => {
    const site = "https://fake.example";
    const resp = (url: string, status: number, body: string, type = "text/html"): SafeResponse => ({ url, status, headers: { "content-type": type }, body, bytes: body.length, elapsedMs: 1, redirects: [], truncated: false });
    const fetcher = async (url: string) => {
      const path = new URL(url).pathname;
      if (path === "/") return resp(url, 200, page("Fake site home page title", ["/a"]));
      if (path === "/a") return resp(url, 200, page("Fake site page A title", ["/"]));
      return resp(url, 404, "nope", "text/plain");
    };
    const audit = await run((tx) => createAudit(tx, orgId, productId, { startUrl: `${site}/` }));
    const first = await executeAudit(run, audit.id, fetcher);
    expect(first.pages).toBe(2);
    const issues = await run((tx) => tx.select().from(seoIssues).where(eq(seoIssues.auditId, audit.id)));
    expect(issues.map((i) => i.rule)).toEqual(expect.arrayContaining(["robots.missing", "sitemap.missing"]));
    const second = await executeAudit(run, audit.id, fetcher);
    expect(second.issues).toBe(first.issues);
    const issues2 = await run((tx) => tx.select().from(seoIssues).where(eq(seoIssues.auditId, audit.id)));
    expect(issues2).toHaveLength(issues.length);
    expect(await run((tx) => tx.select().from(crawledPages).where(eq(crawledPages.auditId, audit.id)))).toHaveLength(2);
  });

  it("a crawler failure marks the audit FAILED", async () => {
    const audit = await run((tx) => createAudit(tx, orgId, productId, { startUrl: "https://boom.example/" }));
    await expect(executeAudit(run, audit.id, async () => { throw new Error("network down"); })).resolves.toBeDefined();
    // Per-page fetch errors are recorded as issues, not failures:
    const issues = await run((tx) => tx.select().from(seoIssues).where(eq(seoIssues.auditId, audit.id)));
    expect(issues.map((i) => i.rule)).toEqual(expect.arrayContaining(["robots.unreachable", "http.unreachable"]));
    // An invalid start URL inside the crawler fails the audit.
    const bad = await run(async (tx) => (await tx.insert(seoAudits).values({ organizationId: orgId, productId, startUrl: "not a url" }).returning())[0]);
    await expect(executeAudit(run, bad.id, async () => { throw new Error("unused"); })).rejects.toThrow();
    const row = (await run((tx) => tx.query.seoAudits.findFirst({ where: eq(seoAudits.id, bad.id) })))!;
    expect(row.status).toBe("FAILED");
    expect(row.error).toBeTruthy();
  });
});
