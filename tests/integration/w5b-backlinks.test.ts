import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, withOrg, type Tx } from "@/db";
import { integrations, products, visibilityMetrics } from "@/db/schema";
import { saveIntegration, syncIntegration } from "@/services/visibility";
import { computeAndStoreScore } from "@/services/score";
import { NonRetryableError } from "@/jobs/queue";
import { isoDay } from "@/core/util/text";
import { newOrg, uid } from "./helpers";

let ctx: Awaited<ReturnType<typeof newOrg>>;
let orgId: string;
const q = <T,>(fn: (tx: Tx) => Promise<T>) => withOrg(orgId, fn);

/**
 * Mocked Bing Webmaster JSON API (https://ssl.bing.com/webmaster/api.svc/json/<Method>).
 * Search methods return empty lists; link methods return `links` unless a status is forced.
 */
function fakeBing(opts: { links?: { url: string; count: number; from: string[] }[]; status?: Record<string, number> } = {}) {
  const calls: URL[] = [];
  const f = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    calls.push(u);
    const method = u.pathname.split("/").pop()!;
    if (opts.status?.[method]) return new Response(`denied ${u.searchParams.get("apikey")}`, { status: opts.status[method] });
    if (method === "GetLinkCounts") {
      const page = Number(u.searchParams.get("page"));
      const links = page === 0 ? (opts.links ?? []).map((l) => ({ __type: "LinkCount:#Microsoft.Bing.Webmaster.Api.Interfaces", Url: l.url, Count: l.count })) : [];
      return Response.json({ d: { __type: "LinkCounts:#Microsoft.Bing.Webmaster.Api.Interfaces", Links: links, TotalPages: opts.links?.length ? 1 : 0 } });
    }
    if (method === "GetUrlLinks") {
      const target = (opts.links ?? []).find((l) => l.url === u.searchParams.get("link"));
      return Response.json({ d: { __type: "LinkDetails:#Microsoft.Bing.Webmaster.Api.Interfaces", Details: (target?.from ?? []).map((url) => ({ __type: "LinkDetail", Url: url, AnchorText: "anchor" })), TotalPages: 1 } });
    }
    return Response.json({ d: [] });
  }) as typeof fetch;
  return { f, calls };
}

async function bingProduct(siteUrl = "https://example.com/") {
  const productId = (await q((tx) => tx.insert(products).values({ organizationId: orgId, slug: `bl-${uid()}`, name: "Backlink Product" }).returning()))[0].id;
  const integ = await q((tx) => saveIntegration(tx, ctx.actor, { provider: "BING_WEBMASTER", productId, config: { siteUrl }, secret: { apiKey: "BINGKEY" } }));
  return { productId, integrationId: integ.id };
}
const linkMetrics = (productId: string) => q((tx) => tx.select().from(visibilityMetrics).where(and(eq(visibilityMetrics.productId, productId), eq(visibilityMetrics.provider, "BING_WEBMASTER"))));
const refLine = async (productId: string) => (await q((tx) => computeAndStoreScore(tx, orgId, productId))).components.find((c) => c.key === "authority")!.lines.find((l) => l.label === "Referring domains")!;

beforeAll(async () => {
  ctx = await newOrg("w5b");
  orgId = ctx.org.id;
});
afterEach(() => vi.unstubAllGlobals());
afterAll(closeDb);

