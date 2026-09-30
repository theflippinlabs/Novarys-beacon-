import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { jobs } from "@/db/schema";

export type Job = typeof jobs.$inferSelect;

export const JOB_TYPES = [
  "seo.audit",
  "discovery.plan",
  "queries.generate",
  "content.generate",
  "ai_visibility.run",
  "integration.sync",
  "opportunities.generate",
  "score.compute",
  "autopilot.report",
  "product.analyze",
  "metrics.rollup",
  "maintenance.cleanup",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/**
 * Enqueue a job. With an idempotency key, enqueuing the same logical work
 * twice returns the existing job instead of creating a duplicate.
 */
export async function enqueue(type: JobType, payload: Record<string, unknown>, opts: { organizationId?: string | null; idempotencyKey?: string; runAt?: Date; maxAttempts?: number } = {}): Promise<Job> {
  const [created] = await db()
    .insert(jobs)
    .values({ type, payload, organizationId: opts.organizationId ?? null, idempotencyKey: opts.idempotencyKey, runAt: opts.runAt ?? new Date(), maxAttempts: opts.maxAttempts ?? 5 })
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning();
  if (created) return created;
  const existing = await db().query.jobs.findFirst({ where: eq(jobs.idempotencyKey, opts.idempotencyKey!) });
  if (!existing) throw new Error("Job enqueue conflict without existing job");
  return existing;
}

/** Atomically claim the next due job (SKIP LOCKED makes concurrent workers safe). */
export async function claimNext(workerId: string, types?: readonly string[]): Promise<Job | null> {
  const typeFilter = types?.length ? sql`and type in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})` : sql``;
  const res = await db().execute(sql`
    update jobs set status = 'RUNNING', locked_at = now(), locked_by = ${workerId}, attempts = attempts + 1, started_at = now()
    where id = (
      select id from jobs where status = 'QUEUED' and run_at <= now() ${typeFilter}
      order by run_at asc limit 1 for update skip locked
    )
    returning *`);
  const row = res.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return db().query.jobs.findFirst({ where: eq(jobs.id, row.id as string) }) as Promise<Job>;
}

export async function completeJob(id: string, result: unknown) {
  await db().update(jobs).set({ status: "SUCCEEDED", result: result as object, finishedAt: new Date(), lockedAt: null, lastError: null }).where(eq(jobs.id, id));
}

/** Exponential backoff with jitter: 30s, 60s, 120s … capped at 1h. */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + random() * 0.4));
}

export async function failJob(job: Job, error: unknown, opts: { retryable?: boolean } = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const dead = opts.retryable === false || job.attempts >= job.maxAttempts;
  await db()
    .update(jobs)
    .set({
      status: dead ? "DEAD" : "QUEUED",
      lastError: message.slice(0, 2000),
      lockedAt: null,
      lockedBy: null,
      runAt: dead ? job.runAt : new Date(Date.now() + backoffMs(job.attempts)),
      finishedAt: dead ? new Date() : null,
    })
    .where(eq(jobs.id, job.id));
  return dead;
}

/** Return jobs whose worker died mid-run to the queue. */
export async function recoverStaleJobs(staleAfterMinutes = 15) {
  const res = await db().execute(sql`
    update jobs set status = 'QUEUED', locked_at = null, locked_by = null, last_error = coalesce(last_error, '') || ' [recovered from stale lock]'
    where status = 'RUNNING' and locked_at < now() - make_interval(mins => ${staleAfterMinutes})`);
  return res.rowCount ?? 0;
}

export async function retryJob(organizationId: string, id: string) {
  await db()
    .update(jobs)
    .set({ status: "QUEUED", runAt: new Date(), attempts: 0, lastError: null, finishedAt: null })
    .where(and(eq(jobs.id, id), eq(jobs.organizationId, organizationId)));
}

export async function recentJobs(organizationId: string, limit = 50) {
  return db().select().from(jobs).where(eq(jobs.organizationId, organizationId)).orderBy(desc(jobs.createdAt)).limit(limit);
}

export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}
