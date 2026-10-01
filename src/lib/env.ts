import { z } from "zod";

/**
 * Server-side environment. Never import this module from client components:
 * it contains secrets. `server-only` style enforcement is done by lint review
 * and by the fact that none of these names are prefixed NEXT_PUBLIC_.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  /** Application role (NOSUPERUSER, NOBYPASSRLS). The localhost default applies outside production only. */
  DATABASE_URL: z.string().min(1).optional(),
  /** BYPASSRLS system role used by `asSystem`; derived from DATABASE_URL + BEACON_DB_SYSTEM_* when unset. */
  DATABASE_SYSTEM_URL: z.string().min(1).optional(),
  BEACON_DB_SYSTEM_USER: z.string().regex(/^[a-z_][a-z0-9_]{0,62}$/).optional(),
  BEACON_DB_SYSTEM_PASSWORD: z.string().optional(),
  BEACON_BASE_URL: z.string().url().optional(),
  /** Legacy single key (envelope key id "v1"). */
  BEACON_ENCRYPTION_KEY: z.string().optional(),
  /** Key ring "kid:base64key,kid2:base64key2"; the first entry encrypts, all entries decrypt. */
  BEACON_ENCRYPTION_KEYS: z.string().optional(),
  BEACON_HASH_SECRET: z.string().optional(),
  /** Number of trusted reverse proxies in front of the app that append to X-Forwarded-For (Railway: 1). */
  BEACON_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(1),
  /** Optional secret that unlocks the detailed /api/health output via the x-beacon-health-secret header. */
  BEACON_HEALTH_SECRET: z.string().optional(),
  /** Beacon agent: default monthly token cap per organisation (input + output tokens; 0 = no cap). Organisations can override it in Settings. */
  BEACON_AGENT_MONTHLY_TOKEN_CAP: z.coerce.number().int().min(0).default(20_000_000),
  BEACON_EMBEDDED_WORKER: z.enum(["true", "false"]).default("false"),
  BEACON_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  ANTHROPIC_API_KEY: z.string().optional(),
  BEACON_ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  OPENAI_API_KEY: z.string().optional(),
  BEACON_OPENAI_MODEL: z.string().optional(),
  PERPLEXITY_API_KEY: z.string().optional(),
  BEACON_PERPLEXITY_MODEL: z.string().default("sonar"),
  /** Anthropic AI-visibility tests use the server-side web search tool (grounded answers with citations). Set "false" to sample ungrounded answers. */
  BEACON_ANTHROPIC_WEB_SEARCH: z.enum(["true", "false"]).default("true"),
  BEACON_SSRF_ALLOW_PRIVATE: z.enum(["true", "false"]).default("false"),
  BEACON_ERROR_WEBHOOK_URL: z.string().optional(),
  /** Google OAuth client for Search Console (optional; the service-account path works without it). */
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_OAUTH_CLIENT_SECRET: z.string().optional(),
  /** Email notifications through Resend's HTTPS API; both are required, otherwise the email channel shows "Not connected". */
  RESEND_API_KEY: z.string().optional(),
  BEACON_EMAIL_FROM: z.string().optional(),
  /**
   * S3-compatible object storage for uploaded media (a Railway Bucket in production).
   * Endpoint, bucket, access key id and secret are set together or not at all;
   * when none is set, media bytes stay in PostgreSQL.
   */
  BEACON_MEDIA_S3_ENDPOINT: z.string().url().optional(),
  BEACON_MEDIA_S3_BUCKET: z.string().optional(),
  BEACON_MEDIA_S3_REGION: z.string().default("auto"),
  BEACON_MEDIA_S3_ACCESS_KEY_ID: z.string().optional(),
  BEACON_MEDIA_S3_SECRET_ACCESS_KEY: z.string().optional(),
  /** "true" for path-style URLs (endpoint/bucket/key, e.g. MinIO); Railway Buckets use virtual-hosted style (the default). */
  BEACON_MEDIA_S3_FORCE_PATH_STYLE: z.enum(["true", "false"]).default("false"),
});

type Parsed = z.infer<typeof schema>;
export type Env = Omit<Parsed, "DATABASE_URL" | "BEACON_BASE_URL"> & { DATABASE_URL: string; BEACON_BASE_URL: string };

const DEV_DATABASE_URL = "postgres://beacon:beacon@localhost:5432/beacon";
const DEV_BASE_URL = "http://localhost:3000";

/** A loopback base URL (local docker-compose) never faces the internet, so plain http is tolerated there. */
const isLoopbackUrl = (u: string) => /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(u);

const b64Len = (v: string) => Buffer.from(v, "base64").length;

/** The variables that must be set together for media object storage. */
export const MEDIA_S3_REQUIRED = ["BEACON_MEDIA_S3_ENDPOINT", "BEACON_MEDIA_S3_BUCKET", "BEACON_MEDIA_S3_ACCESS_KEY_ID", "BEACON_MEDIA_S3_SECRET_ACCESS_KEY"] as const;

