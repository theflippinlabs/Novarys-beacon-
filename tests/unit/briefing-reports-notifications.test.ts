import { describe, expect, it } from "vitest";
import { briefingLines, deltaPct, greetingKey, lostPages, rankTopActions, type ActionCandidate, type BriefingSnapshot } from "@/core/briefing/briefing";
import {
  changePct,
  csvCell,
  moneyMetrics,
  observedMetric,
  REPORT_ITEM_TEMPLATES,
  REPORT_METRIC_LABELS,
  reportToCsv,
  reportToMarkdown,
  riskItems,
  SECTION_TITLES,
  type ReportPayload,
} from "@/core/reports/report";
import {
  conversionAnomaly,
  DEFAULT_THRESHOLDS,
  enteredBand,
  freshSignals,
  ITEM_TEMPLATES,
  KIND_LABELS,
  KIND_TITLES,
  mergeDigest,
  parseThresholds,
  positionBand,
  signWebhook,
  trafficDrop,
  verifyWebhook,
  type Signal,
} from "@/core/notifications/notifications";
import { makeT } from "@/i18n/core";
import { FR } from "@/i18n/fr";

const LINKS = { search: "/s", gaps: "/g", citations: "/c", drafts: "/d", conversions: "/conv", revenue: "/rev", connect: "/connect", tracking: "/track" };

function snap(over: Partial<BriefingSnapshot> = {}): BriefingSnapshot {
  return {
    version: 1,
    at: "2026-09-30T06:00:00Z",
    search: { state: "OK", provider: "GOOGLE_SEARCH_CONSOLE", lastDay: "2026-09-28", windowStart: "2026-09-22", clicks: 100, impressions: 2000, top10: ["p::a", "p::b"], pages: { "/x": 100, "/y": 40 }, pagesCapped: false, queryRefs: {} },
    gaps: { ids: ["g1"], refs: { g1: { title: "Gap 1", href: "/opportunities/g1" } } },
    citations: { state: "OK", ids: ["c1"], refs: {} },
    drafts: { count: 2, ids: ["d1", "d2"] },
    signups: { state: "OK", model: "LAST_TOUCH", count: 3 },
    mrr: { state: "OK", model: "LAST_TOUCH", byCurrency: [{ currency: "EUR", cents: 5000 }] },
    ...over,
  };
}

