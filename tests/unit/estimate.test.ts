import { describe, expect, it } from "vitest";
import {
  betaCdf,
  betaDraws,
  betaPosterior,
  betaQuantile,
  bootstrapMeans,
  DRAWS,
  hashSeed,
  interval,
  isotonicDecreasing,
  logGamma,
  mulberry32,
  quantile,
  wilson,
} from "@/core/estimate/stats";
import { emptyContext, MISSING, ORG_SCOPE, type EstimationContext } from "@/core/estimate/context";
import { estimateImpact, estimationPower } from "@/core/estimate/impact";
import { estimateTrafficPotential, fitCtrCurve } from "@/core/estimate/traffic";
import { estimateConversionRate, searchConversionModel } from "@/core/estimate/conversion";
import { estimateValuePerConversion } from "@/core/estimate/value";
import { estimateSuccessProbability } from "@/core/estimate/success";
import { estimateAiMentionGap, estimateAiMentionRate } from "@/core/estimate/ai";
import type { Estimate, ImpactEstimate } from "@/core/estimate/types";
import { translate } from "@/i18n/core";
import { FR } from "@/i18n/fr";

const P = "11111111-1111-4111-8111-111111111111";

/** A curve with 7 measured buckets, monotone already. */
const CURVE = [
  { bucket: "1", clicks: 3000, impressions: 10_000 },
  { bucket: "2", clicks: 1500, impressions: 10_000 },
  { bucket: "3", clicks: 1000, impressions: 10_000 },
  { bucket: "4-5", clicks: 600, impressions: 10_000 },
  { bucket: "6-10", clicks: 200, impressions: 10_000 },
  { bucket: "11-20", clicks: 50, impressions: 10_000 },
  { bucket: "21+", clicks: 10, impressions: 10_000 },
];

function fullContext(): EstimationContext {
  const ctx = emptyContext("org-test", "2026-10-01");
  ctx.search.connected = true;
  ctx.search.curve = CURVE.map((b) => ({ ...b }));
  ctx.search.queries = {
    q1: { productId: P, query: "tiktok moderation", clicks: 10, impressions: 1000, position: 8 },
    q2: { productId: P, query: "live chat filter", clicks: 5, impressions: 500, position: 15 },
    top: { productId: P, query: "brand", clicks: 300, impressions: 1000, position: 1.2 },
    zero: { productId: P, query: "nothing", clicks: 0, impressions: 0, position: null },
  };
  ctx.conversion.tracked = true;
  ctx.conversion.byScope[P] = { all: { visitors: 1000, converters: 50 }, byChannel: { ORGANIC_SEARCH: { visitors: 400, converters: 40 }, DIRECT: { visitors: 600, converters: 10 } } };
  ctx.conversion.byScope[ORG_SCOPE] = { all: { visitors: 1200, converters: 60 }, byChannel: {} };
  ctx.value.connected = true;
  ctx.value.byScope[P] = { converters: 20, byCurrency: { EUR: [1000, 1000, 2000, 2000, 4000, 4000], USD: [500, 700] } };
  ctx.value.byScope[ORG_SCOPE] = { converters: 20, byCurrency: { EUR: [1000, 1000, 2000, 2000, 4000, 4000] } };
  ctx.learning = { CONTENT_GAP: { improved: 8, noChange: 1, declined: 1, insufficient: 4 }, LOW_CTR: { improved: 1, noChange: 1, declined: 0 } };
  ctx.ai.tested = true;
  ctx.ai.byScope[P] = { samples: 20, mentioned: 5, competitors: [{ id: "c1", name: "Rival", mentioned: 12 }, { id: "c2", name: "Other", mentioned: 3 }] };
  ctx.ai.byScope[ORG_SCOPE] = { samples: 20, mentioned: 5, competitors: [] };
  return ctx;
}

const est = (e: Estimate) => {
  if (e.state !== "ESTIMATED") throw new Error(`expected ESTIMATED, got ${e.state}: ${e.reason}`);
  return e;
};
const ne = (e: Estimate) => {
  if (e.state !== "NOT_ESTIMABLE") throw new Error(`expected NOT_ESTIMABLE for ${e.key}`);
  return e;
};

