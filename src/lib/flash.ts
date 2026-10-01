import { hmac, safeEqual } from "@/lib/security/crypto";
import { FLASH_PARAMS, FLASH_SIG_PARAM } from "./flash-params";

/**
 * Signed flash messages. The app shows `?ok=` / `?error=` text only when it
 * carries a valid HMAC (`fs` parameter) produced by the app itself, so a
 * crafted link cannot display a fake message on a signed-in page.
 *
 * The signature covers the kind, the exact text, the issue time and the
 * subject it was produced for (the signed-in user id, or "" for anonymous
 * pages such as login and invitations). It is valid for FLASH_TTL_SECONDS.
 * The text stays in English in the URL and is translated at render.
 */
export type FlashKind = "ok" | "error";
export type Flash = { kind: FlashKind; text: string };

export const FLASH_MAX_LENGTH = 300;
export const FLASH_TTL_SECONDS = 10 * 60;
/** Tolerated clock skew between instances (a signature from slightly in the future). */
const SKEW_SECONDS = 60;

const mac = (kind: FlashKind, text: string, subject: string, ts: string) => hmac(`${kind}\n${subject}\n${ts}\n${text}`, "flash").slice(0, 32);

/** Signature for one flash message: `<issued-at, base 36 seconds>.<hmac>`. */
export function signFlash(kind: FlashKind, text: string, subject: string | null, now: Date = new Date()): string {
  const ts = Math.floor(now.getTime() / 1000).toString(36);
  return `${ts}.${mac(kind, text, subject ?? "", ts)}`;
}

/** True when `sig` was produced by `signFlash` for this kind, text and one of the subjects, and has not expired. */
export function verifyFlash(kind: FlashKind, text: string, sig: string | null | undefined, subjects: (string | null)[], now: Date = new Date()): boolean {
  if (!sig) return false;
  const m = /^([0-9a-z]{1,10})\.([0-9a-f]{32})$/.exec(sig);
  if (!m) return false;
  const age = Math.floor(now.getTime() / 1000) - parseInt(m[1], 36);
  if (!Number.isFinite(age) || age > FLASH_TTL_SECONDS || age < -SKEW_SECONDS) return false;
  return subjects.some((s) => safeEqual(mac(kind, text, s ?? "", m[1]), m[2]));
}

/** `path` without any flash parameter (keeps other parameters and the hash). */
export function withoutFlash(path: string): string {
  const [base, ...rest] = path.split("#");
  const hash = rest.join("#");
  const u = new URL(base, "http://x");
  for (const p of FLASH_PARAMS) u.searchParams.delete(p);
  return `${u.pathname}${u.search}${hash ? `#${hash}` : ""}`;
}

/** `path` carrying one signed flash message (replacing any previous one). */
export function withFlash(path: string, kind: FlashKind, text: string, subject: string | null, now: Date = new Date()): string {
  const clean = withoutFlash(path);
  const [base, ...rest] = clean.split("#");
  const hash = rest.join("#");
  const u = new URL(base, "http://x");
  const value = text.slice(0, FLASH_MAX_LENGTH);
  u.searchParams.set(kind, value);
  u.searchParams.set(FLASH_SIG_PARAM, signFlash(kind, value, subject, now));
  return `${u.pathname}${u.search}${hash ? `#${hash}` : ""}`;
}

/**
 * The flash message of a request, only when its signature is valid for one
 * of `subjects` (the signed-in user id and "" for anonymous messages).
 * Unsigned, tampered or expired messages are ignored.
 */
export function readFlash(searchParams: Record<string, string | string[] | undefined>, subjects: (string | null)[], now: Date = new Date()): Flash | null {
  const one = (k: string) => (typeof searchParams[k] === "string" ? (searchParams[k] as string) : null);
  const sig = one(FLASH_SIG_PARAM);
  const error = one("error");
  const ok = one("ok");
  // An error takes precedence, as before; only the kind that verifies is shown.
  if (error !== null && verifyFlash("error", error, sig, subjects, now)) return { kind: "error", text: error };
  if (ok !== null && verifyFlash("ok", ok, sig, subjects, now)) return { kind: "ok", text: ok };
  return null;
}