describe("briefing deltas against the previous stored briefing", () => {
  it("computes relative deltas and treats a previous 0 as not comparable", () => {
    expect(deltaPct(120, 100)).toBeCloseTo(0.2);
    expect(deltaPct(5, 0)).toBeNull();
    expect(deltaPct(5, null)).toBeNull();
  });

  it("records a baseline on the first briefing (no invented changes)", () => {
    const lines = briefingLines(null, snap(), LINKS);
    const by = Object.fromEntries(lines.map((l) => [l.key, l]));
    expect(by.CLICKS.state).toBe("OK");
    expect(by.CLICKS.prev).toBeNull();
    expect(by.ENTERED_TOP10.state).toBe("BASELINE");
    expect(by.NEW_GAPS.state).toBe("BASELINE");
    expect(by.NEW_CITATIONS.state).toBe("BASELINE");
  });

  it("counts new queries in 4 to 10, lost pages, new gaps and citations against the previous snapshot", () => {
    const prev = snap();
    const cur = snap({
      at: "2026-10-01T06:00:00Z",
      search: { ...prev.search, lastDay: "2026-09-29", clicks: 150, top10: ["p::a", "p::c"], pages: { "/x": 30, "/y": 40 }, queryRefs: { "p::c": { title: "query c", href: "/queries/search?product=p" } } },
      gaps: { ids: ["g1", "g2"], refs: { g2: { title: "Gap 2", href: "/opportunities/g2" } } },
      citations: { state: "OK", ids: ["c1", "c2", "c3"], refs: {} },
      drafts: { count: 1, ids: ["d1"] },
    });
    const by = Object.fromEntries(briefingLines(prev, cur, LINKS).map((l) => [l.key, l]));
    expect(by.CLICKS.deltaPct).toBeCloseTo(0.5);
    expect(by.ENTERED_TOP10.now).toBe(1);
    expect(by.ENTERED_TOP10.items).toEqual([{ label: "query c", href: "/queries/search?product=p" }]);
    expect(by.LOST_PAGES.now).toBe(1);
    expect(by.LOST_PAGES.items?.[0]).toMatchObject({ label: "/x", detail: { now: 30, prev: 100 } });
    expect(by.NEW_GAPS.now).toBe(1);
    expect(by.NEW_CITATIONS.now).toBe(2);
    expect(by.DRAFTS).toMatchObject({ now: 1, prev: 2 });
    expect(by.MRR_ORGANIC.money).toEqual([{ currency: "EUR", cents: 5000, prev: 5000 }]);
  });

  it("never turns an unconnected source into 0", () => {
    const cur = snap({
      search: { state: "NOT_CONNECTED", provider: null, lastDay: null, windowStart: null, clicks: 0, impressions: 0, top10: [], pages: {}, pagesCapped: false, queryRefs: {} },
      citations: { state: "NO_DATA_YET", ids: [], refs: {} },
      signups: { state: "NOT_CONNECTED", model: "LAST_TOUCH", count: 0 },
      mrr: { state: "NO_DATA_YET", model: "LAST_TOUCH", byCurrency: [] },
    });
    const lines = briefingLines(snap(), cur, LINKS);
    for (const k of ["CLICKS", "IMPRESSIONS", "ENTERED_TOP10", "LOST_PAGES", "SIGNUPS_ORGANIC"]) {
      const l = lines.find((x) => x.key === k)!;
      expect(l.state).toBe("NOT_CONNECTED");
      expect(l.now).toBeNull();
    }
    expect(lines.find((x) => x.key === "NEW_CITATIONS")!.state).toBe("NO_DATA_YET");
    expect(lines.find((x) => x.key === "MRR_ORGANIC")!.now).toBeNull();
    expect(lines.find((x) => x.key === "CLICKS")!.href).toBe("/connect");
  });

  it("flags search lines when no new search data arrived since the previous briefing", () => {
    const lines = briefingLines(snap(), snap({ at: "2026-10-01T06:00:00Z" }), LINKS);
    expect(lines.find((l) => l.key === "CLICKS")!.state).toBe("NO_NEW_DATA");
  });

  it("does not count pages missing from a capped map as lost", () => {
    expect(lostPages({ "/a": 100 }, {}, true)).toEqual([]);
    expect(lostPages({ "/a": 100 }, {}, false)).toEqual([{ page: "/a", now: 0, prev: 100 }]);
    expect(lostPages({ "/a": 10 }, {}, false)).toEqual([]);
    expect(lostPages({ "/a": 100 }, { "/a": 60 }, false)).toEqual([]);
  });

  it("greets by time of day", () => {
    expect(greetingKey(8)).toBe("Good morning");
    expect(greetingKey(14)).toBe("Good afternoon");
    expect(greetingKey(21)).toBe("Good evening");
    expect(greetingKey(2)).toBe("Good evening");
  });
});

