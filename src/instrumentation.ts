/**
 * Optional in-process worker for single-container deployments
 * (BEACON_EMBEDDED_WORKER=true). For production at scale, run `pnpm worker`
 * as a separate process instead.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs" && process.env.BEACON_EMBEDDED_WORKER === "true") {
    const { startWorker } = await import("./jobs/worker");
    startWorker({ concurrency: Number(process.env.BEACON_WORKER_CONCURRENCY ?? 2) });
  }
}
