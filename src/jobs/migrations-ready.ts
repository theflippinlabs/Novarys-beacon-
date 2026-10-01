import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import { db } from "@/db";
import { log } from "@/lib/logger";

/** Number of migrations this build ships (the Drizzle journal next to the SQL files). */
export function expectedMigrations(): number {
  const journal = JSON.parse(readFileSync(new URL("../db/migrations/meta/_journal.json", import.meta.url), "utf8")) as { entries: unknown[] };
  return journal.entries.length;
}

/** Migrations recorded as applied in the database (0 before the first migration run). */
export async function appliedMigrations(): Promise<number> {
  try {
    return Number((await db().execute<{ n: number }>(sql`select count(*)::int as n from drizzle.__drizzle_migrations`)).rows[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * The worker and the web service deploy in parallel, and only the web
 * service's pre-deploy step migrates. Wait until the database has every
 * migration of this build so the worker never queries columns that do not
 * exist yet.
 */
export async function waitForMigrations({ intervalMs = 2000, logEveryMs = 30_000 } = {}) {
  const expected = expectedMigrations();
  let lastLog = 0;
  for (;;) {
    const applied = await appliedMigrations();
    if (applied >= expected) return;
    if (Date.now() - lastLog >= logEveryMs) {
      log.info("worker.waiting_for_migrations", { applied, expected });
      lastLog = Date.now();
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
