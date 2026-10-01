import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { can, PERMISSIONS, ROLES } from "@/lib/auth/rbac";
import { clientIp, pickClientIp, readCappedText, readJson, PayloadTooLargeError, sameOrigin } from "@/lib/http";
import { safeHref, renderMarkdown } from "@/core/content/markdown";
import { isBlockedAddress } from "@/lib/security/ssrf";
import { decryptSecret, encryptSecret, envelopeKeyId, needsReencryption, parseKeyRing } from "@/lib/security/crypto";
import { redactErrorText } from "@/lib/security/redact";
import { parseEnv, productionEnvProblems, resetEnvCache } from "@/lib/env";
import { buildCsp, CSP_EXEMPT } from "@/lib/csp";
import { deriveSystemUrl, isUnsafeAppRole } from "@/db/roles";
import { loginBackoffSeconds, LOGIN_FREE_FAILURES, LOGIN_MAX_BACKOFF_SEC } from "@/lib/auth/service";
import { scopedIdempotencyKey } from "@/jobs/queue";

const key = () => randomBytes(32).toString("base64");

beforeAll(() => {
  delete process.env.BEACON_ENCRYPTION_KEY;
  delete process.env.BEACON_ENCRYPTION_KEYS;
  delete process.env.BEACON_TRUSTED_PROXY_HOPS;
  delete process.env.BEACON_BASE_URL;
  resetEnvCache();
});

describe("rbac: fact:verify", () => {
  it("is held by ADMIN and OWNER only", () => {
    expect(PERMISSIONS).toContain("fact:verify");
    expect(ROLES.filter((r) => can(r, "fact:verify"))).toEqual(["OWNER", "ADMIN"]);
  });
});

describe("client IP behind trusted proxies", () => {
  it("takes the entry added by the outermost trusted proxy, ignoring client-supplied entries", () => {
    // Client forged "6.6.6.6"; Railway's proxy appended the real address.
    expect(pickClientIp("6.6.6.6, 203.0.113.9", null, 1)).toBe("203.0.113.9");
    expect(pickClientIp("6.6.6.6, 203.0.113.9, 10.0.0.2", null, 2)).toBe("203.0.113.9");
    expect(pickClientIp("203.0.113.9", null, 3)).toBe("203.0.113.9");
    expect(pickClientIp(null, "198.51.100.4", 1)).toBe("198.51.100.4");
    expect(pickClientIp("6.6.6.6", "7.7.7.7", 0)).toBe("unknown");
    expect(pickClientIp("", null, 1)).toBe("unknown");
  });
  it("reads headers from a Request or a Headers object (default: 1 trusted hop)", () => {
    expect(clientIp(new Request("http://x/", { headers: { "x-forwarded-for": "1.1.1.1, 9.9.9.9" } }))).toBe("9.9.9.9");
    expect(clientIp(new Headers({ "x-forwarded-for": "9.9.9.9" }))).toBe("9.9.9.9");
  });
});

describe("sameOrigin (CSRF guard for cookie-authenticated POST routes)", () => {
  const req = (headers: Record<string, string>) => new Request("http://localhost:3000/api/agent", { method: "POST", headers });
  it("accepts the deployment origin or the request host", () => {
    expect(sameOrigin(req({ origin: "http://localhost:3000", host: "localhost:3000" }))).toBe(true);
    expect(sameOrigin(req({ origin: "https://beacon.example", host: "beacon.example" }))).toBe(true);
  });
  it("refuses missing, null, malformed and foreign origins without throwing", () => {
    expect(sameOrigin(req({ host: "localhost:3000" }))).toBe(false);
    expect(sameOrigin(req({ origin: "null", host: "localhost:3000" }))).toBe(false);
    expect(sameOrigin(req({ origin: "::::", host: "localhost:3000" }))).toBe(false);
    expect(sameOrigin(req({ origin: "https://evil.example", host: "beacon.example" }))).toBe(false);
  });
});

describe("readJson / readCappedText", () => {
  it("refuses a large declared Content-Length before reading", async () => {
    const r = new Request("http://x/", { method: "POST", headers: { "content-length": "999999" }, body: "{}" });
    await expect(readCappedText(r, 100)).rejects.toBeInstanceOf(PayloadTooLargeError);
  });
  it("stops a streamed body without Content-Length as soon as it exceeds the cap", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        if (pulled > 1000) return c.close();
        c.enqueue(new Uint8Array(64));
      },
    });
    const r = new Request("http://x/", { method: "POST", body: stream, duplex: "half" } as RequestInit);
    await expect(readCappedText(r, 1000)).rejects.toBeInstanceOf(PayloadTooLargeError);
    expect(pulled).toBeLessThan(40);
  });
  it("parses small bodies", async () => {
    expect(await readJson(new Request("http://x/", { method: "POST", body: '{"a":1}' }))).toEqual({ a: 1 });
    expect(await readJson(new Request("http://x/", { method: "POST" }))).toEqual({});
  });
});

