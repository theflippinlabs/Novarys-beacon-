import { and, desc, eq, sql } from "drizzle-orm";
import { systemDb, withOrg } from "@/db";
import { redactErrorText } from "@/lib/security/redact";
import { jobs } from "@/db/schema";

export type Job = typeof jobs.$inferSelect;
/** Passed to every handler: `heartbeat()` keeps a long job from being reclaimed as stale. */
export type JobContext = { heartbeat: () => Promise<void> };

export const JOB_TYPES = [
  "seo.audit",
  "discovery.plan",
  "queries.generate",
  "content.generate",
  "ai_visibility.run",
  "integration.sync",
  "search.backfill",
  "opportunities.generate",
  "score.compute",
  "autopilot.report",
  "autopilot.identify",
  "recommendation.measure",
  "product.analyze",
  "maintenance.cleanup",
  "sources.check",
  "briefing.generate",
  "reports.generate",
  "notifications.evaluate",
  "notifications.deliver",
] as const;
export type JobType = (typeof JOB_TYPES)[number];

/**
 * Idempotency keys are scoped by organisation, so a tenant can never pre-empt
 * (or observe) another tenant's job by guessing its key.
 */
export function scopedIdempotencyKey(organizationId: string | null | undefined, key: string | undefined): string | undefined {
  if (!key) return undefined;
  return `${organizationId ?? "system"}:${key}`;
}

/**
 * Enqueue a job. With an idempotency key, enqueuing the same logical work
 * twice returns the existing job instead of creating a duplicate. Runs on the
 * system role: the queue is shared infrastructure; tenants read their own
 * jobs through RLS (`withOrg`).
 */
export async function enqueue(type: JobType, payload: Record<string, unknown>, opts: { organizationId?: string | null; idempotencyKey?: string; runAt?: Date; maxAttempts?: number } = {}): Promise<Job> {
  const key = scopedIdempotencyKey(opts.organizationId, opts.idempotencyKey);
  const [created] = await systemDb()
    .insert(jobs)
    .values({ type, payload, organizationId: opts.organizationId ?? null, idempotencyKey: key, runAt: opts.runAt ?? new Date(), maxAttempts: opts.maxAttempts ?? 5 })
    .onConflictDoNothing({ target: jobs.idempotencyKey })
    .returning();
  if (created) return created;
  const existing = await systemDb().query.jobs.findFirst({ where: eq(jobs.idempotencyKey, key!) });
  if (!existing) throw new Error("Job enqueue conflict without existing job");
  return existing;
}

/** Atomically claim the next due job (SKIP LOCKED makes concurrent workers safe). */
export async function claimNext(workerId: string, types?: readonly string[]): Promise<Job | null> {
  const typeFilter = types?.length ? sql`and type in (${sql.join(types.map((t) => sql`${t}`), sql`, `)})` : sql``;
  const res = await systemDb().execute(sql`
    update jobs set status = 'RUNNING', locked_at = now(), heartbeat_at = now(), locked_by = ${workerId}, attempts = attempts + 1, started_at = now()
    where id = (
      select id from jobs where status = 'QUEUED' and run_at <= now() ${typeFilter}
      order by run_at asc limit 1 for update skip locked
    )
    returning *`);
  const row = res.rows[0] as Record<string, unknown> | undefined;
  if (!row) return null;
  return systemDb().query.jobs.findFirst({ where: eq(jobs.id, row.id as string) }) as Promise<Job>;
}

/**
 * Record that a running job is still alive. Long handlers call this from
 * their progress callbacks; stale recovery only reclaims jobs whose heartbeat
 * stopped. Returns false when the job is no longer owned by `workerId`.
 */
export async function heartbeatJob(id: string, workerId: string): Promise<boolean> {
  const res = await systemDb().execute(sql`update jobs set heartbeat_at = now() where id = ${id} and locked_by = ${workerId} and status = 'RUNNING'`);
  return (res.rowCount ?? 0) > 0;
}

