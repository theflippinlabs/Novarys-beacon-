import { sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { env } from "@/lib/env";
import { currentRoleFlags, deriveSystemUrl, isUnsafeAppRole } from "./roles";
import * as schema from "./schema";

export type DB = NodePgDatabase<typeof schema>;
/** A transaction handle scoped to one tenant (RLS settings applied). */
export type Tx = Parameters<Parameters<DB["transaction"]>[0]>[0];

const globalForDb = globalThis as unknown as { beaconPool?: Pool; beaconDb?: DB; beaconSystemPool?: Pool; beaconSystemDb?: DB };

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

/** Connection string of the BYPASSRLS system role (see src/db/roles.ts). */
export function systemDatabaseUrl(): string {
  const e = env();
  return deriveSystemUrl({
    databaseUrl: e.DATABASE_URL,
    systemUrl: e.DATABASE_SYSTEM_URL,
    user: e.BEACON_DB_SYSTEM_USER,
    password: e.BEACON_DB_SYSTEM_PASSWORD,
    production: e.NODE_ENV === "production",
  });
}

function systemPool(): Pool {
  if (!globalForDb.beaconSystemPool) {
    globalForDb.beaconSystemPool = new Pool({
      connectionString: systemDatabaseUrl(),
      max: Number(process.env.DATABASE_SYSTEM_POOL_MAX ?? 5),
      idleTimeoutMillis: 30_000,
      statement_timeout: 30_000,
    });
  }
  return globalForDb.beaconSystemPool;
}

/**
 * Raw database handle (application role). Tenant tables are protected by RLS,
 * so queries against them through this handle return nothing unless run
 * inside `withOrg`: the system fails closed.
 */
export function db(): DB {
  if (!globalForDb.beaconDb) globalForDb.beaconDb = drizzle(pool(), { schema });
  return globalForDb.beaconDb;
}

/**
 * Raw handle on the system role (BYPASSRLS). Only for trusted system code:
 * the job queue and maintenance. Prefer `asSystem` for anything transactional.
 */
export function systemDb(): DB {
  if (!globalForDb.beaconSystemDb) globalForDb.beaconSystemDb = drizzle(systemPool(), { schema });
  return globalForDb.beaconSystemDb;
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
 * Run `fn` with RLS bypassed, on a separate connection pool that logs in as
 * the BYPASSRLS system role. Reserved for trusted system code paths
 * (authentication lookups, the job worker, public ingestion that resolves the
 * tenant from a hashed API key). Never pass user input here without resolving
 * the tenant first. The application role itself can no longer bypass RLS.
 */
export async function asSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return systemDb().transaction(async (tx) => fn(tx));
}

/**
 * Production startup guard: refuse to run when the application role is a
 * superuser or has BYPASSRLS (RLS would silently not apply), or when the
 * system role is missing or misconfigured.
 */
export async function assertDatabaseRoles(): Promise<void> {
  const c = await pool().connect();
  try {
    const app = await currentRoleFlags(c);
    if (isUnsafeAppRole(app)) {
      throw new Error(`Refusing to start: database role "${app.user}" is ${app.rolsuper ? "a superuser" : "BYPASSRLS"}, which disables row-level security. Connect DATABASE_URL as the application role created by \`pnpm release\`.`);
    }
  } finally {
    c.release();
  }
  const s = await systemPool().connect().catch((e: Error) => {
    throw new Error(`Refusing to start: cannot connect as the system database role (${e.message}). Run \`pnpm release\` with DATABASE_ADMIN_URL and set BEACON_DB_SYSTEM_PASSWORD.`);
  });
  try {
    const sys = await currentRoleFlags(s);
    if (sys.rolsuper) throw new Error(`Refusing to start: the system database role "${sys.user}" must not be a superuser.`);
    if (!sys.rolbypassrls) throw new Error(`Refusing to start: the system database role "${sys.user}" lacks BYPASSRLS. Run \`pnpm release\` with DATABASE_ADMIN_URL.`);
  } finally {
    s.release();
  }
}

export async function closeDb() {
  await globalForDb.beaconPool?.end();
  await globalForDb.beaconSystemPool?.end();
  globalForDb.beaconPool = undefined;
  globalForDb.beaconDb = undefined;
  globalForDb.beaconSystemPool = undefined;
  globalForDb.beaconSystemDb = undefined;
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
