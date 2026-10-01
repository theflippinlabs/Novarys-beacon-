import { describe, expect, it } from "vitest";
import {
  diffSummary,
  excerptOf,
  extractMainLines,
  interleaveByHost,
  MAX_STORED_TEXT,
  priceTokens,
  RECHECK_AFTER_MS,
  robotsDecision,
  selectDue,
  storedText,
  textHash,
  validateWatchUrl,
  WatchUrlError,
} from "@/core/competitors/watch";
import { JOB_CONCURRENCY, JOB_TYPES } from "@/jobs/queue";
import { KIND_LABELS, KIND_LINKS, KIND_TITLES, NOTIFICATION_KINDS } from "@/core/notifications/notifications";

const EM = String.fromCharCode(0x2014);

describe("watched URL validation", () => {
  it("accepts https URLs and drops the fragment", () => {
    expect(validateWatchUrl(" https://rival.example/pricing#plans ").toString()).toBe("https://rival.example/pricing");
  });

  it("refuses http, credentials, custom ports and garbage", () => {
    for (const bad of ["http://rival.example/pricing", "https://user:pw@rival.example/", "https://rival.example:8443/", "ftp://rival.example/", "not a url", ""])
      expect(() => validateWatchUrl(bad), bad).toThrow(WatchUrlError);
  });

  it("allows plain http only for hosts the caller marks as local development hosts", () => {
    const local = (h: string) => h === "127.0.0.1";
    expect(validateWatchUrl("http://127.0.0.1:4010/pricing", { allowLocalHttp: local }).toString()).toBe("http://127.0.0.1:4010/pricing");
    expect(() => validateWatchUrl("http://rival.example/pricing", { allowLocalHttp: local })).toThrow(WatchUrlError);
  });
});

describe("main text normalisation", () => {
  const html = `<!doctype html><html><head><title>Pricing</title><style>.x{color:red}</style><script>var price = "$1";</script></head>
    <body>
      <header class="site-header"><a href="/">Rival</a> <a href="/login">Log in</a></header>
      <nav><a href="/pricing">Pricing</a><a href="/features">Features</a></nav>
      <div class="cookie-banner">We use cookies <button>Accept</button></div>
      <main>
        <h1>Simple   pricing</h1>
        <div class="plan-header"><h2>Starter</h2><p>$29/mo   billed\n yearly</p></div>
        <div class="plan"><h2>Pro ${EM} teams</h2><p>$79/mo</p><ul><li>Unlimited seats</li><li>SSO</li></ul></div>
        <noscript>Enable JavaScript</noscript>
        <p hidden>Secret promo</p>
        <p aria-hidden="true">Decoration</p>
      </main>
      <footer>Copyright Rival</footer>
    </body></html>`;

  it("keeps the main content, one line per block, without scripts, styles, navigation, header, footer or banners", () => {
    expect(extractMainLines(html)).toEqual(["Simple pricing", "Starter", "$29/mo billed yearly", "Pro, teams", "$79/mo", "Unlimited seats", "SSO"]);
  });

  it("falls back to the body and drops consecutive duplicate lines", () => {
    expect(extractMainLines("<body><p>Plans</p><p>Plans</p><div>From <b>9 EUR</b> per month</div></body>")).toEqual(["Plans", "From 9 EUR per month"]);
  });

  it("hashes the normalised text: markup and whitespace changes do not change the hash, text changes do", () => {
    const a = textHash(extractMainLines("<main><p>Pro</p><p>$79/mo</p></main>"));
    const b = textHash(extractMainLines('<main>\n  <p class="new">Pro</p>\n\n<p>  $79/mo </p></main><script>x()</script>'));
    const c = textHash(extractMainLines("<main><p>Pro</p><p>$89/mo</p></main>"));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
    expect(c).not.toBe(a);
    expect(textHash([])).toBeNull();
  });

  it("caps the excerpt on a word boundary and the stored text on whole lines", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `Line number ${i} of the competitor page`);
    const ex = excerptOf(lines, 100);
    expect(ex.length).toBeLessThanOrEqual(103);
    expect(ex.endsWith("...")).toBe(true);
    expect(excerptOf(["short"])).toBe("short");
    const big = Array.from({ length: 5000 }, (_, i) => `${"x".repeat(40)} ${i}`);
    const kept = storedText(big);
    expect(kept.length).toBeLessThanOrEqual(MAX_STORED_TEXT);
    expect(big).toEqual(expect.arrayContaining(kept.split("\n")));
  });
});

describe("price-like tokens", () => {
  it("quotes prices as written, with currency and period", () => {
    expect(priceTokens("Starter $29/mo, Team US$ 1,200 per year, Pro 49 € par mois, Basic EUR 9.99, Plus £5 per user")).toEqual(["$29/mo", "US$ 1,200 per year", "49 € par mois", "EUR 9.99", "£5 per user"]);
  });

  it("ignores plain numbers", () => {
    expect(priceTokens("Up to 5 seats, 30 days, 2026, 99.9% uptime")).toEqual([]);
  });
});

