import { z } from "zod";

/**
 * Server-side environment. Never import this module from client components:
 * it contains secrets. `server-only` style enforcement is done by lint review
 * and by the fact that none of these names are prefixed NEXT_PUBLIC_.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_URL: z.string().min(1).default("postgres://beacon:beacon@localhost:5432/beacon"),
  BEACON_BASE_URL: z.string().url().default("http://localhost:3000"),
  BEACON_ENCRYPTION_KEY: z.string().optional(),
  BEACON_HASH_SECRET: z.string().optional(),
  BEACON_EMBEDDED_WORKER: z.enum(["true", "false"]).default("false"),
  BEACON_WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(2),
  ANTHROPIC_API_KEY: z.string().optional(),
  BEACON_ANTHROPIC_MODEL: z.string().default("claude-opus-5-5"),
  OPENAI_API_KEY: z.string().optional(),
  BEACON_OPENAI_MODEL: z.string().optional(),
  PERPLEXITY_API_KEY: z.string().optional(),
  BEACON_PERPLEXITY_MODEL: z.string().default("sonar"),
  BEACON_SSRF_ALLOW_PRIVATE: z.enum(["true", "false"]).default("false"),
  BEACON_ERROR_WEBHOOK_URL: z.string().optional(),
});

export type Env = z.infer<typeof schema>;

let cached: Env | undefined;

export function env(): Env {
  if (!cached) {
    const raw = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== ""));
    cached = schema.parse(raw);
    if (cached.NODE_ENV === "production") {
      if (!cached.BEACON_ENCRYPTION_KEY || !cached.BEACON_HASH_SECRET) {
        throw new Error("BEACON_ENCRYPTION_KEY and BEACON_HASH_SECRET are required in production");
      }
      if (cached.BEACON_SSRF_ALLOW_PRIVATE === "true") {
        throw new Error("BEACON_SSRF_ALLOW_PRIVATE must not be enabled in production");
      }
    }
  }
  return cached;
}

/** For tests only. */
export function resetEnvCache() {
  cached = undefined;
}
