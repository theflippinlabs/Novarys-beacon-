import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { asSystem, closeDb, withOrg, type Tx } from "@/db";
import { conversionEvents, crawledPages, jobs, knowledgeProposals, pages, productClaims, productFacets, productPricing, products, productSources, seoAudits, seoIssues, sitemapSnapshots, verifiedDomains } from "@/db/schema";
import { createSession } from "@/lib/auth/service";
import { createProduct } from "@/services/products";
import { acceptProposal, extractFromWebsite, ExtractionRefusedError, listProposals, rejectProposals, type PageFetcher } from "@/services/extraction";
import { setOnboardingStep, stepsOf } from "@/services/onboarding";
import { captureBaseline, launchFacts, launchMonitoring, launchProduct, productLaunchChecklist } from "@/services/launch";
import { launchChecklist } from "@/core/launch/checklist";
import { progress, resumeAt, stepState } from "@/core/onboarding/steps";
import { addQuery } from "@/services/queries";
import { createKey, newOrg, seedCompleteProduct, uid } from "./helpers";

/** Server actions run through act() as in production; only the Next.js request APIs are replaced. */
let session: string | null = null;
class Redirect extends Error {
  constructor(public url: string) {
    super(`redirect ${url}`);
  }
}
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => (session ? { value: session } : undefined), set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers({ "x-forwarded-for": "10.9.8.6" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Redirect(url);
  },
  notFound: () => {
    throw new Redirect("/404");
  },
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined, revalidateTag: () => undefined }));

const { saveOnboardingStepAction } = await import("@/app/actions/products");
const { advanceOnboardingAction } = await import("@/app/actions/onboarding");

async function run(action: (fd: FormData) => Promise<unknown>, fields: Record<string, string>) {
  const fd = new FormData();
  fd.set("_back", "/t");
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  try {
    await action(fd);
  } catch (e) {
    if (!(e instanceof Redirect)) throw e;
    const u = new URL(e.url, "http://x");
    return { path: `${u.pathname}${u.search.replace(/[?&](ok|error|fs)=[^&]*/g, "")}`, ok: u.searchParams.get("ok"), error: u.searchParams.get("error") };
  }
  throw new Error("action did not redirect");
}

type Ctx = Awaited<ReturnType<typeof newOrg>>;
let A: Ctx;
let B: Ctx;

beforeAll(async () => {
  A = await newOrg("onbl-a");
  B = await newOrg("onbl-b");
  session = (await createSession(A.user.id)).token;
});
afterAll(closeDb);

const q = <T>(fn: (tx: Tx) => Promise<T>) => withOrg(A.org.id, fn);
const runA = <T>(fn: (tx: Tx) => Promise<T>) => withOrg(A.org.id, fn);

const HOME = `<!doctype html><html><head><title>Clip Forge | Video clipping for streamers</title>
<meta name="description" content="Clip Forge turns long live streams into short clips for TikTok and YouTube Shorts.">
<script type="application/ld+json">{"@type":"SoftwareApplication","name":"Clip Forge","applicationCategory":"MultimediaApplication","offers":{"@type":"Offer","name":"Pro","price":"12","priceCurrency":"USD"}}</script>
</head><body><a href="/pricing">Pricing</a><a href="/docs/">Docs</a><a href="/private/">Private</a>
<h1>Clips from every stream</h1><h2>Auto highlights</h2><p>Finds the moments chat reacted to and cuts them into clips.</p>
<a href="https://x.com/clipforge">X</a></body></html>`;

