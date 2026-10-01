import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { env } from "@/lib/env";

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;

const DEV_FALLBACK = "beacon-development-only-key-material-not-for-production";

function keyMaterial(value: string | undefined, purpose: string): Buffer {
  if (value) {
    const buf = Buffer.from(value, "base64");
    if (buf.length < 32) throw new Error(`${purpose} must be at least 32 bytes (base64)`);
    return buf.subarray(0, 32);
  }
  if (env().NODE_ENV === "production") throw new Error(`${purpose} missing`);
  return createHash("sha256").update(`${DEV_FALLBACK}:${purpose}`).digest();
}

const hashKey = () => keyMaterial(env().BEACON_HASH_SECRET, "BEACON_HASH_SECRET");

// ── Encryption key ring ─────────────────────────────────────────────────
// BEACON_ENCRYPTION_KEYS="kid:base64key,kid2:base64key2": the FIRST entry
// encrypts, every entry decrypts. The legacy BEACON_ENCRYPTION_KEY is key id
// "v1" (the id implied by version-1 envelopes). Rotation: prepend a new key,
// run `pnpm secrets:rotate`, then drop the old entry.
export type KeyRing = { primary: string; keys: Map<string, Buffer> };
const KID_RE = /^[A-Za-z0-9_-]{1,32}$/;

export function parseKeyRing(keys: string | undefined, legacy: string | undefined, production: boolean): KeyRing {
  const ring = new Map<string, Buffer>();
  let primary: string | undefined;
  for (const entry of (keys ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = entry.indexOf(":");
    const kid = i > 0 ? entry.slice(0, i) : "";
    if (!KID_RE.test(kid)) throw new Error("BEACON_ENCRYPTION_KEYS entries must look like kid:base64key (kid: letters, digits, - or _)");
    if (ring.has(kid)) throw new Error(`BEACON_ENCRYPTION_KEYS has a duplicate key id ${kid}`);
    ring.set(kid, keyMaterial(entry.slice(i + 1), `BEACON_ENCRYPTION_KEYS[${kid}]`));
    primary ??= kid;
  }
  if (legacy && !ring.has("v1")) {
    ring.set("v1", keyMaterial(legacy, "BEACON_ENCRYPTION_KEY"));
    primary ??= "v1";
  }
  if (!primary) {
    if (production) throw new Error("BEACON_ENCRYPTION_KEY or BEACON_ENCRYPTION_KEYS missing");
    // Development: one derived key, also answering to "v1" so old local envelopes still open.
    const dev = createHash("sha256").update(`${DEV_FALLBACK}:BEACON_ENCRYPTION_KEY`).digest();
    ring.set("v1", dev);
    primary = "v1";
  }
  return { primary, keys: ring };
}

const keyRing = (): KeyRing => {
  const e = env();
  return parseKeyRing(e.BEACON_ENCRYPTION_KEYS, e.BEACON_ENCRYPTION_KEY, e.NODE_ENV === "production");
};

/**
 * AES-256-GCM authenticated encryption for provider credentials.
 * Envelope v2: `v2:<kid>:<iv>:<tag>:<ciphertext>` (base64 parts).
 */
export function encryptSecret(plaintext: string, aad = "", ring: KeyRing = keyRing()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", ring.keys.get(ring.primary)!, iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v2", ring.primary, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

/** Key id of an envelope (`v1` envelopes carry the legacy key implicitly). */
export function envelopeKeyId(envelope: string): string | null {
  const parts = envelope.split(":");
  if (parts[0] === "v1" && parts.length === 4) return "v1";
  if (parts[0] === "v2" && parts.length === 5) return parts[1];
  return null;
}

/** True when an envelope was not produced by the current primary key (rotation pending). */
export function needsReencryption(envelope: string, ring: KeyRing = keyRing()): boolean {
  return envelope.split(":")[0] !== "v2" || envelopeKeyId(envelope) !== ring.primary;
}

export function decryptSecret(envelope: string, aad = "", ring: KeyRing = keyRing()): string {
  const parts = envelope.split(":");
  let kid: string, iv: string, tag: string, ct: string;
  if (parts[0] === "v1" && parts.length === 4) [kid, iv, tag, ct] = ["v1", parts[1], parts[2], parts[3]];
  else if (parts[0] === "v2" && parts.length === 5) [, kid, iv, tag, ct] = parts;
  else throw new Error("Unsupported ciphertext envelope");
  const key = ring.keys.get(kid);
  if (!key) throw new Error(`Encryption key ${kid} is not configured`);
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  if (aad) decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Keyed hash for pseudonymising identifiers (IPs, emails, API keys). */
export const hmac = (s: string, purpose = "generic") => createHmac("sha256", hashKey()).update(`${purpose}:${s}`).digest("hex");

export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

// ── Passwords: scrypt (N=2^15, r=8, p=1) ────────────────────────────────
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const dk = await scrypt(password.normalize("NFKC"), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString("base64")}$${dk.toString("base64")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !salt || !hash) return false;
  try {
    const expected = Buffer.from(hash, "base64");
    const dk = await scrypt(password.normalize("NFKC"), Buffer.from(salt, "base64"), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: SCRYPT.maxmem,
    });
    return timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}