describe("top 5 actions", () => {
  const c = (x: Partial<ActionCandidate> & Pick<ActionCandidate, "kind" | "id">): ActionCandidate => ({ href: `/${x.id}`, subject: x.id, ...x });
  it("ranks blocking issues first, then high-potential opportunities, drafts, other opportunities; caps at 5", () => {
    const ranked = rankTopActions([
      c({ kind: "OPPORTUNITY", id: "o-low", potential: "MEDIUM", priority: 99 }),
      c({ kind: "DRAFT", id: "d1", ageDays: 3 }),
      c({ kind: "OPPORTUNITY", id: "o-high", potential: "HIGH", priority: 10 }),
      c({ kind: "OPPORTUNITY", id: "o-high2", potential: "HIGH", priority: 20 }),
      c({ kind: "INTEGRATION", id: "i-err", status: "ERROR" }),
      c({ kind: "INTEGRATION", id: "i-exp", status: "EXPIRED" }),
      c({ kind: "BLOCKING_SEO", id: "a1", count: 2 }),
      c({ kind: "FACT_CHECK", id: "f1", count: 1 }),
    ]);
    expect(ranked.map((r) => r.id)).toEqual(["a1", "i-exp", "i-err", "f1", "o-high2"]);
    expect(ranked.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5]);
  });
  it("is deterministic and de-duplicates", () => {
    const list = [c({ kind: "DRAFT", id: "b", ageDays: 1 }), c({ kind: "DRAFT", id: "a", ageDays: 1 }), c({ kind: "DRAFT", id: "a", ageDays: 1 })];
    expect(rankTopActions(list).map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("notifications math", () => {
  it("detects a week-over-week traffic drop only above the threshold and minimum volume", () => {
    const t = DEFAULT_THRESHOLDS.TRAFFIC_DROP;
    expect(trafficDrop(60, 100, t)).toBeCloseTo(0.4);
    expect(trafficDrop(80, 100, t)).toBeNull();
    expect(trafficDrop(0, 10, t)).toBeNull();
  });

  it("classifies position bands and entries", () => {
    expect(positionBand(2.2)).toBe("TOP_3");
    expect(positionBand(7)).toBe("TOP_10");
    expect(positionBand(14)).toBeNull();
    expect(enteredBand(7, 14, "BOTH")).toBe("TOP_10");
    expect(enteredBand(7, null, "BOTH")).toBe("TOP_10");
    expect(enteredBand(2, 6, "BOTH")).toBe("TOP_3");
    expect(enteredBand(7, 2, "BOTH")).toBeNull();
    expect(enteredBand(7, 8, "BOTH")).toBeNull();
    expect(enteredBand(7, 20, "TOP_3")).toBeNull();
  });

  it("flags conversion anomalies by z-score with a minimum volume and a Poisson floor", () => {
    const flat = Array.from({ length: 28 }, () => 10);
    const t = DEFAULT_THRESHOLDS.CONVERSION_ANOMALY;
    expect(conversionAnomaly(flat, 11, t)).toBeNull();
    const low = conversionAnomaly(flat, 0, t);
    expect(low?.direction).toBe("DOWN");
    expect(low!.z).toBeLessThan(-3);
    expect(conversionAnomaly(flat, 30, t)?.direction).toBe("UP");
    expect(conversionAnomaly(Array.from({ length: 28 }, () => 1), 20, t)).toBeNull();
    expect(conversionAnomaly(flat.slice(0, 10), 0, t)).toBeNull();
  });

  it("parses thresholds with defaults and bounds", () => {
    expect(parseThresholds({})).toEqual(DEFAULT_THRESHOLDS);
    const p = parseThresholds({ TRAFFIC_DROP: { dropPct: 500, minClicks: "40" }, QUERY_ENTERED_TOP: { range: "TOP_3" } });
    expect(p.TRAFFIC_DROP).toEqual({ dropPct: 95, minClicks: 40 });
    expect(p.QUERY_ENTERED_TOP.range).toBe("TOP_3");
  });

  it("drops already-notified signals and merges a day's digest", () => {
    const s = (fp: string): Signal => ({ kind: "CRAWL_FAILED", severity: "MEDIUM", item: { fp, key: "The crawl of {product} failed", vars: { product: fp }, href: `/a/${fp}` } });
    const fresh = freshSignals([s("a"), s("b"), s("b")], new Set(["a"]));
    expect(fresh.map((x) => x.item.fp)).toEqual(["b"]);
    const d1 = mergeDigest(null, [s("b").item]);
    const d2 = mergeDigest(d1, [s("b").item, s("c").item]);
    expect(d2.n).toBe(2);
    expect(d2.signals).toEqual(["b", "c"]);
  });

  it("signs webhooks with HMAC-SHA256 over timestamp.body and verifies within tolerance", () => {
    const body = JSON.stringify({ a: 1 });
    const header = signWebhook("s3cret-s3cret-s3cret", 1_700_000_000, body);
    expect(header).toMatch(/^t=1700000000,v1=[0-9a-f]{64}$/);
    expect(verifyWebhook("s3cret-s3cret-s3cret", header, body, 1_700_000_100)).toBe(true);
    expect(verifyWebhook("s3cret-s3cret-s3cret", header, `${body} `, 1_700_000_100)).toBe(false);
    expect(verifyWebhook("other-secret-value!!", header, body, 1_700_000_100)).toBe(false);
    expect(verifyWebhook("s3cret-s3cret-s3cret", header, body, 1_700_001_000)).toBe(false);
  });
});

const payload: ReportPayload = {
  version: 1,
  period: { start: "2026-09-21", end: "2026-09-27" },
  previous: { start: "2026-09-14", end: "2026-09-20" },
  generatedAt: "2026-09-28T07:00:00Z",
  scopes: [
    {
      productId: null,
      name: "Organisation total",
      slug: null,
      sections: [
        {
          key: "DISCOVERY",
          metrics: [
            { key: "clicks", label: "Organic clicks", state: "OK", unit: "count", now: 120, prev: 100 },
            { key: "impressions", label: "Organic impressions", state: "NOT_CONNECTED", unit: "count", now: null, prev: null },
          ],
          items: [],
        },
        { key: "REVENUE", metrics: moneyMetrics("revenue", "Revenue in period", { state: "OK", byCurrency: [{ currency: "EUR", now: 12345, prev: 10000 }, { currency: "USD", now: 500, prev: 0 }] }), items: [] },
        { key: "AI_OBSERVATIONS", metrics: [observedMetric("ai_mentions", "Sampled answers mentioning a product", "OK", { x: 3, y: 10 }, { x: 1, y: 8 })], items: [] },
        { key: "OPPORTUNITIES", metrics: [], items: [{ label: "{title} (priority {priority})", vars: { title: '=HYPERLINK("x"), "quoted"', priority: 12.5 } }] },
      ],
    },
  ],
};

describe("report section builders and exports", () => {
  it("keeps currencies separate and unmeasured states explicit", () => {
    const m = moneyMetrics("rev", "Revenue in period", { state: "OK", byCurrency: [{ currency: "EUR", now: 1, prev: 2 }, { currency: "USD", now: 3, prev: null }] });
    expect(m.map((x) => x.key)).toEqual(["rev:EUR", "rev:USD"]);
    expect(moneyMetrics("rev", "Revenue in period", { state: "NOT_CONNECTED" })[0]).toMatchObject({ state: "NOT_CONNECTED", now: null });
    expect(moneyMetrics("rev", "Revenue in period", { state: "OK", byCurrency: [] })[0].state).toBe("NO_DATA_YET");
    expect(observedMetric("x", "y", "OK", { x: 0, y: 0 }, { x: 0, y: 0 }).state).toBe("NO_DATA_YET");
    expect(observedMetric("x", "y", "NOT_CONNECTED", { x: 1, y: 2 }, { x: 0, y: 0 })).toMatchObject({ state: "NOT_CONNECTED", now: null });
    expect(changePct(120, 100)).toBeCloseTo(0.2);
    expect(changePct(5, 0)).toBeNull();
  });

  it("builds risks from measured facts only", () => {
    const r = riskItems({ integrations: [{ provider: "STRIPE", status: "EXPIRED" }], criticalIssues: 2, clicks: { state: "OK", now: 50, prev: 100 }, failedJobs: 0, blockedDrafts: 0 });
    expect(r.map((x) => x.label)).toEqual(["{provider} integration is {status}", "Open critical SEO issues: {n}", "Organic clicks fell {pct}% vs the previous period"]);
    expect(riskItems({ integrations: [], criticalIssues: 0, clicks: { state: "NOT_CONNECTED", now: null, prev: null }, failedJobs: 0, blockedDrafts: 0 })[0].label).toBe("Not measured: connect {source}");
    expect(riskItems({ integrations: [], criticalIssues: 0, clicks: { state: "OK", now: 100, prev: 100 }, failedJobs: 0, blockedDrafts: 0 })[0].label).toBe("No risk detected in measured data");
  });

  it("escapes CSV cells and neutralises formulas", () => {
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell('a,"b"')).toBe('"a,""b"""');
    expect(csvCell("=1+2")).toBe(`"'=1+2"`);
    expect(csvCell(null)).toBe("");
    expect(csvCell(-3)).toBe("-3");
  });

  it("exports CSV with states, per-currency rows and no fake zeros", () => {
    const csv = reportToCsv(payload, makeT(null));
    const rows = csv.trim().split("\r\n");
    expect(rows[0]).toBe("Scope,Section,Metric,State,Currency,Current period,Previous period,Change %,Sample size");
    expect(rows).toContain("Organisation total,Discovery,Organic clicks,Measured,,120,100,20,");
    expect(rows).toContain("Organisation total,Discovery,Organic impressions,Not connected,,,,,");
    expect(rows).toContain("Organisation total,Revenue,Revenue in period,Measured,EUR,123.45,100,23.5,");
    expect(rows).toContain("Organisation total,Revenue,Revenue in period,Measured,USD,5,0,,");
    expect(rows).toContain("Organisation total,AI observations,Sampled answers mentioning a product,Measured,,3,1,200,10");
    expect(csv).toContain(`"'=HYPERLINK(""x""), ""quoted"" (priority 12.5)"`);
  });

  it("exports Markdown in French with escaped cells", () => {
    const md = reportToMarkdown(payload, makeT(FR), "fr-FR");
    expect(md).toContain("# Rapport de direction hebdomadaire");
    expect(md).toContain("## Total de l’organisation");
    expect(md.replace(/[\u202f\u00a0]/g, " ")).toContain("| Clics organiques | 120 | 100 | +20 % |");
    expect(md).toContain("Non connecté");
    expect(md).toContain("observé dans 3 réponse(s) échantillonnée(s) sur 10");
  });
});

describe("French coverage of stored keys", () => {
  it("translates every section title, metric label, item template and notification text", () => {
    const keys = [...Object.values(SECTION_TITLES), ...REPORT_METRIC_LABELS, ...REPORT_ITEM_TEMPLATES, ...Object.values(KIND_LABELS), ...Object.values(KIND_TITLES), ...ITEM_TEMPLATES, "Test event from Beacon", "Not connected: set RESEND_API_KEY and BEACON_EMAIL_FROM"];
    expect(keys.filter((k) => FR[k] === undefined)).toEqual([]);
  });
});