describe("Bing backlinks in the sync job and the Beacon Score", () => {
  it("the sync writes inbound_links and referring_domains, and the score line becomes measurable with the source and date", async () => {
    const { productId, integrationId } = await bingProduct();
    const before = await refLine(productId);
    expect(before).toMatchObject({ measurable: false, reason: "Not measured: connect Bing Webmaster Tools (backlink data)." });

    const bing = fakeBing({
      links: [
        { url: "https://example.com/", count: 40, from: ["https://www.alpha.org/a", "https://alpha.org/b", "https://beta.net/", "https://example.com/internal"] },
        { url: "https://example.com/pricing", count: 9, from: ["https://gamma.io/x", "https://beta.net/y"] },
      ],
    });
    vi.stubGlobal("fetch", bing.f);
    const res = await syncIntegration(q, integrationId, undefined, { delayMs: 0 });
    expect(res).toMatchObject({ backlinks: { inboundLinks: 49, linkedPages: 2, referringDomains: 3, sampledTargets: 2, complete: true } });
    const today = isoDay(new Date());
    const rows = await linkMetrics(productId);
    expect(rows.filter((r) => ["inbound_links", "referring_domains"].includes(r.metric)).map((r) => ({ metric: r.metric, day: r.day, value: r.value, dimension: r.dimension })).sort((a, b) => a.metric.localeCompare(b.metric))).toEqual([
      { metric: "inbound_links", day: today, value: 49, dimension: "" },
      { metric: "referring_domains", day: today, value: 3, dimension: "" },
    ]);
    // GetUrlLinks sends the target page as `link`, along with siteUrl and the key.
    const urlLinks = bing.calls.filter((c) => c.pathname.endsWith("/GetUrlLinks"));
    expect(urlLinks.map((c) => c.searchParams.get("link"))).toEqual(["https://example.com/", "https://example.com/pricing"]);
    expect(urlLinks.every((c) => c.searchParams.get("siteUrl") === "https://example.com/")).toBe(true);

    const line = await refLine(productId);
    // 2 x log10(1 + 3) = 1.2 of 4
    expect(line).toMatchObject({ measurable: true, earned: 1.2, max: 4, reason: `Bing Webmaster Tools: 3 referring domains as of ${today} (sampled from the most-linked pages), 49 inbound links.` });

    // A second sync on the same day does not call the link API again.
    const again = fakeBing();
    vi.stubGlobal("fetch", again.f);
    expect(await syncIntegration(q, integrationId, undefined, { delayMs: 0 })).toMatchObject({ backlinks: "already measured today" });
    expect(again.calls.some((c) => /GetLinkCounts|GetUrlLinks/.test(c.pathname))).toBe(false);
  });

  it("Bing connected without link data writes nothing and the line says so (never 0)", async () => {
    const { productId, integrationId } = await bingProduct();
    vi.stubGlobal("fetch", fakeBing({ links: [] }).f);
    expect(await syncIntegration(q, integrationId, undefined, { delayMs: 0 })).toMatchObject({ backlinks: "no link data" });
    expect((await linkMetrics(productId)).filter((r) => r.metric === "inbound_links" || r.metric === "referring_domains")).toEqual([]);
    expect((await q((tx) => tx.query.integrations.findFirst({ where: eq(integrations.id, integrationId) })))!.status).toBe("CONNECTED");
    expect(await refLine(productId)).toMatchObject({ measurable: false, earned: 0, reason: "Not measured yet: Bing Webmaster Tools has returned no link data for this site." });
  });

  it("a link API failure keeps the search sync and leaves no link metric", async () => {
    const { productId, integrationId } = await bingProduct();
    vi.stubGlobal("fetch", fakeBing({ links: [{ url: "https://example.com/", count: 3, from: [] }], status: { GetLinkCounts: 503 } }).f);
    const res = await syncIntegration(q, integrationId, undefined, { delayMs: 0 });
    expect(String((res as { backlinks?: unknown }).backlinks)).toMatch(/^not measured: bing-webmaster HTTP 503/);
    expect(String((res as { backlinks?: unknown }).backlinks)).not.toContain("BINGKEY");
    expect((await linkMetrics(productId)).filter((r) => r.metric === "inbound_links" || r.metric === "referring_domains")).toEqual([]);
    expect((await q((tx) => tx.query.integrations.findFirst({ where: eq(integrations.id, integrationId) })))!.status).toBe("CONNECTED");
  });

  it("a 401 from the link API marks the integration EXPIRED and writes nothing", async () => {
    const { productId, integrationId } = await bingProduct();
    vi.stubGlobal("fetch", fakeBing({ links: [{ url: "https://example.com/", count: 3, from: ["https://a.org/"] }], status: { GetLinkCounts: 401 } }).f);
    const err = await syncIntegration(q, integrationId, undefined, { delayMs: 0 }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(NonRetryableError);
    expect((err as Error).message).not.toContain("BINGKEY");
    const integ = (await q((tx) => tx.query.integrations.findFirst({ where: eq(integrations.id, integrationId) })))!;
    expect(integ.status).toBe("EXPIRED");
    expect(await linkMetrics(productId)).toEqual([]);
    // EXPIRED is not "connected": the line asks to connect Bing again.
    expect(await refLine(productId)).toMatchObject({ measurable: false, reason: "Not measured: connect Bing Webmaster Tools (backlink data)." });
  });

  it("a property shared by two products only counts each product's own pages", async () => {
    const a = await bingProduct("https://shared.example/");
    const b = await bingProduct("https://shared.example/");
    await q((tx) => tx.update(products).set({ domain: "shared.example/a" }).where(eq(products.id, a.productId)));
    await q((tx) => tx.update(integrations).set({ config: { siteUrl: "https://shared.example/", urlPrefix: "https://shared.example/a/" } }).where(eq(integrations.id, a.integrationId)));
    await q((tx) => tx.update(integrations).set({ config: { siteUrl: "https://shared.example/", urlPrefix: "https://shared.example/b/" } }).where(eq(integrations.id, b.integrationId)));
    vi.stubGlobal(
      "fetch",
      fakeBing({
        links: [
          { url: "https://shared.example/a/", count: 5, from: ["https://one.org/"] },
          { url: "https://shared.example/b/", count: 7, from: ["https://two.org/", "https://three.org/"] },
        ],
      }).f,
    );
    await syncIntegration(q, a.integrationId, undefined, { delayMs: 0 });
    await syncIntegration(q, b.integrationId, undefined, { delayMs: 0 });
    const val = async (productId: string, metric: string) => (await linkMetrics(productId)).find((r) => r.metric === metric)?.value;
    expect([await val(a.productId, "inbound_links"), await val(a.productId, "referring_domains")]).toEqual([5, 1]);
    expect([await val(b.productId, "inbound_links"), await val(b.productId, "referring_domains")]).toEqual([7, 2]);
  });
});
