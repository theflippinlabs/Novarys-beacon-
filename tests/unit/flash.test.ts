import { describe, expect, it } from "vitest";
import { FLASH_TTL_SECONDS, readFlash, signFlash, verifyFlash, withFlash, withoutFlash } from "@/lib/flash";
import { withoutFlashParams } from "@/components/ui/flash-seen";
import { makeT } from "@/i18n/core";
import { FR } from "@/i18n/fr";

const NOW = new Date("2026-10-01T10:00:00Z");
const USER = "6f1c2f4e-1a2b-4c3d-8e9f-0a1b2c3d4e5f";
const OTHER = "0d9a8b7c-6e5f-4a3b-9c2d-1e0f9a8b7c6d";

/** Search params as a Next.js page receives them, from a redirect target. */
const params = (path: string) => Object.fromEntries(new URL(path, "http://x").searchParams.entries());

describe("signed flash messages", () => {
  it("round-trips a message signed by the app for the signed-in member", () => {
    const url = withFlash("/content/1?tab=x#images", "ok", "Draft generation queued.", USER, NOW);
    expect(url.startsWith("/content/1?tab=x&ok=Draft+generation+queued.&fs=")).toBe(true);
    expect(url.endsWith("#images")).toBe(true);
    expect(readFlash(params(url), [USER, null], NOW)).toEqual({ kind: "ok", text: "Draft generation queued." });
  });

  it("shows nothing for an unsigned, tampered, foreign or expired message", () => {
    // A crafted link without a signature.
    expect(readFlash({ ok: "Your account is suspended. Call +1 555 0100." }, [USER, null], NOW)).toBeNull();
    expect(readFlash({ error: "Session expired, sign in at https://evil.example" }, [null], NOW)).toBeNull();
    const url = withFlash("/products", "ok", "Product created.", USER, NOW);
    const p = params(url);
    // Text changed after signing.
    expect(readFlash({ ...p, ok: "Product deleted." }, [USER, null], NOW)).toBeNull();
    // Kind swapped: the signature covers the kind.
    expect(readFlash({ error: p.ok, fs: p.fs }, [USER, null], NOW)).toBeNull();
    // Signed for another member.
    expect(readFlash(p, [OTHER, null], NOW)).toBeNull();
    // Expired.
    expect(readFlash(p, [USER], new Date(NOW.getTime() + (FLASH_TTL_SECONDS + 1) * 1000))).toBeNull();
    expect(readFlash(p, [USER], new Date(NOW.getTime() + (FLASH_TTL_SECONDS - 1) * 1000))).not.toBeNull();
    // Garbage signatures.
    for (const fs of ["", "x", "abc.def", `${p.fs}0`, p.fs.toUpperCase()]) expect(readFlash({ ok: p.ok, fs }, [USER], NOW)).toBeNull();
  });

  it("accepts anonymous messages (login, setup, invitations) for anyone, member messages only for that member", () => {
    const anon = params(withFlash("/login", "error", "Invalid email or password.", null, NOW));
    expect(readFlash(anon, [null], NOW)).toEqual({ kind: "error", text: "Invalid email or password." });
    expect(readFlash(anon, [USER, null], NOW)).toEqual({ kind: "error", text: "Invalid email or password." });
    const member = params(withFlash("/", "ok", "Saved.", USER, NOW));
    expect(readFlash(member, [null], NOW)).toBeNull();
  });

  it("verifies against the exact signed text (truncated to 300 characters)", () => {
    const long = "x".repeat(400);
    const p = params(withFlash("/", "error", long, USER, NOW));
    expect(p.error).toHaveLength(300);
    expect(readFlash(p, [USER], NOW)).toEqual({ kind: "error", text: "x".repeat(300) });
    expect(verifyFlash("error", long, signFlash("error", long, USER, NOW), [USER], NOW)).toBe(true);
    expect(verifyFlash("error", long, null, [USER], NOW)).toBe(false);
  });

  it("replaces a previous flash and strips submitted flash parameters", () => {
    const first = withFlash("/queries?product=a", "error", "Nope", USER, NOW);
    const second = withFlash(first, "ok", "Done.", USER, NOW);
    const p = params(second);
    expect(p.error).toBeUndefined();
    expect(p.product).toBe("a");
    expect(readFlash(p, [USER], NOW)).toEqual({ kind: "ok", text: "Done." });
    expect(withoutFlash("/queries?product=a&ok=Fake&fs=1.2#gaps")).toBe("/queries?product=a#gaps");
    expect(withoutFlash("/t")).toBe("/t");
  });

  it("keeps the English text in the URL so the message is translated at render", () => {
    const p = params(withFlash("/settings", "ok", "Public site turned on.", USER, NOW));
    const f = readFlash(p, [USER], NOW)!;
    expect(makeT(FR)(f.text)).toBe(FR["Public site turned on."]);
  });

  it("FlashSeen removes the message and its signature from the address bar", () => {
    expect(withoutFlashParams(`https://b.example${withFlash("/content/1#images", "ok", "Saved.", USER, NOW)}`)).toBe("/content/1#images");
    expect(withoutFlashParams("https://b.example/queries?product=a&fs=abc")).toBe("/queries?product=a");
    expect(withoutFlashParams("https://b.example/queries?product=a")).toBeNull();
  });
});