export type MediaStorageConfig = { endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean };

/**
 * Media object storage settings: `config` when every required variable is set,
 * null when none is (PostgreSQL fallback). `problems` lists a partial or
 * invalid configuration (never the secret values).
 */
export function mediaStorageSettings(p: Pick<Parsed, (typeof MEDIA_S3_REQUIRED)[number] | "BEACON_MEDIA_S3_REGION" | "BEACON_MEDIA_S3_FORCE_PATH_STYLE" | "NODE_ENV">): { config: MediaStorageConfig | null; problems: string[] } {
  const missing = MEDIA_S3_REQUIRED.filter((k) => !p[k]);
  if (missing.length === MEDIA_S3_REQUIRED.length) return { config: null, problems: [] };
  if (missing.length) return { config: null, problems: [`media object storage is partially configured: set ${missing.join(", ")} (or unset every BEACON_MEDIA_S3_* variable)`] };
  const endpoint = p.BEACON_MEDIA_S3_ENDPOINT!;
  if (p.NODE_ENV === "production" && !endpoint.startsWith("https://") && !isLoopbackUrl(endpoint)) return { config: null, problems: ["BEACON_MEDIA_S3_ENDPOINT must be an https:// URL"] };
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(p.BEACON_MEDIA_S3_BUCKET!)) return { config: null, problems: ["BEACON_MEDIA_S3_BUCKET is not a valid bucket name"] };
  return {
    config: {
      endpoint,
      bucket: p.BEACON_MEDIA_S3_BUCKET!,
      region: p.BEACON_MEDIA_S3_REGION || "auto",
      accessKeyId: p.BEACON_MEDIA_S3_ACCESS_KEY_ID!,
      secretAccessKey: p.BEACON_MEDIA_S3_SECRET_ACCESS_KEY!,
      forcePathStyle: p.BEACON_MEDIA_S3_FORCE_PATH_STYLE === "true",
    },
    problems: [],
  };
}

/**
 * Production requirements, checked eagerly at boot (instrumentation and the
 * worker). Returns every problem at once so a deploy log lists them all.
 * BEACON_SETUP_TOKEN stays a runtime check (only needed while no user exists).
 */
export function productionEnvProblems(p: Parsed): string[] {
  const out: string[] = [];
  if (!p.DATABASE_URL) out.push("DATABASE_URL is required");
  if (!p.BEACON_BASE_URL) out.push("BEACON_BASE_URL is required");
  else if (!p.BEACON_BASE_URL.startsWith("https://") && !isLoopbackUrl(p.BEACON_BASE_URL)) out.push("BEACON_BASE_URL must be an https:// URL");
  if (!p.BEACON_ENCRYPTION_KEY && !p.BEACON_ENCRYPTION_KEYS) out.push("BEACON_ENCRYPTION_KEY or BEACON_ENCRYPTION_KEYS is required");
  if (p.BEACON_ENCRYPTION_KEY && b64Len(p.BEACON_ENCRYPTION_KEY) < 32) out.push("BEACON_ENCRYPTION_KEY must decode to at least 32 bytes (base64)");
  if (!p.BEACON_HASH_SECRET) out.push("BEACON_HASH_SECRET is required");
  else if (b64Len(p.BEACON_HASH_SECRET) < 32) out.push("BEACON_HASH_SECRET must decode to at least 32 bytes (base64)");
  if (!p.DATABASE_SYSTEM_URL && !p.BEACON_DB_SYSTEM_PASSWORD) out.push("DATABASE_SYSTEM_URL or BEACON_DB_SYSTEM_PASSWORD is required (system database role)");
  if (p.BEACON_SSRF_ALLOW_PRIVATE === "true") out.push("BEACON_SSRF_ALLOW_PRIVATE must not be enabled in production");
  out.push(...mediaStorageSettings(p).problems);
  return out;
}

/** Parse and validate an environment record (exported for tests). */
export function parseEnv(source: Record<string, string | undefined>): Env {
  const raw = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== "" && v !== undefined));
  const p = schema.parse(raw);
  if (p.NODE_ENV === "production") {
    const problems = productionEnvProblems(p);
    if (problems.length) throw new Error(`Invalid production environment: ${problems.join("; ")}`);
  }
  return { ...p, DATABASE_URL: p.DATABASE_URL ?? DEV_DATABASE_URL, BEACON_BASE_URL: p.BEACON_BASE_URL ?? DEV_BASE_URL };
}

let cached: Env | undefined;

export function env(): Env {
  if (!cached) cached = parseEnv(process.env);
  return cached;
}

/** For tests only. */
export function resetEnvCache() {
  cached = undefined;
}