describe("estimate stats", () => {
  it("hashes with FNV-1a and draws deterministic uniforms (mulberry32)", () => {
    expect(hashSeed("")).toBe(0x811c9dc5);
    expect(hashSeed("a")).toBe(0xe40c292c);
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 10_000 }, () => a());
    expect(xs.slice(0, 5)).toEqual(Array.from({ length: 5 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    expect(Math.abs(xs.reduce((s, x) => s + x, 0) / xs.length - 0.5)).toBeLessThan(0.01);
    expect(mulberry32(43)()).not.toBe(mulberry32(42)());
  });

  it("computes log-gamma and the Beta CDF and quantiles at known values", () => {
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 10);
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 10);
    expect(betaCdf(0.5, 2, 3)).toBeCloseTo(11 / 16, 10);
    expect(betaCdf(0.3, 1, 1)).toBeCloseTo(0.3, 10);
    expect(betaQuantile(0.25, 2, 1)).toBeCloseTo(0.5, 8); // CDF x^2
    expect(betaQuantile(0.75, 1, 2)).toBeCloseTo(0.5, 8); // CDF 1 - (1 - x)^2
    expect(betaQuantile(0.5, 10, 10)).toBeCloseTo(0.5, 8);
    expect(betaQuantile(0.9, 1, 1)).toBeCloseTo(0.9, 8);
  });

  it("gives Beta posterior quantiles with a uniform prior", () => {
    const u = betaPosterior(0, 0);
    expect([u.a, u.b]).toEqual([1, 1]);
    expect(u.p10).toBeCloseTo(0.1, 8);
    expect(u.p50).toBeCloseTo(0.5, 8);
    expect(u.p90).toBeCloseTo(0.9, 8);
    const p = betaPosterior(1, 2); // Beta(2, 2): symmetric
    expect(p.p50).toBeCloseTo(0.5, 8);
    expect(p.p10 + p.p90).toBeCloseTo(1, 8);
    const q = betaPosterior(0, 1); // Beta(1, 2): p10 = 1 - sqrt(0.9)
    expect(q.p10).toBeCloseTo(1 - Math.sqrt(0.9), 8);
  });

  it("computes the Wilson interval (80%)", () => {
    const w = wilson(50, 100);
    expect(w.low).toBeCloseTo(0.43644, 4);
    expect(w.high).toBeCloseTo(0.56356, 4);
    expect(wilson(0, 10).low).toBe(0);
    const w95 = wilson(50, 100, 1.959964);
    expect(w95.low).toBeCloseTo(0.40383, 4);
  });

  it("computes empirical quantiles (type 7) and intervals", () => {
    expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(quantile([1, 2, 3, 4], 0.1)).toBeCloseTo(1.3, 10);
    expect(quantile([4, 1, 3, 2], 1)).toBe(4);
    expect(interval([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])).toEqual({ p10: 2, p50: 6, p90: 10 });
  });

  it("bootstraps the mean deterministically", () => {
    expect(Array.from(bootstrapMeans([5, 5, 5], "k", 50))).toEqual(Array(50).fill(5));
    const a = bootstrapMeans([0, 0, 10, 20], "seed");
    expect(a.length).toBe(DRAWS);
    expect(Array.from(a)).toEqual(Array.from(bootstrapMeans([0, 0, 10, 20], "seed")));
    expect(Math.abs(a.reduce((s, x) => s + x, 0) / a.length - 7.5)).toBeLessThan(0.3);
  });

  it("draws Beta variates around the right mean", () => {
    const d = betaDraws("beta", 9, 3);
    expect(Math.abs(d.reduce((s, x) => s + x, 0) / d.length - 0.75)).toBeLessThan(0.01);
    expect(Array.from(d.slice(0, 3))).toEqual(Array.from(betaDraws("beta", 9, 3).slice(0, 3)));
    const s = betaDraws("small", 0.5, 0.5, 500);
    expect(Array.from(s).every((x) => x > 0 && x < 1)).toBe(true);
  });

  it("fits a non-increasing isotonic regression (pool adjacent violators)", () => {
    isotonicDecreasing([0.3, 0.1, 0.2], [1, 1, 1]).forEach((v, i) => expect(v).toBeCloseTo([0.3, 0.15, 0.15][i], 12));
    isotonicDecreasing([0.1, 0.3], [1, 3]).forEach((v) => expect(v).toBeCloseTo(0.25, 12));
    expect(isotonicDecreasing([3, 2, 1], [1, 1, 1])).toEqual([3, 2, 1]);
  });
});

