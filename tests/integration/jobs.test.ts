import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { closeDb, db, systemDb, withOrg } from "@/db";
import { beaconScores, jobs, opportunities, queries } from "@/db/schema";
import { claimNext, completeJob, enqueue, failJob, heartbeatJob, NonRetryableError, purgeFinishedJobs, recoverStaleJobs, scopedIdempotencyKey, type Job, type JobType } from "@/jobs/queue";
import { drain, processOne } from "@/jobs/worker";
import { newOrg, seedCompleteProduct, uid } from "./helpers";

/** A job type with no handler: only used for queue mechanics (never processed here). */
const NOOP = "test.noop" as JobType;

let ctx: Awaited<ReturnType<typeof newOrg>>;
let orgId: string;

const getJob = async (id: string) => (await systemDb().query.jobs.findFirst({ where: eq(jobs.id, id) }))!;
const makeDue = (id: string) => systemDb().update(jobs).set({ runAt: new Date(Date.now() - 1000) }).where(eq(jobs.id, id));

beforeAll(async () => {
  ctx = await newOrg("jobs");
  orgId = ctx.org.id;
});
// The queue is shared (the worker sees every job): park anything left runnable so each test owns the queue.
beforeEach(async () => {
  await systemDb().update(jobs).set({ status: "CANCELLED" }).where(inArray(jobs.status, ["QUEUED", "RUNNING"]));
});
afterAll(closeDb);

