import { describe, expect, it } from "vitest";
import { pagesToRead, parseLinkCounts, parseUrlLinks, referringDomain, summarizeBacklinks, topLinkedPages } from "@/core/search/backlinks";
import { createBingAdapter } from "@/integrations/bing";
import { computeBeaconScore, type ScoreInput } from "@/core/score/beacon-score";
import { backlinkMetrics } from "@/services/visibility";
import { makeT } from "@/i18n/core";
import { FR } from "@/i18n/fr";

describe("Bing link responses: defensive parsing", () => {
  it("parses LinkCounts and drops entries without a URL or a valid count", () => {
    const r = parseLinkCounts({
      __type: "LinkCounts:#Microsoft.Bing.Webmaster.Api.Interfaces",
      Links: [
        { __type: "LinkCount", Url: "https://example.com/", Count: 12 },
        { Url: "https://example.com/pricing", Count: "3" },
        { Url: "https://example.com/x", Count: -1 },
        { Url: "https://example.com/y" },
        { Url: "https://example.com/z", Count: null },
        { Count: 4 },
        { Url: "ftp://example.com/", Count: 1 },
        "junk",
        null,
      ],
      TotalPages: 2,
    });
    expect(r).toEqual({
      items: [
        { url: "https://example.com/", count: 12 },
        { url: "https://example.com/pricing", count: 3 },
      ],
      totalPages: 2,
    });
  });

  it("unknown or missing shapes yield no items and an unknown page count (never invented)", () => {
    for (const d of [null, undefined, [], "x", 3, {}, { Links: null }, { Links: "a" }]) expect(parseLinkCounts(d)).toEqual({ items: [], totalPages: null });
    expect(parseLinkCounts({ Links: [], TotalPages: 0 })).toEqual({ items: [], totalPages: 0 });
    expect(parseLinkCounts({ Links: [], TotalPages: "n/a" }).totalPages).toBeNull();
  });

  it("parses LinkDetails (linking URLs) and ignores anchors without URLs", () => {
    const r = parseUrlLinks({ Details: [{ __type: "LinkDetail", AnchorText: "great tool", Url: "https://blog.other.org/post" }, { AnchorText: "no url" }, { Url: 42 }], TotalPages: 3 });
    expect(r).toEqual({ items: ["https://blog.other.org/post"], totalPages: 3 });
    expect(parseUrlLinks({ Details: null })).toEqual({ items: [], totalPages: null });
  });
});

describe("referring domain normalisation (host level, www stripped)", () => {
  it("normalises case, www, ports, trailing dots and paths", () => {
    expect(referringDomain("https://WWW.Example.COM/a?b=1")).toBe("example.com");
    expect(referringDomain("http://example.com.:8080/")).toBe("example.com");
    expect(referringDomain("https://blog.example.com/")).toBe("blog.example.com");
    expect(referringDomain("mailto:a@example.com")).toBeNull();
    expect(referringDomain("not a url")).toBeNull();
  });

  it("summarises distinct referring hosts, excluding the site's own host", () => {
    const s = summarizeBacklinks({
      counts: [
        { url: "https://example.com/", count: 10 },
        { url: "https://example.com/pricing", count: 5 },
        { url: "https://example.com/", count: 10 },
      ],
      linking: [
        { target: "https://example.com/", urls: ["https://a.org/1", "https://www.a.org/2", "https://b.net/", "https://www.example.com/blog"] },
        { target: "https://example.com/pricing", urls: ["https://c.io/x", "bad"] },
      ],
      ownHosts: ["https://www.example.com/"],
      complete: true,
    });
    expect(s).toEqual({ inboundLinks: 15, linkedPages: 2, referringDomains: 3, sampledTargets: 2, complete: true });
  });

  it("no link counts means no measurement; counts without linking URLs leave domains unknown", () => {
    expect(summarizeBacklinks({ counts: [], linking: [], ownHosts: [], complete: true })).toBeNull();
    expect(summarizeBacklinks({ counts: [{ url: "https://e.com/", count: 2 }], linking: [{ target: "https://e.com/", urls: [] }], ownHosts: [], complete: true })?.referringDomains).toBeNull();
  });

  it("orders targets by count and caps pages to read", () => {
    expect(topLinkedPages([{ url: "https://e.com/b", count: 1 }, { url: "https://e.com/a", count: 5 }, { url: "https://e.com/c", count: 5 }], 2)).toEqual(["https://e.com/a", "https://e.com/c"]);
    expect(pagesToRead(null, 4)).toBe(4);
    expect(pagesToRead(2, 4)).toBe(2);
    expect(pagesToRead(9, 4)).toBe(4);
  });
});