describe("traffic_potential", () => {
  it("fits the organisation's monotone CTR curve and estimates extra clicks at the target position", () => {
    const e = est(estimateTrafficPotential(fullContext(), { productId: P, queryIds: ["q1", "q2", "top", "zero"], targetPosition: 3 }));
    // CTR at position 3 ~ 1001/10002; q1: 1000 x 0.1 - 10, q2: 500 x 0.1 - 5, top is already above the target.
    expect(e.p50).toBeGreaterThan(130);
    expect(e.p50).toBeLessThan(140);
    expect(e.p10).toBeLessThan(e.p50);
    expect(e.p90).toBeGreaterThan(e.p50);
    expect(e.horizonDays).toBe(30);
    expect(e.confidence).toBe("HIGH");
    expect(e.inputs.find((i) => i.name === "Queries ranked below the target position")?.value).toBe(2);
    expect(e.inputs.find((i) => i.name === "CTR at the target position")?.source).toBe("ORG_HISTORY");
  });

  it("makes the curve monotone when a worse position has a higher CTR", () => {
    const fit = fitCtrCurve([
      { bucket: "1", clicks: 300, impressions: 1000 },
      { bucket: "2", clicks: 100, impressions: 1000 },
      { bucket: "3", clicks: 200, impressions: 1000 },
      { bucket: "4-5", clicks: 50, impressions: 1000 },
      { bucket: "6-10", clicks: 10, impressions: 1000 },
    ])!;
    expect(fit.buckets[1].fitted).toBeCloseTo(fit.buckets[2].fitted, 10);
    for (const draw of fit.draws.slice(0, 50)) for (let j = 1; j < draw.length; j++) expect(draw[j]).toBeLessThanOrEqual(draw[j - 1] + 1e-12);
  });

  it("is NOT_ESTIMABLE with the exact missing item", () => {
    const none = emptyContext("o");
    expect(ne(estimateTrafficPotential(none, { productId: P, queryIds: ["q1"] })).missing).toEqual([MISSING.search]);
    const ctx = fullContext();
    expect(ne(estimateTrafficPotential(ctx, { productId: P, queryIds: [] })).missing).toEqual([]);
    expect(ne(estimateTrafficPotential(ctx, { productId: P, queryIds: ["zero"] })).missing).toEqual([MISSING.queryData]);
    const four = fullContext();
    four.search.curve = CURVE.slice(0, 4);
    const e4 = ne(estimateTrafficPotential(four, { productId: P, queryIds: ["q1"] }));
    expect(e4.missing).toEqual([MISSING.curve]);
    expect(e4.reason).toContain("4 are measured");
    const thin = fullContext();
    thin.search.curve = CURVE.map((b) => (b.bucket === "3" ? { ...b, impressions: 99, clicks: 9 } : b));
    expect(ne(estimateTrafficPotential(thin, { productId: P, queryIds: ["q1"] })).missing).toEqual([MISSING.targetBucket]);
  });

  it("gives zero for queries already at or above the target position, and ignores other products' queries", () => {
    const ctx = fullContext();
    const e = est(estimateTrafficPotential(ctx, { productId: P, queryIds: ["top"] }));
    expect([e.p10, e.p50, e.p90]).toEqual([0, 0, 0]);
    ctx.search.queries.other = { productId: "22222222-2222-4222-8222-222222222222", query: "x", clicks: 0, impressions: 900, position: 9 };
    expect(ne(estimateTrafficPotential(ctx, { productId: P, queryIds: ["other"] })).missing).toEqual([MISSING.queryData]);
  });
});

