import { describe, expect, it } from "vitest";
import { analyzeAiResponse, mentionOffsets, snippetAround } from "@/core/visibility/ai-response";
import { analyzeGrowth, type MetricPair } from "@/core/autopilot/analyst";
import { prioritizeAttention, attentionPriority, type AttentionItem } from "@/core/command/attention";
import { escapeHtml, formatMoney, jaccard, normalizeQuery, shingles, slugify, textSimilarity, tokens } from "@/core/util/text";
import { can, canAssignRole, ForbiddenError, PERMISSIONS, ROLES } from "@/lib/auth/rbac";

describe("analyzeAiResponse", () => {
  const products = [{ id: "p1", name: "Iris", aliases: ["Iris OSINT"], domain: "https://iris.example/" }];
  const competitors = [
    { id: "c1", name: "Maltego" },
    { id: "c2", name: "SpiderFoot" },
  ];

  it("detects entities with positions by order of first appearance", () => {
    const r = analyzeAiResponse("Popular tools: Maltego, then SpiderFoot. Iris is newer. Maltego again.", [], products, competitors);
    expect(r.competitorsMentioned).toMatchObject([
      { competitorId: "c1", name: "Maltego", position: 1, offset: 15, offsets: [15, 56] },
      { competitorId: "c2", name: "SpiderFoot", position: 2, offset: 29 },
    ]);
    expect(r.productsMentioned).toMatchObject([{ productId: "p1", name: "Iris", position: 3, offset: 41 }]);
    expect(r.productsMentioned[0].snippet).toContain("Iris is newer");
    expect(r.position).toBe(3);
    expect(r.orgMentioned).toBe(true);
  });

  it("respects word boundaries (no 'Iris' inside 'Irish')", () => {
    const r = analyzeAiResponse("An Irish company makes Maltego.", [], products, competitors);
    expect(r.productsMentioned).toEqual([]);
    expect(r.position).toBeNull();
    expect(r.orgMentioned).toBe(false);
  });

  it("matches aliases and case-insensitively", () => {
    const r = analyzeAiResponse("Try IRIS OSINT for investigations.", [], products, []);
    expect(r.productsMentioned).toHaveLength(1);
  });

  it("detects own-domain citations including subdomains, and URLs in the text", () => {
    const r = analyzeAiResponse("See https://docs.iris.example/guide. Also (https://maltego.example/x).", ["https://other.example/a"], products, competitors);
    expect(r.citations).toEqual(["https://other.example/a", "https://docs.iris.example/guide", "https://maltego.example/x"]);
    expect(r.ownDomainCited).toBe(true);
    expect(analyzeAiResponse("text", ["https://notiris.example/", "not a url"], products, []).ownDomainCited).toBe(false);
  });

  it("keeps a snippet of about 200 characters around the first mention, cut on word boundaries", () => {
    const filler = "lorem ipsum dolor sit amet ".repeat(20);
    const text = `${filler}Maltego is a link analysis tool. ${filler}`;
    const r = analyzeAiResponse(text, [], products, competitors);
    const m = r.competitorsMentioned[0];
    expect(m.offset).toBe(filler.length);
    expect(m.snippet!.length).toBeLessThanOrEqual(205);
    expect(m.snippet).toMatch(/^….*Maltego is a link analysis tool\..*…$/);
    expect(snippetAround("short Maltego text", 6, 7)).toBe("short Maltego text");
    expect(mentionOffsets("ACME and acme.io and acmeish", ["Acme"])).toEqual([0, 9]);
  });

  it("uses org names for orgMentioned when no product is mentioned", () => {
    expect(analyzeAiResponse("Novarys builds tools.", [], products, [], ["Novarys"]).orgMentioned).toBe(true);
  });
});

