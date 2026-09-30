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

const encKey = () => keyMaterial(env().BEACON_ENCRYPTION_KEY, "BEACON_ENCRYPTION_KEY");
const hashKey = () => keyMaterial(env().BEACON_HASH_SECRET, "BEACON_HASH_SECRET");

/** AES-256-GCM authenticated encryption for provider credentials. */
export function encryptSecret(plaintext: string, aad = ""): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encKey(), iv);
  if (aad) cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), ct.toString("base64")].join(":");
}

export function decryptSecret(envelope: string, aad = ""): string {
  const [v, iv, tag, ct] = envelope.split(":");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unsupported ciphertext envelope");
  const decipher = createDecipheriv("aes-256-gcm", encKey(), Buffer.from(iv, "base64"));
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
  const expected = Buffer.from(hash, "base64");
  const dk = await scrypt(password.normalize("NFKC"), Buffer.from(salt, "base64"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: SCRYPT.maxmem,
  });
  return timingSafeEqual(dk, expected);
}