describe("conversion_rate", () => {
  it("uses a Beta posterior on tracked visitors to signups", () => {
    const e = est(estimateConversionRate(fullContext(), P));
    const post = betaPosterior(50, 1000);
    expect(e.p50).toBeCloseTo(post.p50, 6);
    expect(e.p10).toBeCloseTo(post.p10, 6);
    expect(e.confidence).toBe("HIGH");
    expect(e.unit).toBe("ratio");
  });

  it("is NOT_ESTIMABLE under 50 visitors, naming the tracker when nothing is tracked", () => {
    const ctx = fullContext();
    ctx.conversion.byScope[P].all = { visitors: 49, converters: 5 };
    const e = ne(estimateConversionRate(ctx, P));
    expect(e.missing).toEqual([MISSING.visitors]);
    expect(e.reason).toContain("(49 measured)");
    expect(ne(estimateConversionRate(emptyContext("o"), null)).missing).toEqual([MISSING.tracker, MISSING.visitors]);
  });

  it("prefers the organic search channel and falls back to all channels, saying so", () => {
    const ctx = fullContext();
    const organic = est(searchConversionModel(ctx, P).estimate);
    expect(organic.p50).toBeCloseTo(betaPosterior(40, 400).p50, 6);
    expect(organic.inputs.find((i) => i.name === "Channel")?.value).toBe("ORGANIC_SEARCH");
    ctx.conversion.byScope[P].byChannel.ORGANIC_SEARCH = { visitors: 20, converters: 2 };
    const all = est(searchConversionModel(ctx, P).estimate);
    expect(all.p50).toBeCloseTo(betaPosterior(50, 1000).p50, 6);
    expect(all.inputs.find((i) => i.name === "Channel")?.value).toBe("All channels");
  });
});

describe("value_per_conversion", () => {
  it("estimates per currency, never mixing them, counting non-payers as 0", () => {
    const [eur, usd] = estimateValuePerConversion(fullContext(), P);
    const e = est(eur);
    expect(e.currency).toBe("EUR");
    expect(e.unit).toBe("money_minor");
    // Mean over 20 converters: 14000 / 20 = 700 minor units.
    expect(e.p50).toBeGreaterThan(550);
    expect(e.p50).toBeLessThan(850);
    expect(e.p10).toBeLessThan(e.p50);
    const u = ne(usd);
    expect(u.currency).toBe("USD");
    expect(u.missing).toEqual([MISSING.payers]);
    expect(u.reason).toContain("in USD (2 measured)");
  });

  it("is NOT_ESTIMABLE without a revenue source", () => {
    const [e] = estimateValuePerConversion(emptyContext("o"), P);
    expect(ne(e).missing).toEqual([MISSING.revenue]);
  });
});

describe("success_probability", () => {
  it("uses autopilot learning tallies, excluding insufficient outcomes", () => {
    const e = est(estimateSuccessProbability(fullContext(), "CONTENT_GAP"));
    expect(e.p50).toBeCloseTo(betaQuantile(0.5, 9, 3), 6);
    expect(e.confidence).toBe("MEDIUM");
    expect(e.inputs.find((i) => i.name === "Measured outcomes")?.value).toBe(10);
  });

  it("is NOT_ESTIMABLE under 3 measured outcomes", () => {
    expect(ne(estimateSuccessProbability(fullContext(), "LOW_CTR")).missing).toEqual([MISSING.outcomes]);
    expect(ne(estimateSuccessProbability(fullContext(), "UNKNOWN")).reason).toContain("(0 so far)");
  });
});