describe("diff summary", () => {
  it("counts added and removed lines, ignores moved lines and lists price changes quoted from the page", () => {
    const before = ["Pricing", "Starter", "$29/mo", "Pro", "$79/mo", "SSO"];
    const after = ["Pricing", "SSO", "Starter", "$35/mo", "Pro", "$79/mo", "Audit log"];
    const d = diffSummary(before, after);
    expect(d.linesAdded).toBe(2);
    expect(d.linesRemoved).toBe(1);
    expect(d.added).toEqual(["$35/mo", "Audit log"]);
    expect(d.removed).toEqual(["$29/mo"]);
    expect(d.pricesAppeared).toEqual(["$35/mo"]);
    expect(d.pricesDisappeared).toEqual(["$29/mo"]);
  });

  it("is empty for identical texts and samples at most five lines", () => {
    expect(diffSummary(["a", "b"], ["a", "b"])).toEqual({ linesAdded: 0, linesRemoved: 0, added: [], removed: [], pricesAppeared: [], pricesDisappeared: [] });
    const d = diffSummary([], Array.from({ length: 12 }, (_, i) => `new ${i}`));
    expect(d.linesAdded).toBe(12);
    expect(d.added).toHaveLength(5);
  });
});

describe("robots decision", () => {
  const url = "https://rival.example/pricing";

  it("respects a disallow for Beacon's token and allows when only other agents are disallowed", () => {
    expect(robotsDecision(200, "User-agent: NovarysBeacon\nDisallow: /pricing\n\nUser-agent: *\nAllow: /", url)).toMatchObject({ allowed: false, reason: "DISALLOWED" });
    expect(robotsDecision(200, "User-agent: Googlebot\nDisallow: /\n\nUser-agent: *\nAllow: /", url)).toMatchObject({ allowed: true, reason: "ALLOWED" });
    expect(robotsDecision(200, "User-agent: *\nDisallow: /pricing", url)).toMatchObject({ allowed: false });
    expect(robotsDecision(200, "User-agent: *\nDisallow: /pricing\nAllow: /pricing$", url)).toMatchObject({ allowed: true });
  });

  it("treats 4xx as allow all and 5xx, 429 or unreachable as disallow all", () => {
    expect(robotsDecision(404, null, url).allowed).toBe(true);
    expect(robotsDecision(500, null, url)).toMatchObject({ allowed: false, reason: "ROBOTS_UNAVAILABLE" });
    expect(robotsDecision(429, null, url).allowed).toBe(false);
    expect(robotsDecision(null, null, url).allowed).toBe(false);
  });

  it("honours Crawl-delay (capped at 10 s) as the host politeness delay", () => {
    expect(robotsDecision(200, "User-agent: *\nCrawl-delay: 5", url, 2000).delayMs).toBe(5000);
    expect(robotsDecision(200, "User-agent: *\nCrawl-delay: 60", url, 2000).delayMs).toBe(10_000);
    expect(robotsDecision(404, null, url, 2000).delayMs).toBe(2000);
  });
});

describe("run selection", () => {
  const now = new Date("2026-10-01T00:00:00Z");
  const old = new Date(now.getTime() - RECHECK_AFTER_MS - 1000);
  const recent = new Date(now.getTime() - 3600_000);
  const w = (id: string, url: string, lastFetchedAt: Date | null, active = true) => ({ id, url, active, lastFetchedAt });

  it("selects active, due watches (never checked first), capped, or exactly the requested ones", () => {
    const list = [w("a", "https://a.example/p", old), w("b", "https://b.example/p", null), w("c", "https://c.example/p", recent), w("d", "https://d.example/p", null, false)];
    expect(selectDue(list, now).map((x) => x.id)).toEqual(["b", "a"]);
    expect(selectDue(list, now, { max: 1 }).map((x) => x.id)).toEqual(["b"]);
    expect(selectDue(list, now, { ids: ["c", "d"] }).map((x) => x.id)).toEqual(["c"]);
  });

  it("interleaves hosts so the same host is not requested twice in a row when avoidable", () => {
    const list = [w("1", "https://a.example/1", null), w("2", "https://a.example/2", null), w("3", "https://b.example/1", null), w("4", "https://a.example/3", null)];
    expect(interleaveByHost(list).map((x) => x.id)).toEqual(["1", "3", "2", "4"]);
  });
});

describe("wiring", () => {
  it("registers the job with a concurrency cap of 1", () => {
    expect(JOB_TYPES).toContain("competitor_watch.check");
    expect(JOB_CONCURRENCY["competitor_watch.check"]).toBe(1);
  });

  it("defines the notification kind like every other kind", () => {
    expect(NOTIFICATION_KINDS).toContain("COMPETITOR_PAGE_CHANGED");
    expect(KIND_LABELS.COMPETITOR_PAGE_CHANGED).toBeTruthy();
    expect(KIND_TITLES.COMPETITOR_PAGE_CHANGED).toContain("{n}");
    expect(KIND_LINKS.COMPETITOR_PAGE_CHANGED).toBe("/ai-visibility#watched-pages");
  });
});