describe("analyzeGrowth", () => {
  const m = (over: Partial<MetricPair>): MetricPair => ({ key: "k", label: "Clicks", now: 100, prev: 100, source: "gsc", ...over });
  const base = { events: [], opportunities: [], openCriticalIssues: [], connected: ["gsc"], missing: ["ga4"] };

  it("labels low-volume metrics as INSUFFICIENT_DATA", () => {
    const r = analyzeGrowth({ ...base, metrics: [m({ now: 10, prev: 2 }), m({ label: "Zero", now: 0, prev: 0 })] });
    expect(r.whyItMayHaveHappened).toHaveLength(1);
    expect(r.whyItMayHaveHappened[0]).toMatchObject({ evidence: "INSUFFICIENT_DATA", relatedEvents: [] });
    expect(r.whyItMayHaveHappened[0].observation).toContain("volume too low");
  });

  it("reports significant changes with coinciding events as CORRELATION, never causation", () => {
    const r = analyzeGrowth({
      ...base,
      metrics: [m({ now: 150, prev: 100 }), m({ label: "Signups", now: 105, prev: 100 })],
      events: [{ kind: "PAGE_PUBLISHED", label: "Published /acme", at: "2026-02-03T10:00:00Z" }],
    });
    expect(r.whyItMayHaveHappened).toEqual([{ observation: "Clicks rose 50% (100 → 150).", relatedEvents: ["Published /acme (2026-02-03)"], evidence: "CORRELATION" }]);
    expect(JSON.stringify(r).toLowerCase()).not.toMatch(/caused|causation/);
    expect(r.disclaimer).toMatch(/correlations, not proven causes/);
    expect(r.whatHappened.map((w) => w.direction)).toEqual(["up", "up"]);
  });

  it("without events a significant change is INSUFFICIENT_DATA", () => {
    const r = analyzeGrowth({ ...base, metrics: [m({ now: 50, prev: 100 })] });
    expect(r.whyItMayHaveHappened[0]).toMatchObject({ evidence: "INSUFFICIENT_DATA", observation: "Clicks fell 50% (100 → 50)." });
    expect(r.whatHappened[0]).toMatchObject({ change: -0.5, direction: "down" });
  });

  it("computes directions including flat and new-from-zero", () => {
    const r = analyzeGrowth({ ...base, metrics: [m({ now: 101, prev: 100 }), m({ now: 5, prev: 0 }), m({ now: 0, prev: 0 })] });
    expect(r.whatHappened.map((w) => [w.direction, w.change])).toEqual([
      ["flat", 0.01],
      ["up", null],
      ["flat", 0],
    ]);
  });

  it("recommended content actions require approval; critical issues come first; experiments derive from opportunities", () => {
    const r = analyzeGrowth({
      ...base,
      metrics: [],
      opportunities: [
        { title: "Cover x", potential: "HIGH", priorityScore: 20, type: "CONTENT_GAP" },
        { title: "CTR y", potential: "MEDIUM", priorityScore: 9, type: "LOW_CTR" },
        { title: "Complete graph", potential: "HIGH", priorityScore: 30, type: "ENTITY_COMPLETENESS" },
      ],
      openCriticalIssues: [{ rule: "http.error", count: 2 }],
    });
    expect(r.recommendedActions[0]).toEqual({ title: "Fix critical issue: http.error", body: "2 affected page(s).", kind: "TECHNICAL", requiresApproval: true });
    expect(r.recommendedActions.find((a) => a.kind === "CONTENT_GAP")?.requiresApproval).toBe(true);
    expect(r.recommendedActions.find((a) => a.kind === "LOW_CTR")?.requiresApproval).toBe(true);
    expect(r.opportunities.map((o) => o.priority)).toEqual([30, 20, 9]);
    expect(r.contentToCreate).toEqual(["Cover x"]);
    expect(r.technicalIssues).toEqual(["http.error (2)"]);
    expect(r.experiments.map((e) => e.primaryMetric)).toEqual(["Search CTR"]);
    expect(r.dataCoverage).toEqual({ connected: ["gsc"], missing: ["ga4"] });
    expect(r.disclaimer.length).toBeGreaterThan(0);
  });
});