function fakeSite(domain: string, opts: { robots?: string; status?: Record<string, number> } = {}): { fetcher: PageFetcher; calls: string[] } {
  const calls: string[] = [];
  const pagesByPath: Record<string, string> = {
    "/": HOME,
    "/pricing": `<html><head><title>Pricing</title></head><body><h1>Pricing</h1></body></html>`,
    "/docs/": `<html><head><title>Docs</title></head><body><h1>Docs</h1></body></html>`,
  };
  return {
    calls,
    fetcher: async (url): Promise<Awaited<ReturnType<PageFetcher>>> => {
      calls.push(url);
      const u = new URL(url);
      if (u.hostname !== domain) throw new Error("unexpected host");
      if (u.pathname === "/robots.txt") return opts.robots ? { url, status: 200, body: opts.robots, headers: { "content-type": "text/plain" } } : { url, status: 404, body: "", headers: {} };
      const status = opts.status?.[u.pathname] ?? (pagesByPath[u.pathname] ? 200 : 404);
      return { url, status, body: pagesByPath[u.pathname] ?? "", headers: { "content-type": "text/html; charset=utf-8" } };
    },
  };
}

describe("website extraction (onboarding WEBSITE step)", () => {
  let productId: string;
  const domain = `clipforge-${uid()}.example`;

  beforeAll(async () => {
    const p = await q((tx) => createProduct(tx, A.actor, { name: `Clip Forge ${uid()}` }));
    productId = p.id;
    await q((tx) => tx.update(products).set({ domain }).where(eq(products.id, productId)));
  });

  it("refuses an unverified domain and never touches the network", async () => {
    const site = fakeSite(domain);
    await expect(extractFromWebsite(runA, A.actor, productId, { fetcher: site.fetcher, delayMs: 0 })).rejects.toBeInstanceOf(ExtractionRefusedError);
    expect(site.calls).toEqual([]);
  });

  it("crawls the homepage and key pages (robots.txt honoured) and proposes UNVERIFIED facts with their sources", async () => {
    await q((tx) => tx.insert(verifiedDomains).values({ organizationId: A.org.id, domain, token: uid(), verifiedAt: new Date(), method: "DNS_TXT" }));
    const site = fakeSite(domain, { robots: "User-agent: *\nDisallow: /docs/\n" });
    const r = await extractFromWebsite(runA, A.actor, productId, { fetcher: site.fetcher, delayMs: 0 });
    expect(site.calls).toContain(`https://${domain}/robots.txt`);
    expect(site.calls).toContain(`https://${domain}/pricing`);
    expect(site.calls).not.toContain(`https://${domain}/docs/`);
    expect(r.pages).toBe(2);
    expect(r.errors.some((e) => e.includes("disallowed by robots.txt"))).toBe(true);
    const rows = await q((tx) => listProposals(tx, A.org.id, productId));
    expect(rows.length).toBe(r.inserted);
    expect(rows.every((x) => x.status === "PROPOSED")).toBe(true);
    const desc = rows.find((x) => x.kind === "CLAIM" && x.field === "short_description" && x.origin === "meta_description")!;
    expect(desc.sourceUrl).toBe(`https://${domain}/`);
    expect(rows.find((x) => x.kind === "CLAIM" && x.field === "pricing_url")).toMatchObject({ value: `https://${domain}/pricing` });
    expect(rows.find((x) => x.kind === "CLAIM" && x.field === "documentation_url")).toBeUndefined();
    // Nothing was written to the knowledge graph yet.
    const facets = await q((tx) => tx.select().from(productFacets).where(eq(productFacets.productId, productId)));
    expect(facets).toEqual([]);
    // Idempotent: a second extraction proposes nothing new.
    const again = await extractFromWebsite(runA, A.actor, productId, { fetcher: fakeSite(domain, { robots: "User-agent: *\nDisallow: /docs/\n" }).fetcher, delayMs: 0 });
    expect(again.inserted).toBe(0);
  });

  it("accepting a proposal adds it UNVERIFIED with the crawled URL as its source", async () => {
    const rows = await q((tx) => listProposals(tx, A.org.id, productId, "PROPOSED"));
    const desc = rows.find((x) => x.field === "short_description" && x.origin === "meta_description")!;
    const feature = rows.find((x) => x.kind === "FACET" && x.value === "Auto highlights")!;
    const plan = rows.find((x) => x.kind === "PRICING")!;
    for (const x of [desc, feature, plan]) await q((tx) => acceptProposal(tx, A.actor, x.id));

    const p = (await q((tx) => tx.query.products.findFirst({ where: eq(products.id, productId) })))!;
    expect(p.shortDescription).toBe(desc.value);
    const src = (await q((tx) => tx.query.productSources.findFirst({ where: and(eq(productSources.productId, productId), eq(productSources.url, `https://${domain}/`)) })))!;
    expect(src.kind).toBe("WEBSITE");
    const claim = (await q((tx) => tx.query.productClaims.findFirst({ where: and(eq(productClaims.productId, productId), eq(productClaims.field, "short_description")) })))!;
    expect(claim).toMatchObject({ value: desc.value, verification: "UNVERIFIED", sourceId: src.id, verifiedAt: null });
    const facet = (await q((tx) => tx.query.productFacets.findFirst({ where: and(eq(productFacets.productId, productId), eq(productFacets.name, "Auto highlights")) })))!;
    expect(facet).toMatchObject({ kind: "FEATURE", verification: "UNVERIFIED", sourceId: src.id, description: "Finds the moments chat reacted to and cuts them into clips." });
    const pricing = (await q((tx) => tx.select().from(productPricing).where(eq(productPricing.productId, productId))))[0];
    // The billing interval is never guessed.
    expect(pricing).toMatchObject({ planName: "Pro", priceCents: 1200, currency: "USD", interval: null, verification: "UNVERIFIED", sourceId: src.id });

    await expect(q((tx) => acceptProposal(tx, A.actor, desc.id))).rejects.toThrow(/already decided/);
    const rest = (await q((tx) => listProposals(tx, A.org.id, productId, "PROPOSED"))).map((x) => x.id);
    expect(await q((tx) => rejectProposals(tx, A.actor, rest))).toBe(rest.length);
    expect(await q((tx) => listProposals(tx, A.org.id, productId, "PROPOSED"))).toEqual([]);
  });

  it("keeps proposals tenant-isolated", async () => {
    const own = await withOrg(B.org.id, (tx) => tx.select().from(knowledgeProposals));
    expect(own).toEqual([]);
    const any = (await q((tx) => listProposals(tx, A.org.id, productId)))[0];
    await expect(withOrg(B.org.id, (tx) => acceptProposal(tx, B.actor, any.id))).rejects.toThrow(/not found/);
  });
});

