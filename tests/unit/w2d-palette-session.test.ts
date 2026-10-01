import { describe, expect, it } from "vitest";
import { fuzzyScore, likeEscape, normalizeText, rankItems } from "@/core/command/fuzzy";
import { decodeCursor, encodeCursor, pageOf } from "@/core/util/cursor";
import {
  pickSessionToken,
  SESSION_ABSOLUTE_MS,
  SESSION_COOKIE_LEGACY,
  SESSION_COOKIE_PROD,
  SESSION_IDLE_MS,
  SESSION_TOUCH_INTERVAL_MS,
  sessionCookieName,
  sessionVerdict,
} from "@/core/auth/session-policy";

describe("command palette fuzzy ranking", () => {
  it("ranks exact > prefix > word prefix > substring > all words > subsequence", () => {
    const exact = fuzzyScore("products", "Products")!;
    const prefix = fuzzyScore("prod", "Products")!;
    const word = fuzzyScore("live", "Novus Live")!;
    const sub = fuzzyScore("ovu", "Novus Live")!;
    const words = fuzzyScore("live novus", "Novus Live app")!;
    const subseq = fuzzyScore("nvslv", "Novus Live")!;
    expect(exact).toBeGreaterThan(prefix);
    expect(prefix).toBeGreaterThan(word);
    expect(word).toBeGreaterThan(sub);
    expect(sub).toBeGreaterThan(words);
    expect(words).toBeGreaterThan(subseq);
    expect(subseq).toBeGreaterThan(0);
  });

  it("ignores case and accents and rejects non-matches", () => {
    expect(normalizeText("  Opportunités  Élevées ")).toBe("opportunites elevees");
    expect(fuzzyScore("opportunite", "Opportunités")).not.toBeNull();
    expect(fuzzyScore("xyz", "Products")).toBeNull();
    expect(fuzzyScore("", "Anything")).toBe(0);
  });

  it("orders items by score, keeps input order on ties, uses keywords and limits", () => {
    const items = [
      { label: "Settings" },
      { label: "Run crawl: Acme", keywords: ["audit", "seo"] },
      { label: "Discovery" },
      { label: "Show critical issues", keywords: ["seo issues"] },
    ];
    expect(rankItems("seo", items).map((i) => i.label)).toEqual(["Run crawl: Acme", "Show critical issues"]);
    expect(rankItems("s", items, 1).map((i) => i.label)).toEqual(["Settings"]);
    expect(rankItems("dsc", items).map((i) => i.label)[0]).toBe("Discovery");
  });

  it("escapes LIKE wildcards", () => {
    expect(likeEscape("50%_off\\")).toBe("50\\%\\_off\\\\");
  });
});

describe("cursor pagination", () => {
  const id = "0b6c6f0e-5d2a-4f43-9d0b-3f0c3b5a1e11";
  it("round-trips and rejects malformed cursors", () => {
    expect(decodeCursor(encodeCursor({ v: "2026-01-01T00:00:00.000Z", id }))).toEqual({ v: "2026-01-01T00:00:00.000Z", id });
    expect(decodeCursor(encodeCursor({ v: 3, id }))).toEqual({ v: 3, id });
    expect(decodeCursor("not a cursor!")).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify(["x", "not-a-uuid"])).toString("base64url"))).toBeNull();
    expect(decodeCursor(Buffer.from("{").toString("base64url"))).toBeNull();
    expect(decodeCursor(undefined)).toBeNull();
  });

  it("cuts a limit + 1 fetch into a page and a next cursor", () => {
    const rows = [1, 2, 3].map((n) => ({ n, id }));
    expect(pageOf(rows, 3, (r) => ({ v: r.n, id: r.id }))).toEqual({ items: rows, next: null });
    const p = pageOf(rows, 2, (r) => ({ v: r.n, id: r.id }));
    expect(p.items).toHaveLength(2);
    expect(decodeCursor(p.next)).toEqual({ v: 2, id });
  });
});

describe("session idle timeout", () => {
  const now = new Date("2026-10-01T12:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);
  const session = (created: number, seen: number) => ({ createdAt: ago(created), lastSeenAt: ago(seen), expiresAt: new Date(ago(created).getTime() + SESSION_ABSOLUTE_MS) });

  it("is valid while used within 24 hours and touches at most hourly", () => {
    expect(sessionVerdict(session(5 * 60_000, 5 * 60_000), now)).toEqual({ valid: true, touch: false });
    expect(sessionVerdict(session(SESSION_TOUCH_INTERVAL_MS + 1, SESSION_TOUCH_INTERVAL_MS + 1), now)).toEqual({ valid: true, touch: true });
    expect(sessionVerdict(session(SESSION_IDLE_MS * 3, SESSION_IDLE_MS - 1000), now)).toEqual({ valid: true, touch: true });
  });

  it("ends after 24 hours of inactivity", () => {
    expect(sessionVerdict(session(SESSION_IDLE_MS + 1, SESSION_IDLE_MS), now)).toEqual({ valid: false, reason: "idle" });
  });

  it("ends 30 days after sign-in even when active, including legacy rows with a later expiry", () => {
    expect(sessionVerdict(session(SESSION_ABSOLUTE_MS, 1000), now)).toEqual({ valid: false, reason: "expired" });
    const legacy = { createdAt: ago(SESSION_ABSOLUTE_MS + 1), lastSeenAt: ago(1000), expiresAt: new Date(now.getTime() + 1e9) };
    expect(sessionVerdict(legacy, now)).toEqual({ valid: false, reason: "expired" });
  });

  it("uses the __Host- cookie in production and still reads the legacy name there", () => {
    expect(sessionCookieName(true)).toBe("__Host-beacon_session");
    expect(sessionCookieName(false)).toBe("beacon_session");
    const jar = (m: Record<string, string>) => (n: string) => m[n];
    expect(pickSessionToken(jar({ [SESSION_COOKIE_PROD]: "new", [SESSION_COOKIE_LEGACY]: "old" }), true)).toEqual({ token: "new", legacy: false });
    expect(pickSessionToken(jar({ [SESSION_COOKIE_LEGACY]: "old" }), true)).toEqual({ token: "old", legacy: true });
    expect(pickSessionToken(jar({ [SESSION_COOKIE_PROD]: "new" }), false)).toEqual({ token: undefined, legacy: false });
  });
});