describe("ai_mention_rate", () => {
  it("estimates the share of sampled answers that mention the product (Wilson) and the gap to the best competitor", () => {
    const e = est(estimateAiMentionRate(fullContext(), P));
    expect(e.p50).toBe(0.25);
    const w = wilson(5, 20);
    expect(e.p10).toBeCloseTo(w.low, 6);
    expect(e.p90).toBeCloseTo(w.high, 6);
    expect(e.inputs.find((i) => i.name === "Best competitor mention rate")?.value).toBe(0.6);
    const gap = est(estimateAiMentionGap(fullContext(), P));
    expect(gap.p50).toBeGreaterThan(0.2);
    expect(gap.p50).toBeLessThan(0.45);
  });

  it("is NOT_ESTIMABLE under 10 sampled answers", () => {
    const ctx = fullContext();
    ctx.ai.byScope[P].samples = 9;
    expect(ne(estimateAiMentionRate(ctx, P)).missing).toEqual([MISSING.aiSamples]);
    expect(ne(estimateAiMentionRate(emptyContext("o"), null)).missing).toEqual([MISSING.aiTests, MISSING.aiSamples]);
  });
});

describe("expected_impact (master)", () => {
  const target = { productId: P, queryIds: ["q1", "q2"], opportunityType: "CONTENT_GAP", horizonDays: 90 };

  it("propagates clicks x conversion rate x success probability (x value per currency) by Monte Carlo", () => {
    const ctx = fullContext();
    const r = estimateImpact(ctx, target);
    expect(r.reached).toBe("revenue");
    const s = est(r.signups);
    const clicks = est(r.parts[0]).p50;
    const cr = est(r.parts[1]).p50;
    const sp = est(r.parts[2]).p50;
    const naive = clicks * 3 * cr * sp;
    expect(s.p50).toBeGreaterThan(naive * 0.85);
    expect(s.p50).toBeLessThan(naive * 1.15);
    expect(s.p10).toBeLessThan(s.p50);
    expect(s.horizonDays).toBe(90);
    expect(s.confidence).toBe("MEDIUM"); // weakest link: success probability (10 outcomes)
    expect(r.revenue.map((x) => [x.currency, x.state])).toEqual([
      ["EUR", "ESTIMATED"],
      ["USD", "NOT_ESTIMABLE"],
    ]);
    expect(est(r.revenue[0]).p50).toBeGreaterThan(0);
    expect(r.missing).toEqual([MISSING.payers]);
  });

  it("is deterministic (seeded) and independent of call order or context identity", () => {
    const a = estimateImpact(fullContext(), target);
    const ctx = fullContext();
    estimateImpact(ctx, { ...target, queryIds: ["q2"] });
    const b = estimateImpact(ctx, target);
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("returns the partial chain and every missing item", () => {
    const ctx = fullContext();
    ctx.learning = {};
    const r = estimateImpact(ctx, target);
    expect(r.reached).toBe("clicks");
    expect(r.signups.state).toBe("NOT_ESTIMABLE");
    expect(ne(r.signups).missing).toEqual([MISSING.outcomes]);
    expect(r.revenue).toEqual([]);
    expect(r.parts[0].state).toBe("ESTIMATED");

    const none = estimateImpact(emptyContext("o"), target);
    expect(none.reached).toBe("none");
    expect(none.missing).toEqual([MISSING.search, MISSING.tracker, MISSING.visitors, MISSING.outcomes, MISSING.revenue]);

    const noQueries = estimateImpact(fullContext(), { productId: P, opportunityType: "CONTENT_GAP" });
    expect(noQueries.reached).toBe("none");
    expect(ne(noQueries.signups).missing).toEqual([]);
  });

  it("stops at signups when there is no revenue source", () => {
    const ctx = fullContext();
    ctx.value = { connected: false, windowDays: 365, byScope: {} };
    const r = estimateImpact(ctx, target);
    expect(r.reached).toBe("signups");
    expect(r.revenue).toEqual([]);
    expect(r.missing).toEqual([MISSING.revenue]);
  });
});

describe("estimationPower", () => {
  it("lists measured inputs and the connection that unlocks the most chains", () => {
    const ctx = fullContext();
    ctx.conversion = { tracked: false, windowDays: 90, byScope: {} };
    const targets = [
      { productId: P, queryIds: ["q1"], opportunityType: "CONTENT_GAP" },
      { productId: P, queryIds: ["q2"], opportunityType: "CONTENT_GAP" },
      { productId: P, queryIds: ["q1"], opportunityType: "LOW_CTR" },
      { productId: P, opportunityType: "TECHNICAL" },
    ];
    const p = estimationPower(ctx, targets);
    expect(p.measured).toEqual(["Traffic potential", "Value per conversion", "Success probability", "AI mention rate"]);
    expect(p.missing).toContain(MISSING.tracker);
    expect(p.bestNextConnection).toEqual({ connect: MISSING.visitors, unlocks: 3, completes: 0 });
    expect(p.ranking?.find((r) => r.connect === MISSING.outcomes)).toEqual({ connect: MISSING.outcomes, unlocks: 1, completes: 0 });

    ctx.conversion = { tracked: true, windowDays: 90, byScope: { [P]: { all: { visitors: 10, converters: 1 }, byChannel: {} } } };
    const q = estimationPower(ctx, targets.slice(0, 2));
    expect(q.bestNextConnection).toEqual({ connect: MISSING.visitors, unlocks: 2, completes: 2 });
  });

  it("has nothing to unlock when every chain is complete", () => {
    expect(estimationPower(fullContext(), [{ productId: P, queryIds: ["q1"], opportunityType: "CONTENT_GAP" }]).bestNextConnection).toBeNull();
  });
});

describe("estimate texts", () => {
  it("are translated to French (labels, methods, reasons, missing items, inputs)", () => {
    const texts = new Set<string>();
    const add = (e: Estimate) => {
      texts.add(e.label);
      if (e.state === "ESTIMATED") texts.add(e.method);
      else {
        texts.add(e.reason);
        e.missing.forEach((m) => texts.add(m));
      }
      for (const i of e.inputs) {
        texts.add(i.name);
        texts.add(i.detail);
        if (typeof i.value === "string" && !/^[A-Z][A-Z0-9_]*$/.test(i.value) && i.name !== "Best competitor") texts.add(i.value);
      }
    };
    const addImpact = (r: ImpactEstimate) => [r.signups, ...r.revenue, ...r.parts].forEach(add);
    const ctx = fullContext();
    addImpact(estimateImpact(ctx, { productId: P, queryIds: ["q1", "q2"], opportunityType: "CONTENT_GAP" }));
    addImpact(estimateImpact(emptyContext("o"), { productId: P, queryIds: ["q1"], opportunityType: "CONTENT_GAP" }));
    addImpact(estimateImpact(ctx, { productId: P, opportunityType: "LOW_CTR" }));
    const fallback = fullContext();
    fallback.conversion.byScope[P].byChannel.ORGANIC_SEARCH = { visitors: 1, converters: 0 };
    addImpact(estimateImpact(fallback, { productId: P, queryIds: ["zero"] }));
    const four = fullContext();
    four.search.curve = CURVE.slice(0, 4);
    add(estimateTrafficPotential(four, { productId: P, queryIds: ["q1"] }));
    const thin = fullContext();
    thin.search.curve = CURVE.map((b) => (b.bucket === "3" ? { ...b, impressions: 10 } : b));
    add(estimateTrafficPotential(thin, { productId: P, queryIds: ["q1"] }));
    add(estimateAiMentionRate(ctx, P));
    add(estimateAiMentionGap(ctx, P));
    add(estimateAiMentionRate(emptyContext("o"), P));
    add(estimateValuePerConversion({ ...ctx, value: { ...ctx.value, byScope: {} } }, P)[0]);
    add(estimateSuccessProbability(ctx, null));
    estimationPower(ctx, []).measured.forEach((m) => texts.add(m));
    const untranslated = [...texts].filter((s) => FR[s] === undefined && translate(FR, s) === s);
    expect(untranslated).toEqual([]);
    expect(texts.size).toBeGreaterThan(60);
  });

  it("contain no long dashes", () => {
    const r = JSON.stringify(estimateImpact(fullContext(), { productId: P, queryIds: ["q1"], opportunityType: "CONTENT_GAP" }));
    expect(/[–—]/.test(r)).toBe(false);
  });
});
