import { sql } from "drizzle-orm";
import { db } from "@/db";

/** Infrastructure health (no tenant data). */
export async function systemHealth() {
  const t0 = Date.now();
  let dbOk = true;
  let migrations = 0;
  try {
    await db().execute(sql`select 1`);
    migrations = Number((await db().execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)).rows[0]?.n ?? 0);
  } catch {
    dbOk = false;
  }
  const dbLatencyMs = Date.now() - t0;
  const queue = dbOk
    ? (
        await db().execute<{ queued: number; running: number; dead_24h: number; failed_retrying: number; oldest_queued_s: number | null; last_started: string | null }>(sql`
      select count(*) filter (where status = 'QUEUED' and run_at <= now())::int as queued,
        count(*) filter (where status = 'RUNNING')::int as running,
        count(*) filter (where status = 'DEAD' and finished_at >= now() - interval '24 hours')::int as dead_24h,
        count(*) filter (where status = 'QUEUED' and attempts > 0)::int as failed_retrying,
        extract(epoch from now() - min(run_at) filter (where status = 'QUEUED' and run_at <= now()))::int as oldest_queued_s,
        max(started_at)::text as last_started
      from jobs`)
      ).rows[0]
    : null;
  const workerStale = queue ? (queue.oldest_queued_s ?? 0) > 600 : true;
  return {
    status: dbOk && !workerStale ? "ok" : dbOk ? "degraded" : "down",
    db: { ok: dbOk, latencyMs: dbLatencyMs, migrations },
    queue: queue ? { queued: Number(queue.queued), running: Number(queue.running), dead24h: Number(queue.dead_24h), retrying: Number(queue.failed_retrying), oldestQueuedSeconds: queue.oldest_queued_s, lastJobStartedAt: queue.last_started, workerStale } : null,
    time: new Date().toISOString(),
  };
}