describe("prioritizeAttention", () => {
  const item = (key: string, over: Partial<AttentionItem>): AttentionItem => ({ key, title: key, detail: "", href: "/", count: 1, impact: 3, confidence: 3, effort: 3, urgency: 3, ...over });
  it("drops zero-count items and sorts by impact × confidence × urgency ÷ effort", () => {
    const out = prioritizeAttention([item("a", {}), item("b", { count: 0, impact: 5 }), item("c", { impact: 5, effort: 1 }), item("d", { effort: 7 })]);
    expect(out.map((i) => i.key)).toEqual(["c", "a", "d"]);
    expect(out[0].priority).toBe(45);
    expect(out[2].priority).toBe(3.9);
    expect(attentionPriority({ impact: 2, confidence: 2, urgency: 2, effort: 4 })).toBe(2);
  });
});

describe("text utils", () => {
  it("slugify", () => {
    expect(slugify("  Héllo Wörld & Co.  ")).toBe("hello-world-and-co");
    expect(slugify("---")).toBe("");
    expect(slugify("a".repeat(100))).toHaveLength(80);
  });
  it("normalizeQuery / tokens", () => {
    expect(normalizeQuery('  What  is "Acme"?! ')).toBe("what is acme");
    expect(normalizeQuery("ＡＣＭＥ")).toBe("acme");
    expect(tokens("What is the best C++ tool for you?")).toEqual(["c++", "tool"]);
    expect(tokens("what is a tool", { keepStop: true })).toEqual(["what", "is", "tool"]);
  });
  it("jaccard / shingles / textSimilarity", () => {
    expect(jaccard(new Set(), new Set())).toBe(0);
    expect(jaccard(new Set([1, 2]), new Set([2, 3]))).toBeCloseTo(1 / 3);
    expect(jaccard(new Set(["a"]), new Set(["a"]))).toBe(1);
    expect([...shingles("one two")]).toEqual(["one two"]);
    expect(shingles("one two three four").size).toBe(2);
    expect(textSimilarity("the quick brown fox jumps", "the quick brown fox jumps")).toBe(1);
    expect(textSimilarity("the quick brown fox jumps", "entirely different words here now")).toBe(0);
  });
  it("escapeHtml", () => {
    expect(escapeHtml(`<a href="x">Tom & Jerry's</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;Tom &amp; Jerry&#39;s&lt;/a&gt;");
  });
  it("formatMoney", () => {
    expect(formatMoney(4900, "EUR")).toBe("€49");
    expect(formatMoney(4950, "EUR")).toBe("€49.50");
    expect(formatMoney(4950, null)).toBe("49.50 (currency unknown)");
    expect(formatMoney(123456, "USD")).toBe("US$1,234.56");
    expect(formatMoney(0, "GBP")).toBe("£0");
  });
});

describe("rbac", () => {
  it("can() follows the role matrix", () => {
    expect(can("VIEWER", "read")).toBe(true);
    expect(can("VIEWER", "query:write")).toBe(false);
    expect(can("ANALYST", "job:run")).toBe(true);
    expect(can("ANALYST", "content:write")).toBe(false);
    expect(can("EDITOR", "content:write")).toBe(true);
    expect(can("EDITOR", "content:approve")).toBe(false);
    expect(can("ADMIN", "content:approve")).toBe(true);
    expect(can("ADMIN", "member:manage")).toBe(true);
    for (const p of PERMISSIONS) expect(can("OWNER", p)).toBe(true);
    expect(can("NOPE" as never, "read")).toBe(false);
  });
  it("roles are strictly nested", () => {
    for (let i = 1; i < ROLES.length; i++) for (const p of PERMISSIONS) if (can(ROLES[i], p)) expect(can(ROLES[i - 1], p)).toBe(true);
  });
  it("canAssignRole only allows strictly lower roles for managers; owners assign any", () => {
    expect(canAssignRole("OWNER", "OWNER")).toBe(true);
    expect(canAssignRole("ADMIN", "EDITOR")).toBe(true);
    expect(canAssignRole("ADMIN", "ADMIN")).toBe(false);
    expect(canAssignRole("ADMIN", "OWNER")).toBe(false);
    expect(canAssignRole("EDITOR", "VIEWER")).toBe(false);
    expect(new ForbiddenError("x").message).toBe("Missing permission: x");
  });
});
