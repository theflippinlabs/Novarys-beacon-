import { assertDatabaseRoles } from "@/db";
import { env } from "@/lib/env";
import { log } from "@/lib/logger";

/** True while `next build` runs (no request-time environment exists then). */
export const isBuildPhase = () => process.env.NEXT_PHASE === "phase-production-build" || process.env.npm_lifecycle_event === "build";

/**
 * Boot checks shared by the web server (instrumentation) and the worker:
 * validate the environment eagerly and, in production, refuse to start when
 * the database role would bypass row-level security. Throws on failure; the
 * caller lets the process exit non-zero.
 */
export async function startupChecks(component: "web" | "worker") {
  const e = env();
  if (e.NODE_ENV !== "production") return;
  await assertDatabaseRoles();
  log.info("startup.checks_passed", { component });
}

/** `startupChecks`, exiting the process with a clear message on failure. */
export async function startupChecksOrExit(component: "web" | "worker") {
  try {
    await startupChecks(component);
  } catch (e) {
    console.error(`[beacon] startup check failed: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}