describe("Markdown link safety (XSS corpus)", () => {
  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "data:text/html;base64,PHNjcmlwdD4=",
    "vbscript:msgbox(1)",
    "//evil.example",
    "/\\evil.example",
    "\\\\evil.example",
    "https:\\\\evil.example",
    "/\\/evil.example",
    "java\tscript:alert(1)",
    "/ok\u0000",
    " /leading-space",
  ])("neutralises %j", (href) => {
    expect(safeHref(href)).toBe("#");
  });
  it.each(["https://example.com/a?b=1&c=2", "http://example.com", "/pricing", "/a/b#c"])("keeps %j", (href) => {
    expect(safeHref(href)).not.toBe("#");
  });
  it("never emits a dangerous href or raw HTML from Markdown", () => {
    const html = renderMarkdown('[a](/\\evil.example) [b](javascript:alert(1)) <img src=x onerror=alert(1)> [c"onmouseover="x](/ok)');
    expect(html).not.toMatch(/href="\/\\|href="javascript|<img src=x/i);
    expect(html).toContain('href="#"');
    expect(html).toContain("&lt;img");
  });
});

describe("SSRF: IPv6 tunnelling prefixes", () => {
  it.each(["2002:7f00:1::", "2002:a00:1::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "::ffff:7f00:1", "::127.0.0.1", "64:ff9b:1::a00:1"])("blocks %s", (a) => {
    expect(isBlockedAddress(a)).toBe(true);
  });
  it.each(["2001:4860:4860::8888", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows public %s", (a) => {
    expect(isBlockedAddress(a)).toBe(false);
  });
});

describe("encryption envelope v2 with key ids", () => {
  it("encrypts with the primary key id and decrypts every key of the ring", () => {
    const [k1, k2] = [key(), key()];
    const old = parseKeyRing(undefined, k1, true);
    const legacy = encryptSecret("s3cret", "integ-1", old);
    expect(envelopeKeyId(legacy)).toBe("v1");
    const ring = parseKeyRing(`k2026:${k2}`, k1, true);
    expect(ring.primary).toBe("k2026");
    expect(decryptSecret(legacy, "integ-1", ring)).toBe("s3cret");
    expect(needsReencryption(legacy, ring)).toBe(true);
    const fresh = encryptSecret("s3cret", "integ-1", ring);
    expect(fresh.startsWith("v2:k2026:")).toBe(true);
    expect(needsReencryption(fresh, ring)).toBe(false);
    expect(decryptSecret(fresh, "integ-1", ring)).toBe("s3cret");
    // AAD binds the ciphertext to its integration.
    expect(() => decryptSecret(fresh, "integ-2", ring)).toThrow();
    // A ring without the key fails loudly.
    expect(() => decryptSecret(fresh, "integ-1", parseKeyRing(undefined, k1, true))).toThrow(/k2026 is not configured/);
  });
  it("still opens version-1 envelopes written before key ids existed", () => {
    const k1 = key();
    const ring = parseKeyRing(undefined, k1, true);
    const v2 = encryptSecret("x", "", ring);
    const [, , iv, tag, ct] = v2.split(":");
    expect(decryptSecret(["v1", iv, tag, ct].join(":"), "", ring)).toBe("x");
  });
  it("validates the key ring", () => {
    expect(() => parseKeyRing("bad", undefined, true)).toThrow();
    expect(() => parseKeyRing(`a:${key()},a:${key()}`, undefined, true)).toThrow(/duplicate/);
    expect(() => parseKeyRing(undefined, undefined, true)).toThrow(/missing/);
    expect(() => parseKeyRing("a:c2hvcnQ=", undefined, true)).toThrow(/32 bytes/);
  });
});

describe("redactErrorText", () => {
  it("strips query strings, key parameters, tokens and connection strings", () => {
    const out = redactErrorText(
      'GET https://ssl.bing.com/webmaster/api.svc/json/GetRankAndTrafficStats?apikey=ABCDEF123456&siteUrl=x failed; token=abc Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig {"client_secret":"shh"} postgres://u:p@h/db sk-ant-api03-abcdefghijk',
    );
    expect(out).not.toMatch(/ABCDEF123456|abc\b|shh|u:p@|abcdefghijk/);
    expect(out).toContain("GetRankAndTrafficStats?[redacted]");
    expect(redactErrorText("x".repeat(900)).length).toBe(500);
  });
});

