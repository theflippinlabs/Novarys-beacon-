import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import * as schema from "./schema";

export type DB = NodePgDatabase<typeof schema>;
/** A transaction handle scoped to one tenant (RLS settings applied). */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

const globalForDb = globalThis as unknown as { beaconPool?: Pool; beaconDb?: DB };

export function pool(): Pool {
  if (!globalForDb.beaconPool) {
    globalForDb.beaconPool = new Pool({
      connectionString: env().DATABASE_URL,
      max: Number(process.env.DATABASE_POOL_MAX ?? 10),
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
    });
  }
  return globalForDb.beaconPool;
}

/**
 * Raw database handle. Tenant tables are protected by RLS, so queries against
 * them through this handle return nothing unless run inside `withOrg` or
 * `asSystem`: the system fails closed.
 */
export function db(): DB {
  if (!globalForDb.beaconDb) globalForDb.beaconDb = drizzle(pool(), { schema });
  return globalForDb.beaconDb;
}

/** Run `fn` in a transaction where RLS restricts rows to `organizationId`. */
export async function withOrg<T>(organizationId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(organizationId)) throw new Error("Invalid organization id");
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('beacon.org_id', ${organizationId}, true)`);
    return fn(tx);
  });
}

/**
 * Run `fn` with RLS bypassed. Reserved for trusted system code paths
 * (authentication lookups, the job worker's claim loop, public ingestion that
 * resolves the tenant from a hashed API key). Never pass user input here
 * without resolving the tenant first.
 */
export async function asSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db().transaction(async (tx) => {
    await tx.execute(sql`select set_config('beacon.bypass_rls', 'on', true)`);
    return fn(tx);
  });
}

export async function closeDb() {
  await globalForDb.beaconPool?.end();
  globalForDb.beaconPool = undefined;
  globalForDb.beaconDb = undefined;
}

export { schema };

/**
 * Run thunks one after another and return their results as a tuple. A
 * transaction is a single connection, so queries on it must not be issued
 * concurrently (pg deprecates concurrent client.query calls).
 */
export async function inSequence<const T extends readonly (() => Promise<unknown>)[]>(fns: T): Promise<{ -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> }> {
  const out: unknown[] = [];
  for (const fn of fns) out.push(await fn());
  return out as { -readonly [K in keyof T]: Awaited<ReturnType<T[K]>> };
}