describe("onboarding step status and resume", () => {
  let productId: string;
  let slug: string;

  it("stores done and skipped per step, resumes at the first pending one and never shows a skip as done", async () => {
    const p = await q((tx) => createProduct(tx, A.actor, { name: `Resume ${uid()}` }));
    productId = p.id;
    slug = p.slug;
    expect(await run(saveOnboardingStepAction, { productId, step: "1", flow: "product", intent: "next", name: p.name, status: "BETA" })).toMatchObject({ path: `/products/${slug}/onboarding?step=website` });
    expect(await run(saveOnboardingStepAction, { productId, step: "2", flow: "website", intent: "skip" })).toMatchObject({ path: `/products/${slug}/onboarding?step=info&part=category` });
    expect(await run(saveOnboardingStepAction, { productId, step: "3", flow: "info", part: "category", intent: "next", category: "Video software" })).toMatchObject({ path: `/products/${slug}/onboarding?step=info&part=description` });
    const after = (await q((tx) => tx.query.products.findFirst({ where: eq(products.id, productId) })))!;
    expect(after.category).toBe("Video software");
    const steps = stepsOf(after);
    expect(stepState(steps, "product").status).toBe("done");
    expect(stepState(steps, "website").status).toBe("skipped");
    expect(steps.website.at).not.toBeNull();
    expect(progress(steps)).toMatchObject({ done: 1, skipped: 1 });
    expect(resumeAt(steps)).toEqual({ step: "info", part: "description" });
    // "Save" alone does not settle a step.
    await run(saveOnboardingStepAction, { productId, step: "4", flow: "info", part: "description", intent: "save", shortDescription: "Clips from streams." });
    expect(resumeAt(stepsOf((await q((tx) => tx.query.products.findFirst({ where: eq(products.id, productId) })))!))).toEqual({ step: "info", part: "description" });
  });

  it("advances steps without forms and finishes onboarding with the analysis queued", async () => {
    expect(await run(advanceOnboardingAction, { productId, flow: "crawl", intent: "skip" })).toMatchObject({ path: `/products/${slug}/onboarding?step=queries` });
    const finish = await run(advanceOnboardingAction, { productId, flow: "score", intent: "next" });
    expect(finish).toMatchObject({ path: `/products/${slug}`, ok: "Onboarding complete, product analysis queued." });
    const p = (await q((tx) => tx.query.products.findFirst({ where: eq(products.id, productId) })))!;
    expect(p.onboardingCompletedAt).toBeInstanceOf(Date);
    expect(stepState(stepsOf(p), "crawl").status).toBe("skipped");
    expect(stepState(stepsOf(p), "score").status).toBe("done");
    const queued = await asSystem((tx) => tx.select().from(jobs).where(and(eq(jobs.organizationId, A.org.id), eq(jobs.type, "product.analyze"))));
    expect(queued.some((j) => j.payload.productId === productId)).toBe(true);
  });

  it("refuses an unknown step and keeps legacy integer progress readable", async () => {
    expect((await run(advanceOnboardingAction, { productId, flow: "nope" })).error).toMatch(/Invalid value/);
    const steps = await q((tx) => setOnboardingStep(tx, A.actor, productId, "verify", "done"));
    expect(steps.verify.status).toBe("done");
  });
});