/** Throttled heartbeat for a handler's job context (at most one write per `minIntervalMs`). */
export function heartbeater(job: Pick<Job, "id" | "lockedBy">, minIntervalMs = 15_000): () => Promise<void> {
  let last = 0;
  return async () => {
    if (!job.lockedBy || Date.now() - last < minIntervalMs) return;
    last = Date.now();
    await heartbeatJob(job.id, job.lockedBy);
  };
}

/** Mark a job done. Only the worker holding the lock may complete it; returns false otherwise. */
export async function completeJob(id: string, result: unknown, workerId?: string | null): Promise<boolean> {
  const owner = workerId ? sql`and locked_by = ${workerId}` : sql``;
  const res = await systemDb().execute(sql`
    update jobs set status = 'SUCCEEDED', result = ${JSON.stringify(result ?? null)}::jsonb, finished_at = now(), locked_at = null, last_error = null
    where id = ${id} and status = 'RUNNING' ${owner}`);
  return (res.rowCount ?? 0) > 0;
}

/** Exponential backoff with jitter: 30s, 60s, 120s … capped at 1h. */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(3_600_000, 30_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.8 + random() * 0.4));
}

export async function failJob(job: Job, error: unknown, opts: { retryable?: boolean } = {}) {
  const message = error instanceof Error ? error.message : String(error);
  const dead = opts.retryable === false || job.attempts >= job.maxAttempts;
  const owner = job.lockedBy ? and(eq(jobs.id, job.id), eq(jobs.lockedBy, job.lockedBy), eq(jobs.status, "RUNNING")) : eq(jobs.id, job.id);
  await systemDb()
    .update(jobs)
    .set({
      status: dead ? "DEAD" : "QUEUED",
      lastError: redactErrorText(message, 2000),
      lockedAt: null,
      lockedBy: null,
      runAt: dead ? job.runAt : new Date(Date.now() + backoffMs(job.attempts)),
      finishedAt: dead ? new Date() : null,
    })
    .where(owner);
  return dead;
}

/**
 * Return jobs whose worker died mid-run to the queue: RUNNING jobs whose last
 * heartbeat (or lock, for jobs that never beat) is older than the threshold.
 * Jobs that already used all their attempts are marked DEAD instead of being
 * retried forever.
 */
export async function recoverStaleJobs(staleAfterMinutes = 15) {
  const stale = sql`status = 'RUNNING' and coalesce(heartbeat_at, locked_at) < now() - make_interval(mins => ${staleAfterMinutes})`;
  const dead = await systemDb().execute(sql`
    update jobs set status = 'DEAD', locked_at = null, locked_by = null, finished_at = now(),
      last_error = coalesce(last_error, '') || ' [stale lock, attempts exhausted]'
    where ${stale} and attempts >= max_attempts`);
  const requeued = await systemDb().execute(sql`
    update jobs set status = 'QUEUED', locked_at = null, locked_by = null, heartbeat_at = null,
      last_error = coalesce(last_error, '') || ' [recovered from stale lock]'
    where ${stale} and attempts < max_attempts`);
  return (requeued.rowCount ?? 0) + (dead.rowCount ?? 0);
}

/** Retention: delete finished (SUCCEEDED / CANCELLED) jobs older than `days`. DEAD jobs stay for inspection. */
export async function purgeFinishedJobs(days = 30) {
  const res = await systemDb().execute(sql`delete from jobs where status in ('SUCCEEDED','CANCELLED') and coalesce(finished_at, created_at) < now() - make_interval(days => ${days})`);
  return res.rowCount ?? 0;
}

/** Re-queue a tenant's job (RLS-scoped: another organisation's job id matches nothing). */
export async function retryJob(organizationId: string, id: string) {
  await withOrg(organizationId, (tx) =>
    tx
      .update(jobs)
      .set({ status: "QUEUED", runAt: new Date(), attempts: 0, lastError: null, finishedAt: null })
      .where(and(eq(jobs.id, id), eq(jobs.organizationId, organizationId), sql`${jobs.status} <> 'RUNNING'`)),
  );
}

export async function recentJobs(organizationId: string, limit = 50) {
  return withOrg(organizationId, (tx) => tx.select().from(jobs).where(eq(jobs.organizationId, organizationId)).orderBy(desc(jobs.createdAt)).limit(limit));
}

export class NonRetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableError";
  }
}