/** Fake Bing link API: `pages` site pages per LinkCounts page, linking URLs per target. */
function fakeBing(opts: { countPages: number; perPage?: number; linksTotalPages?: number; status?: Record<string, number> } = { countPages: 1 }) {
  const calls: URL[] = [];
  const f = (async (input: string | URL | Request) => {
    const u = new URL(String(input));
    calls.push(u);
    const method = u.pathname.split("/").pop()!;
    if (opts.status?.[method]) return new Response("nope", { status: opts.status[method] });
    const page = Number(u.searchParams.get("page"));
    if (method === "GetLinkCounts") {
      const links = page < opts.countPages ? Array.from({ length: opts.perPage ?? 2 }, (_, i) => ({ Url: `https://example.com/p${page}-${i}`, Count: 10 * (page + 1) + i })) : [];
      return Response.json({ d: { Links: links, TotalPages: opts.countPages } });
    }
    if (method === "GetUrlLinks") {
      const target = u.searchParams.get("link")!;
      return Response.json({ d: { Details: [{ Url: `https://ref-${page}.org/${encodeURIComponent(target)}`, AnchorText: "x" }, { Url: "https://shared.net/", AnchorText: "y" }], TotalPages: opts.linksTotalPages ?? 1 } });
    }
    return new Response("unknown", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

describe("Bing adapter fetchBacklinks: paging and budget", () => {
  const config = { siteUrl: "https://example.com/" };
  const secret = { apiKey: "BINGKEY" };

  it("reads every LinkCounts page and the linking URLs of the top pages", async () => {
    const { f, calls } = fakeBing({ countPages: 2, perPage: 2 });
    const s = await createBingAdapter(f).fetchBacklinks!(config, secret, { delayMs: 0, budget: { maxTargets: 10 } });
    expect(calls.filter((c) => c.pathname.endsWith("GetLinkCounts")).map((c) => c.searchParams.get("page"))).toEqual(["0", "1"]);
    // 10 + 11 + 20 + 21
    expect(s).toMatchObject({ inboundLinks: 62, linkedPages: 4, sampledTargets: 4, referringDomains: 2, complete: true });
    const first = calls.find((c) => c.pathname.endsWith("GetUrlLinks"))!;
    expect(first.searchParams.get("siteUrl")).toBe("https://example.com/");
    expect(first.searchParams.get("link")).toBe("https://example.com/p1-1");
    expect(first.searchParams.get("apikey")).toBe("BINGKEY");
  });

  it("respects the page caps and the request budget, and reports the result as incomplete", async () => {
    const { f, calls } = fakeBing({ countPages: 50, perPage: 3, linksTotalPages: 9 });
    const s = await createBingAdapter(f).fetchBacklinks!(config, secret, { delayMs: 0, budget: { maxCountPages: 3, maxTargets: 2, maxLinkPagesPerTarget: 2, maxRequests: 6 } });
    expect(calls.filter((c) => c.pathname.endsWith("GetLinkCounts"))).toHaveLength(3);
    expect(calls).toHaveLength(6);
    expect(s).toMatchObject({ linkedPages: 9, sampledTargets: 2, complete: false });
  });

  it("stops at the time budget", async () => {
    const { f, calls } = fakeBing({ countPages: 5 });
    let t = 0;
    const s = await createBingAdapter(f).fetchBacklinks!(config, secret, { delayMs: 0, clock: () => (t += 1000), budget: { deadlineMs: 2500 } });
    expect(calls.length).toBeLessThanOrEqual(2);
    expect(s?.complete).toBe(false);
  });

  it("keeps only pages under the product prefix and returns null when none remain", async () => {
    const { f } = fakeBing({ countPages: 1 });
    expect(await createBingAdapter(f).fetchBacklinks!(config, secret, { delayMs: 0, pagePrefix: "https://example.com/other/" })).toBeNull();
    const empty = (async () => Response.json({ d: { Links: [], TotalPages: 0 } })) as typeof fetch;
    expect(await createBingAdapter(empty).fetchBacklinks!(config, secret, { delayMs: 0 })).toBeNull();
  });

  it("auth failures throw (401), other GetUrlLinks failures only mark the result incomplete", async () => {
    const denied = fakeBing({ countPages: 1, status: { GetLinkCounts: 401 } });
    await expect(createBingAdapter(denied.f).fetchBacklinks!(config, secret, { delayMs: 0 })).rejects.toThrow(/bing-webmaster HTTP 401/);
    const deniedLinks = fakeBing({ countPages: 1, status: { GetUrlLinks: 403 } });
    await expect(createBingAdapter(deniedLinks.f).fetchBacklinks!(config, secret, { delayMs: 0 })).rejects.toThrow(/HTTP 403/);
    const flaky = fakeBing({ countPages: 1, status: { GetUrlLinks: 500 } });
    expect(await createBingAdapter(flaky.f).fetchBacklinks!(config, secret, { delayMs: 0 })).toMatchObject({ inboundLinks: 21, referringDomains: null, complete: false });
  });
});

describe("backlink metrics and the score line", () => {
  it("writes inbound_links always and referring_domains only when measured", () => {
    expect(backlinkMetrics({ inboundLinks: 7, linkedPages: 2, referringDomains: 3, sampledTargets: 2, complete: true }, "2026-10-01")).toEqual([
      { metric: "inbound_links", day: "2026-10-01", value: 7 },
      { metric: "referring_domains", day: "2026-10-01", value: 3 },
    ]);
    expect(backlinkMetrics({ inboundLinks: 7, linkedPages: 2, referringDomains: null, sampledTargets: 0, complete: false }, "2026-10-01").map((m) => m.metric)).toEqual(["inbound_links"]);
  });

  const base: ScoreInput = {
    completeness: 0,
    audit: null,
    pages: { planned: 0, published: 0, productPagePublished: false, answerPagesPublished: 0, comparisonPlanned: 0, comparisonPublished: 0 },
    authority: { verifiedProofs: 0, sources: 0, referringDomains: null, ai: { providerConfigured: false, tests90d: 0, testsMentioning90d: 0 } },
    queries: { active: 0, weightedCovered: 0, weightedTotal: 0 },
    conversion: { conversionUrls: 0, ctaEvents30d: 0, pricingPlans: 0, hasTrialOrDemo: false },
    measurement: { searchConsole: false, analytics: false, eventsReceived30d: false, revenueSource: false },
  };
  const refLine = (i: ScoreInput) => computeBeaconScore(i).components.find((c) => c.key === "authority")!.lines.find((l) => l.label === "Referring domains")!;

  it("not connected, connected without data, and measured are three distinct states", () => {
    expect(refLine(base)).toMatchObject({ measurable: false, reason: "Not measured: connect Bing Webmaster Tools (backlink data).", fix: "Connect Bing Webmaster Tools for backlink data." });
    const noData = refLine({ ...base, measurement: { ...base.measurement, bingWebmaster: true } });
    expect(noData).toMatchObject({ measurable: false, earned: 0, reason: "Not measured yet: Bing Webmaster Tools has returned no link data for this site." });
    expect(noData.fix).toBeUndefined();
    const measured = refLine({ ...base, measurement: { ...base.measurement, bingWebmaster: true }, authority: { ...base.authority, referringDomains: 9, backlinks: { source: "Bing Webmaster Tools", asOf: "2026-10-01", inboundLinks: 120 } } });
    // 2 x log10(10) = 2 of 4
    expect(measured).toMatchObject({ measurable: true, earned: 2, max: 4, reason: "Bing Webmaster Tools: 9 referring domains as of 2026-10-01 (sampled from the most-linked pages), 120 inbound links." });
  });

  it("the measured explanation translates to French through the runtime templates", () => {
    const t = makeT(FR);
    expect(t("Bing Webmaster Tools: 9 referring domains as of 2026-10-01 (sampled from the most-linked pages), 120 inbound links.")).toBe(
      "Bing Webmaster Tools : 9 domaines référents au 2026-10-01 (échantillon des pages les plus liées), 120 liens entrants.",
    );
    expect(t("Bing Webmaster Tools: 9 referring domains as of 2026-10-01 (sampled from the most-linked pages).")).toBe("Bing Webmaster Tools : 9 domaines référents au 2026-10-01 (échantillon des pages les plus liées).");
    expect(t("Not measured yet: Bing Webmaster Tools has returned no link data for this site.")).toMatch(/^Pas encore mesuré/);
  });
});
