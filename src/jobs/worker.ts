import { hostname } from "node:os";
import { randomUUID } from "node:crypto";
import { log, reportError } from "@/lib/logger";
import { claimNext, completeJob, failJob, NonRetryableError, recoverStaleJobs } from "./queue";
import { HANDLERS, scheduleRecurring } from "./handlers";
import { recordJobMetric } from "@/lib/metrics";

export type WorkerHandle = { stop: () => Promise<void>; id: string };

/** Process one job if available. Returns true when a job was processed. */
export async function processOne(workerId: string): Promise<boolean> {
  const job = await claimNext(workerId);
  if (!job) return false;
  const t0 = Date.now();
  const handler = HANDLERS[job.type as keyof typeof HANDLERS];
  try {
    if (!handler) throw new NonRetryableError(`Unknown job type ${job.type}`);
    const result = await handler(job);
    await completeJob(job.id, result ?? null);
    recordJobMetric(job.type, "SUCCEEDED", Date.now() - t0);
    log.info("job.succeeded", { jobId: job.id, type: job.type, ms: Date.now() - t0 });
  } catch (e) {
    const dead = await failJob(job, e, { retryable: !(e instanceof NonRetryableError) });
    recordJobMetric(job.type, dead ? "DEAD" : "FAILED", Date.now() - t0);
    log.warn("job.failed", { jobId: job.id, type: job.type, attempt: job.attempts, dead, err: (e as Error).message });
    if (dead) reportError(e, { jobId: job.id, type: job.type });
  }
  return true;
}

/** Drain the queue synchronously (used by tests and the CLI `--once`). */
export async function drain(max = 100) {
  const id = `drain-${randomUUID().slice(0, 8)}`;
  let n = 0;
  while (n < max && (await processOne(id))) n++;
  return n;
}

export function startWorker(opts: { concurrency?: number; pollMs?: number; schedule?: boolean } = {}): WorkerHandle {
  const id = `${hostname()}-${process.pid}-${randomUUID().slice(0, 6)}`;
  const concurrency = opts.concurrency ?? 2;
  const pollMs = opts.pollMs ?? 2000;
  let stopped = false;
  const loops: Promise<void>[] = [];

  for (let i = 0; i < concurrency; i++) {
    loops.push(
      (async () => {
        while (!stopped) {
          try {
            const did = await processOne(`${id}#${i}`);
            if (!did) await new Promise((r) => setTimeout(r, pollMs));
          } catch (e) {
            reportError(e, { worker: id });
            await new Promise((r) => setTimeout(r, pollMs * 2));
          }
        }
      })(),
    );
  }

  const tick = async () => {
    try {
      await recoverStaleJobs();
      if (opts.schedule !== false) await scheduleRecurring();
    } catch (e) {
      reportError(e, { worker: id, phase: "schedule" });
    }
  };
  void tick();
  const timer = setInterval(tick, 5 * 60_000);
  log.info("worker.started", { id, concurrency });

  return {
    id,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      await Promise.all(loops);
      log.info("worker.stopped", { id });
    },
  };
}