describe("job queue", () => {
  it("enqueue with the same idempotency key returns the same job", async () => {
    const key = `idem-${uid()}`;
    const a = await enqueue(NOOP, { n: 1 }, { organizationId: orgId, idempotencyKey: key });
    const b = await enqueue(NOOP, { n: 2 }, { organizationId: orgId, idempotencyKey: key });
    expect(b.id).toBe(a.id);
    expect(b.payload).toEqual({ n: 1 });
    const rows = await systemDb().select().from(jobs).where(eq(jobs.idempotencyKey, scopedIdempotencyKey(orgId, key)!));
    expect(rows).toHaveLength(1);
    // Without a key every enqueue creates a new job.
    const c = await enqueue(NOOP, {}, { organizationId: orgId });
    const d = await enqueue(NOOP, {}, { organizationId: orgId });
    expect(c.id).not.toBe(d.id);
  });

  it("claimNext claims due jobs exactly once and skips future ones", async () => {
    const future = await enqueue(NOOP, {}, { organizationId: orgId, runAt: new Date(Date.now() + 3_600_000) });
    const due = await enqueue(NOOP, {}, { organizationId: orgId });
    const claimed = await claimNext("worker-a");
    expect(claimed!.id).toBe(due.id);
    expect(claimed).toMatchObject({ status: "RUNNING", attempts: 1, lockedBy: "worker-a" });
    expect(claimed!.lockedAt).toBeInstanceOf(Date);
    expect(await claimNext("worker-b")).toBeNull();
    expect((await getJob(future.id)).status).toBe("QUEUED");
    // Type filter.
    const other = await enqueue("maintenance.cleanup", {}, {});
    expect(await claimNext("worker-c", [NOOP])).toBeNull();
    expect((await claimNext("worker-c", ["maintenance.cleanup"]))!.id).toBe(other.id);
  });

  it("concurrent claimers never get the same job (SKIP LOCKED)", async () => {
    const created = await Promise.all(Array.from({ length: 6 }, () => enqueue(NOOP, {}, { organizationId: orgId })));
    const claims = await Promise.all(Array.from({ length: 10 }, (_, i) => claimNext(`w${i}`)));
    const ids = claims.filter((c): c is Job => Boolean(c)).map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.sort()).toEqual(created.map((c) => c.id).sort());
  });

  it("failJob retries with backoff (QUEUED, runAt in the future) and goes DEAD after maxAttempts", async () => {
    const j = await enqueue(NOOP, {}, { organizationId: orgId, maxAttempts: 3 });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await makeDue(j.id);
      const c = (await claimNext("retry-worker"))!;
      expect(c.id).toBe(j.id);
      expect(c.attempts).toBe(attempt);
      const before = Date.now();
      const dead = await failJob(c, new Error(`boom ${attempt}`));
      const row = await getJob(j.id);
      expect(row.lastError).toBe(`boom ${attempt}`);
      expect(row.lockedAt).toBeNull();
      expect(row.lockedBy).toBeNull();
      if (attempt < 3) {
        expect(dead).toBe(false);
        expect(row.status).toBe("QUEUED");
        const minDelay = 30_000 * 2 ** (attempt - 1) * 0.8;
        expect(row.runAt.getTime()).toBeGreaterThanOrEqual(before + minDelay - 1000);
        expect(row.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 30_000 * 2 ** (attempt - 1) * 1.2 + 1000);
        expect(row.finishedAt).toBeNull();
        expect(await claimNext("retry-worker")).toBeNull(); // not due yet
      } else {
        expect(dead).toBe(true);
        expect(row.status).toBe("DEAD");
        expect(row.finishedAt).toBeInstanceOf(Date);
      }
    }
  });

  it("a NonRetryableError kills the job on the first attempt", async () => {
    // Explicit non-retryable failure.
    const j = await enqueue(NOOP, {}, { organizationId: orgId, maxAttempts: 5 });
    const c = (await claimNext("nr"))!;
    expect(await failJob(c, new NonRetryableError("bad input"), { retryable: false })).toBe(true);
    expect((await getJob(j.id)).status).toBe("DEAD");

    // Through the worker: a handler that throws NonRetryableError (missing payload.productId).
    const k = await enqueue("product.analyze", {}, { organizationId: orgId, maxAttempts: 5 });
    expect(await processOne("nr-worker")).toBe(true);
    expect(await getJob(k.id)).toMatchObject({ status: "DEAD", attempts: 1, lastError: "Missing payload.productId" });

    // Unknown job type.
    const u = await enqueue("does.not.exist" as JobType, {}, { organizationId: orgId });
    await processOne("nr-worker");
    expect(await getJob(u.id)).toMatchObject({ status: "DEAD", lastError: "Unknown job type does.not.exist" });

    // A job without an organisation for an org-scoped handler.
    const o = await enqueue("score.compute", {}, {});
    await processOne("nr-worker");
    expect(await getJob(o.id)).toMatchObject({ status: "DEAD", lastError: "Job has no organization" });
  });

  it("a retryable handler error leaves the job QUEUED for a later attempt", async () => {
    const j = await enqueue("product.analyze", { productId: "00000000-0000-4000-8000-000000000000" }, { organizationId: orgId, maxAttempts: 5 });
    await processOne("retry");
    const row = await getJob(j.id);
    expect(row).toMatchObject({ status: "QUEUED", attempts: 1, lastError: "Product not found" });
    expect(row.runAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("recoverStaleJobs requeues RUNNING jobs whose lock is stale, but not fresh ones", async () => {
    const stale = await enqueue(NOOP, {}, { organizationId: orgId });
    const fresh = await enqueue(NOOP, {}, { organizationId: orgId });
    await systemDb().update(jobs).set({ status: "RUNNING", lockedAt: new Date(Date.now() - 20 * 60_000), lockedBy: "dead-worker" }).where(eq(jobs.id, stale.id));
    await systemDb().update(jobs).set({ status: "RUNNING", lockedAt: new Date(), lockedBy: "live-worker" }).where(eq(jobs.id, fresh.id));
    expect(await recoverStaleJobs(15)).toBe(1);
    const s = await getJob(stale.id);
    expect(s).toMatchObject({ status: "QUEUED", lockedAt: null, lockedBy: null });
    expect(s.lastError).toContain("[recovered from stale lock]");
    expect((await getJob(fresh.id)).status).toBe("RUNNING");
  });

  it("drain() runs product.analyze end-to-end, including the follow-up opportunity and score jobs", async () => {
    const { product } = await seedCompleteProduct(orgId, { name: `Drain Product ${uid()}` });
    const job = await enqueue("product.analyze", { productId: product.id }, { organizationId: orgId, idempotencyKey: `analyze:${product.id}` });
    const processed = await drain();
    expect(processed).toBe(3);
    const done = await getJob(job.id);
    expect(done.status).toBe("SUCCEEDED");
    expect(done.finishedAt).toBeInstanceOf(Date);
    expect(done.result).toMatchObject({ pages: { planned: expect.any(Number) }, distributionSuggested: expect.any(Number) });
    expect((done.result as { distributionSuggested: number }).distributionSuggested).toBeGreaterThan(0);

    const followUps = await systemDb().select().from(jobs).where(inArray(jobs.idempotencyKey, [`${orgId}:opps:${product.id}:${job.id}`, `${orgId}:score:${product.id}:${job.id}`]));
    expect(followUps.map((f) => [f.type, f.status]).sort()).toEqual([
      ["opportunities.generate", "SUCCEEDED"],
      ["score.compute", "SUCCEEDED"],
    ]);

    const [qs, opps, scores] = await withOrg(orgId, async (tx) => [
      await tx.select().from(queries).where(eq(queries.productId, product.id)),
      await tx.select().from(opportunities).where(eq(opportunities.productId, product.id)),
      await tx.select().from(beaconScores).where(eq(beaconScores.productId, product.id)),
    ] as const);
    expect(qs.length).toBeGreaterThan(0);
    expect(opps.length).toBeGreaterThan(0);
    expect(scores).toHaveLength(1);
    const scoreResult = followUps.find((f) => f.type === "score.compute")!.result as Record<string, number>;
    expect(scoreResult[product.id]).toBe(scores[0].total);
    // Nothing left to do.
    expect(await drain()).toBe(0);
    const r = await systemDb().execute<{ n: number }>(sql`select count(*)::int as n from jobs where status = 'QUEUED' and run_at <= now()`);
    expect(r.rows[0].n).toBe(0);
  });

  it("scopes idempotency keys by organisation: another tenant cannot pre-empt a job", async () => {
    const other = await newOrg("jobs-b");
    const key = `audit:${uid()}`;
    const mine = await enqueue(NOOP, { who: "a" }, { organizationId: orgId, idempotencyKey: key });
    const theirs = await enqueue(NOOP, { who: "b" }, { organizationId: other.org.id, idempotencyKey: key });
    expect(theirs.id).not.toBe(mine.id);
    expect(mine.idempotencyKey).toBe(`${orgId}:${key}`);
    expect(theirs.payload).toEqual({ who: "b" });
  });

  it("jobs are tenant-scoped by RLS: withOrg sees only its own, the app role sees none raw", async () => {
    const other = await newOrg("jobs-c");
    const mine = await enqueue(NOOP, {}, { organizationId: orgId });
    const theirs = await enqueue(NOOP, {}, { organizationId: other.org.id });
    const sys = await enqueue(NOOP, {}, {});
    const seen = (await withOrg(orgId, (tx) => tx.select({ id: jobs.id }).from(jobs))).map((r) => r.id);
    expect(seen).toContain(mine.id);
    expect(seen).not.toContain(theirs.id);
    expect(seen).not.toContain(sys.id);
    expect(await db().select().from(jobs)).toHaveLength(0);
    const upd = await withOrg(orgId, (tx) => tx.update(jobs).set({ status: "CANCELLED" }).where(eq(jobs.id, theirs.id)).returning());
    expect(upd).toHaveLength(0);
  });

  it("heartbeats keep a long job alive; recovery uses the heartbeat and kills exhausted jobs", async () => {
    const live = await enqueue(NOOP, {}, { organizationId: orgId });
    const c = (await claimNext("hb-worker"))!;
    expect(c.id).toBe(live.id);
    expect(c.heartbeatAt).toBeInstanceOf(Date);
    // Locked long ago but heartbeating now: not stale.
    await systemDb().update(jobs).set({ lockedAt: new Date(Date.now() - 60 * 60_000), heartbeatAt: new Date(Date.now() - 60 * 60_000) }).where(eq(jobs.id, live.id));
    expect(await heartbeatJob(live.id, "hb-worker")).toBe(true);
    expect(await heartbeatJob(live.id, "someone-else")).toBe(false);
    expect(await recoverStaleJobs(15)).toBe(0);
    // An exhausted stale job goes DEAD instead of looping forever.
    const exhausted = await enqueue(NOOP, {}, { organizationId: orgId, maxAttempts: 2 });
    await systemDb().update(jobs).set({ status: "RUNNING", attempts: 2, lockedBy: "gone", lockedAt: new Date(Date.now() - 30 * 60_000), heartbeatAt: new Date(Date.now() - 30 * 60_000) }).where(eq(jobs.id, exhausted.id));
    expect(await recoverStaleJobs(15)).toBe(1);
    expect((await getJob(exhausted.id)).status).toBe("DEAD");
  });

  it("only the lock owner can complete or fail a job", async () => {
    const j = await enqueue(NOOP, {}, { organizationId: orgId });
    const c = (await claimNext("owner"))!;
    expect(await completeJob(j.id, { x: 1 }, "intruder")).toBe(false);
    expect((await getJob(j.id)).status).toBe("RUNNING");
    await failJob({ ...c, lockedBy: "intruder" }, new Error("nope"));
    expect((await getJob(j.id)).status).toBe("RUNNING");
    expect(await completeJob(j.id, { x: 1 }, "owner")).toBe(true);
    expect(await getJob(j.id)).toMatchObject({ status: "SUCCEEDED", result: { x: 1 } });
  });

  it("purgeFinishedJobs deletes old SUCCEEDED/CANCELLED jobs only", async () => {
    const old = await enqueue(NOOP, {}, { organizationId: orgId });
    const recent = await enqueue(NOOP, {}, { organizationId: orgId });
    const dead = await enqueue(NOOP, {}, { organizationId: orgId });
    const longAgo = new Date(Date.now() - 40 * 86_400_000);
    await systemDb().update(jobs).set({ status: "SUCCEEDED", finishedAt: longAgo }).where(eq(jobs.id, old.id));
    await systemDb().update(jobs).set({ status: "SUCCEEDED", finishedAt: new Date() }).where(eq(jobs.id, recent.id));
    await systemDb().update(jobs).set({ status: "DEAD", finishedAt: longAgo }).where(eq(jobs.id, dead.id));
    expect(await purgeFinishedJobs(30)).toBeGreaterThanOrEqual(1);
    expect(await systemDb().query.jobs.findFirst({ where: eq(jobs.id, old.id) })).toBeUndefined();
    expect(await getJob(recent.id)).toBeDefined();
    expect(await getJob(dead.id)).toBeDefined();
  });
});
