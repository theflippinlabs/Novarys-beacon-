import { closeDb } from "@/db";
import { env } from "@/lib/env";
import { startupChecks } from "@/lib/startup";
import { drain, startWorker } from "./worker";

async function main() {
  await startupChecks("worker");
  if (process.argv.includes("--once")) {
    const n = await drain(1000);
    console.log(`processed ${n} job(s)`);
    await closeDb();
    return;
  }
  const w = startWorker({ concurrency: env().BEACON_WORKER_CONCURRENCY });
  const shutdown = async () => {
    await w.stop();
    await closeDb();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
