/**
 * Server start hook. In production it validates the environment and refuses
 * to start (exit 1) when the database role could bypass row-level security.
 * Optionally runs the job worker in-process for single-container deployments
 * (BEACON_EMBEDDED_WORKER=true); at scale run `pnpm worker` separately.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { isBuildPhase, startupChecksOrExit } = await import("./lib/startup");
  if (isBuildPhase()) return;
  await startupChecksOrExit("web");
  if (process.env.BEACON_EMBEDDED_WORKER === "true") {
    const { startWorker } = await import("./jobs/worker");
    startWorker({ concurrency: Number(process.env.BEACON_WORKER_CONCURRENCY ?? 2) });
  }
}