describe("launch checklist and launch mode", () => {
  let productId: string;
  let domain: string;
  let auditId: string;

  beforeAll(async () => {
    const { product: p } = await seedCompleteProduct(A.org.id, { name: `Launchable ${uid()}` });
    productId = p.id;
    domain = p.domain!;
  });

  it("derives each item from real state; a published non-product page is not the product page", async () => {
    await q((tx) => tx.insert(pages).values({ organizationId: A.org.id, productId, type: "FEATURE", path: `/f-${uid()}`, title: "Feature", status: "PUBLISHED" }));
    let byKey = Object.fromEntries((await q((tx) => productLaunchChecklist(tx, A.org.id, productId))).map((i) => [i.key, i]));
    expect(byKey.core_pages.status).toBe("TODO");
    expect(byKey.site.status).toBe("TODO");
    expect(byKey.sitemap.evidence.text).toBe("No successful audit yet.");
    expect(byKey.search_console.status).toBe("NOT_CONNECTED");

    await q((tx) => tx.insert(pages).values({ organizationId: A.org.id, productId, type: "PRODUCT", path: `/p-${uid()}`, title: "Product", status: "PUBLISHED" }));
    await q((tx) => tx.insert(verifiedDomains).values({ organizationId: A.org.id, domain, token: uid(), verifiedAt: new Date(), method: "DNS_TXT" }));
    const start = `https://${domain}/`;
    const [a] = await q((tx) => tx.insert(seoAudits).values({ organizationId: A.org.id, productId, startUrl: start, status: "SUCCEEDED", finishedAt: new Date(), pagesCrawled: 2 }).returning());
    auditId = a.id;
    await q((tx) => tx.insert(crawledPages).values([{ organizationId: A.org.id, auditId, url: start, status: 200, depth: 0, finalUrl: start }, { organizationId: A.org.id, auditId, url: `${start}deep`, status: 200, depth: 3 }]));
    await q((tx) => tx.insert(sitemapSnapshots).values({ organizationId: A.org.id, auditId, sitemapUrl: `${start}sitemap.xml`, kind: "urlset", status: 200, urlCount: 2 }));
    await q((tx) =>
      tx.insert(seoIssues).values([
        { organizationId: A.org.id, auditId, productId, url: start, rule: "schema.required_missing", severity: "MEDIUM", message: "missing" },
        { organizationId: A.org.id, auditId, productId, url: `${start}deep`, rule: "schema.invalid_json", severity: "MEDIUM", message: "deep page only" },
      ]),
    );
    byKey = Object.fromEntries((await q((tx) => productLaunchChecklist(tx, A.org.id, productId))).map((i) => [i.key, i]));
    expect(byKey.core_pages.status).toBe("DONE");
    expect(byKey.site).toMatchObject({ status: "DONE", evidence: { params: { domain } } });
    expect(byKey.critical_issues).toMatchObject({ status: "DONE", blocking: true, evidence: { params: { n: 0 } } });
    expect(byKey.sitemap.status).toBe("DONE");
    // Only the homepage error counts (the deep page is not a key page).
    expect(byKey.structured_data).toMatchObject({ status: "TODO", evidence: { params: { n: 1 } } });
    await q((tx) => tx.update(seoIssues).set({ status: "RESOLVED" }).where(and(eq(seoIssues.auditId, auditId), eq(seoIssues.url, start))));
    expect((await q((tx) => productLaunchChecklist(tx, A.org.id, productId))).find((i) => i.key === "structured_data")!.status).toBe("DONE");
    // The seeded documentation URL claim is verified.
    expect(byKey.documentation.status).toBe("DONE");
  });

  it("refuses to launch while blocking items are open, unless forced; captures the baseline and starts monitoring", async () => {
    const facts = await q((tx) => launchFacts(tx, A.org.id, productId));
    expect(launchChecklist(facts).find((i) => i.key === "conversion_tracking")!.status).toBe("TODO");
    await expect(q((tx) => launchProduct(tx, A.actor, productId))).rejects.toThrow(/Launch blocked by .*Conversion tracking ready/);

    await createKey(A.org.id, "PUBLISHABLE", { productId, allowedOrigins: [domain] });
    await q((tx) => tx.insert(conversionEvents).values({ organizationId: A.org.id, productId, type: "PAGE_VIEW", visitorId: "v1" }));
    await q((tx) => addQuery(tx, A.org.id, { query: `clip tool ${uid()}`, productId, status: "ACTIVE" }));
    const b = await q((tx) => captureBaseline(tx, A.actor, productId));
    expect(b.search).toBeNull(); // no search provider: not a zero
    expect(b.activeQueries).toBe(1);
    expect(b.visitorsPerDay).not.toBeNull();

    const r = await q((tx) => launchProduct(tx, A.actor, productId, { force: true }));
    const p = (await q((tx) => tx.query.products.findFirst({ where: eq(products.id, productId) })))!;
    expect(p.launchMode).toBe("LAUNCH");
    expect(p.launchedAt).toBeInstanceOf(Date);
    expect(p.launchDate).toBe(new Date().toISOString().slice(0, 10));
    expect(r.blockers.every((x) => x.blocking)).toBe(true);
    await expect(q((tx) => launchProduct(tx, A.actor, productId, { force: true }))).rejects.toThrow(/already launched/);

    const m = (await q((tx) => launchMonitoring(tx, A.org.id, productId)))!;
    expect(m.start).toBe(p.launchDate);
    const series = Object.fromEntries(m.series.map((s) => [s.key, s]));
    expect(series.clicks.state).toBe("NOT_CONNECTED");
    expect(series.clicks.rows.every((x) => x.value === null)).toBe(true);
    expect(series.visitors.state).toBe("OK");
    expect(series.visitors.rows.at(-1)!.value).toBe(1);
    const post = Object.fromEntries((await q((tx) => productLaunchChecklist(tx, A.org.id, productId))).map((i) => [i.key, i]));
    expect(post.first_events.status).toBe("DONE");
    expect(post.search_since_launch.status).toBe("NOT_CONNECTED");
  });
});
