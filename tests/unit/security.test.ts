import { createHmac } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { assertSafeUrl, isBlockedAddress, SsrfError } from "@/lib/security/ssrf";
import { decryptSecret, encryptSecret, hashPassword, hmac, safeEqual, sha256, verifyPassword } from "@/lib/security/crypto";
import { redact } from "@/lib/logger";
import { resetEnvCache } from "@/lib/env";

beforeAll(() => {
  delete process.env.BEACON_SSRF_ALLOW_PRIVATE;
  delete process.env.BEACON_ENCRYPTION_KEY;
  delete process.env.BEACON_HASH_SECRET;
  resetEnvCache();
});

describe("isBlockedAddress", () => {
  it.each(["10.1.2.3", "127.0.0.1", "169.254.169.254", "172.16.5.4", "192.168.1.1", "100.64.0.1", "0.0.0.0", "224.0.0.1", "::1", "::", "::ffff:127.0.0.1", "::ffff:7f00:1", "fc00::1", "fd12:3456::1", "fe80::1", "not-an-ip"])(
    "blocks %s",
    (a) => expect(isBlockedAddress(a)).toBe(true),
  );
  it.each(["8.8.8.8", "1.1.1.1", "172.32.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"])("allows public %s", (a) => expect(isBlockedAddress(a)).toBe(false));
});

describe("assertSafeUrl", () => {
  const rejects = (u: string, msg: RegExp, opts?: { allowPorts?: number[] }) => {
    expect(() => assertSafeUrl(u, opts)).toThrow(SsrfError);
    expect(() => assertSafeUrl(u, opts)).toThrow(msg);
  };

  it("rejects non-http schemes, invalid URLs and credentials", () => {
    rejects("file:///etc/passwd", /Only http/);
    rejects("ftp://example.com/", /Only http/);
    rejects("not a url", /Invalid URL/);
    rejects("https://user:pass@example.com/", /Credentials/);
    rejects("https://user@example.com/", /Credentials/);
  });

  it("rejects non-default ports unless allowed", () => {
    rejects("http://example.com:8080/", /Port 8080/);
    rejects("https://example.com:22/", /Port 22/);
    expect(assertSafeUrl("http://example.com:8080/", { allowPorts: [8080] }).port).toBe("8080");
    expect(assertSafeUrl("https://example.com:443/").hostname).toBe("example.com");
  });

  it("rejects localhost, metadata hosts and literal private IPs (incl. alternate encodings)", () => {
    rejects("http://localhost/", /Host is not allowed/);
    rejects("http://LOCALHOST/", /Host is not allowed/);
    rejects("http://metadata.google.internal/computeMetadata/v1/", /Host is not allowed/);
    rejects("http://127.0.0.1/", /Address is not allowed/);
    rejects("http://169.254.169.254/latest/meta-data/", /Address is not allowed/);
    rejects("http://10.0.0.1/", /Address is not allowed/);
    rejects("http://[::1]/", /Address is not allowed/);
    rejects("http://[::ffff:127.0.0.1]/", /Address is not allowed/);
    rejects("http://2130706433/", /Address is not allowed/);
    rejects("http://0x7f.0.0.1/", /Address is not allowed/);
  });

  it("allows public URLs", () => {
    expect(assertSafeUrl("https://example.com/path?q=1").href).toBe("https://example.com/path?q=1");
    expect(assertSafeUrl("http://8.8.8.8/").hostname).toBe("8.8.8.8");
  });
});

describe("crypto", () => {
  it("round-trips AES-GCM encryption with fresh IVs", () => {
    const a = encryptSecret("s3cret-value ✓", "org:1");
    const b = encryptSecret("s3cret-value ✓", "org:1");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1:")).toBe(true);
    expect(a).not.toContain("s3cret");
    expect(decryptSecret(a, "org:1")).toBe("s3cret-value ✓");
  });

  // BUG: an empty plaintext yields an envelope with an empty ciphertext part
  // ("v1:<iv>:<tag>:"), which decryptSecret rejects as "Unsupported ciphertext envelope".
  it("round-trips an empty string", () => {
    expect(decryptSecret(encryptSecret(""))).toBe("");
  });

  it("detects tampering", () => {
    const env = encryptSecret("hello world", "aad");
    const [v, iv, tag, ct] = env.split(":");
    const buf = Buffer.from(ct, "base64");
    buf[0] ^= 0xff;
    expect(() => decryptSecret([v, iv, tag, buf.toString("base64")].join(":"), "aad")).toThrow();
    const badTag = Buffer.from(tag, "base64");
    badTag[0] ^= 0x01;
    expect(() => decryptSecret([v, iv, badTag.toString("base64"), ct].join(":"), "aad")).toThrow();
  });

  it("rejects an AAD mismatch and malformed envelopes", () => {
    const env = encryptSecret("hello", "org:1");
    expect(() => decryptSecret(env, "org:2")).toThrow();
    expect(() => decryptSecret(env)).toThrow();
    expect(() => decryptSecret("v2:a:b:c")).toThrow(/Unsupported ciphertext envelope/);
    expect(() => decryptSecret("garbage")).toThrow(/Unsupported/);
  });

  it("hashes and verifies passwords", async () => {
    const stored = await hashPassword("correct horse battery staple");
    expect(stored).toMatch(/^scrypt\$32768\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
    expect(await verifyPassword("correct horse battery staple", stored)).toBe(true);
    expect(await verifyPassword("wrong password", stored)).toBe(false);
    expect(await verifyPassword("x", "bcrypt$whatever")).toBe(false);
    expect(await hashPassword("correct horse battery staple")).not.toBe(stored);
  });

  it("safeEqual, sha256 and hmac", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    expect(hmac("a@b.c", "email")).toBe(hmac("a@b.c", "email"));
    expect(hmac("a@b.c", "email")).not.toBe(hmac("a@b.c", "ip"));
    expect(hmac("x")).toMatch(/^[0-9a-f]{64}$/);
    expect(createHmac("sha256", "k").update("x").digest("hex")).not.toBe(hmac("x"));
  });
});

describe("logger redact", () => {
  it("redacts secret-looking keys at any depth", () => {
    const out = redact({
      user: "alice",
      password: "hunter2",
      nested: { apiKey: "abc", api_key: "abc", accessToken: "t", deeper: [{ Authorization: "Bearer x", ok: 1 }] },
      privateKey: "pem",
    });
    expect(out).toEqual({
      user: "alice",
      password: "[redacted]",
      nested: { apiKey: "[redacted]", api_key: "[redacted]", accessToken: "[redacted]", deeper: [{ Authorization: "[redacted]", ok: 1 }] },
      privateKey: "[redacted]",
    });
  });

  it("redacts key-looking substrings inside strings", () => {
    expect(redact("key=sk-ant-abc123456789 end")).toBe("key=[redacted-key] end");
    expect(redact("pplx_ABCDEFGHIJ and sk_live_1234567890")).toBe("[redacted-key] and [redacted-key]");
    expect(redact("sk-short")).toBe("sk-short");
    expect(redact({ msg: "failed with sk-ant-abc123456789" })).toEqual({ msg: "failed with [redacted-key]" });
  });

  it("serialises errors, passes through primitives and bounds depth", () => {
    const e = redact(new Error("boom")) as { name: string; message: string };
    expect(e).toMatchObject({ name: "Error", message: "boom" });
    expect(redact(42)).toBe(42);
    expect(redact(null)).toBeNull();
    let deep: Record<string, unknown> = { v: 1 };
    for (let i = 0; i < 10; i++) deep = { d: deep };
    expect(JSON.stringify(redact(deep))).toContain("[depth]");
  });
});