describe("production environment validation", () => {
  const good = {
    NODE_ENV: "production",
    DATABASE_URL: "postgres://beacon_app:pw@db:5432/beacon",
    BEACON_BASE_URL: "https://beacon.example",
    BEACON_ENCRYPTION_KEY: key(),
    BEACON_HASH_SECRET: key(),
    BEACON_DB_SYSTEM_PASSWORD: "x".repeat(30),
  };
  it("accepts a complete production environment", () => {
    expect(parseEnv(good).BEACON_BASE_URL).toBe("https://beacon.example");
  });
  it("lists every missing or unsafe setting", () => {
    expect(() => parseEnv({ NODE_ENV: "production" })).toThrow(/DATABASE_URL is required.*BEACON_BASE_URL is required.*BEACON_ENCRYPTION_KEY.*BEACON_HASH_SECRET.*system database role/);
    expect(() => parseEnv({ ...good, BEACON_BASE_URL: "http://beacon.example" })).toThrow(/https/);
    expect(() => parseEnv({ ...good, BEACON_SSRF_ALLOW_PRIVATE: "true" })).toThrow(/SSRF/);
    expect(() => parseEnv({ ...good, BEACON_HASH_SECRET: "short" })).toThrow(/32 bytes/);
  });
  it("tolerates a loopback http base URL (local docker-compose) and uses dev defaults outside production", () => {
    expect(parseEnv({ ...good, BEACON_BASE_URL: "http://localhost:3000" }).BEACON_BASE_URL).toBe("http://localhost:3000");
    expect(parseEnv({ NODE_ENV: "development" }).DATABASE_URL).toMatch(/localhost/);
    expect(productionEnvProblems({ ...good, BEACON_TRUSTED_PROXY_HOPS: 1, NODE_ENV: "production", BEACON_EMBEDDED_WORKER: "false", BEACON_WORKER_CONCURRENCY: 2, BEACON_ANTHROPIC_MODEL: "m", BEACON_PERPLEXITY_MODEL: "s", BEACON_SSRF_ALLOW_PRIVATE: "false" } as never)).toEqual([]);
  });
});

describe("database roles", () => {
  it("derives the system role URL from DATABASE_URL and refuses missing production credentials", () => {
    expect(deriveSystemUrl({ databaseUrl: "postgres://app:pw@db:5432/beacon", password: "p@ss/word", production: true })).toBe("postgres://beacon_system:p%40ss%2Fword@db:5432/beacon");
    expect(deriveSystemUrl({ databaseUrl: "postgres://app:pw@db:5432/beacon", systemUrl: "postgres://s:x@h/d", production: true })).toBe("postgres://s:x@h/d");
    expect(() => deriveSystemUrl({ databaseUrl: "postgres://app:pw@db/beacon", production: true })).toThrow(/System database credentials missing/);
    expect(deriveSystemUrl({ databaseUrl: "postgres://app:pw@db/beacon", production: false })).toContain("beacon_system:beacon_system@");
    expect(() => deriveSystemUrl({ databaseUrl: "postgres://a@b/c", user: "bad name", password: "x", production: false })).toThrow();
  });
  it("flags superuser and BYPASSRLS application roles", () => {
    expect(isUnsafeAppRole({ user: "a", rolsuper: true, rolbypassrls: false })).toBe(true);
    expect(isUnsafeAppRole({ user: "a", rolsuper: false, rolbypassrls: true })).toBe(true);
    expect(isUnsafeAppRole({ user: "a", rolsuper: false, rolbypassrls: false })).toBe(false);
  });
});

describe("login back-off", () => {
  it("is free for the first failures, then doubles up to the cap", () => {
    expect(loginBackoffSeconds(LOGIN_FREE_FAILURES)).toBe(0);
    expect(loginBackoffSeconds(LOGIN_FREE_FAILURES + 1)).toBe(2);
    expect(loginBackoffSeconds(LOGIN_FREE_FAILURES + 2)).toBe(4);
    expect(loginBackoffSeconds(100)).toBe(LOGIN_MAX_BACKOFF_SEC);
  });
});

describe("job idempotency keys", () => {
  it("are scoped by organisation", () => {
    expect(scopedIdempotencyKey("org-a", "audit:1")).toBe("org-a:audit:1");
    expect(scopedIdempotencyKey(null, "cleanup:2026-01-01")).toBe("system:cleanup:2026-01-01");
    expect(scopedIdempotencyKey("org-a", undefined)).toBeUndefined();
  });
});

describe("Content-Security-Policy", () => {
  it("uses a nonce with strict-dynamic and forbids framing, plugins and foreign forms", () => {
    const csp = buildCsp("abc", { dev: false, https: true });
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    for (const d of ["object-src 'none'", "frame-ancestors 'none'", "form-action 'self'", "base-uri 'self'", "connect-src 'self'", "upgrade-insecure-requests"]) expect(csp).toContain(d);
    expect(buildCsp("n", { dev: true, https: false })).toMatch(/unsafe-eval.*connect-src 'self' ws: wss:/);
    expect(buildCsp("n", { dev: true, https: false })).not.toContain("upgrade-insecure-requests");
  });
  it("exempts APIs, the public tracker and static assets", () => {
    for (const p of ["/api/v1/events", "/beacon.js", "/_next/static/chunks/a.js", "/r/CODE"]) expect(CSP_EXEMPT.test(p)).toBe(true);
    for (const p of ["/", "/settings", "/p/acme/page", "/ask/acme", "/beacon.json"]) expect(CSP_EXEMPT.test(p)).toBe(false);
  });
});
