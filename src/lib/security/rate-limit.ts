import { sql } from "drizzle-orm";
import { db } from "@/db";

export type RateLimitResult = { allowed: boolean; remaining: number; resetAt: Date };

/**
 * Fixed-window rate limiter backed by Postgres so limits hold across
 * multiple web instances. `key` should already be pseudonymised (hashed IP…).
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<RateLimitResult> {
  const now = Date.now();
  const windowStart = new Date(Math.floor(now / (windowSeconds * 1000)) * windowSeconds * 1000);
  const res = await db().execute<{ count: number }>(sql`
    insert into rate_limit_buckets (key, window_start, count) values (${key}, ${windowStart.toISOString()}, 1)
    on conflict (key, window_start) do update set count = rate_limit_buckets.count + 1
    returning count`);
  const count = Number(res.rows[0]?.count ?? 1);
  return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt: new Date(windowStart.getTime() + windowSeconds * 1000) };
}

export async function purgeRateLimitBuckets(olderThanHours = 24) {
  await db().execute(sql`delete from rate_limit_buckets where window_start < now() - make_interval(hours => ${olderThanHours})`);
}
