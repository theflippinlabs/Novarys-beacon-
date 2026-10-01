/**
 * Database role model (shared by provisioning, startup checks and test setup).
 *
 *   owner/app role   DATABASE_URL            runs migrations and the app; NOSUPERUSER, NOBYPASSRLS,
 *                                            so every tenant table is filtered by row-level security.
 *   system role      DATABASE_SYSTEM_URL     (or derived from DATABASE_URL with BEACON_DB_SYSTEM_USER /
 *                                            BEACON_DB_SYSTEM_PASSWORD) BYPASSRLS, DML only; used by
 *                                            `asSystem` (auth lookups, the job worker, key-resolved APIs).
 *
 * There is no session setting that bypasses RLS any more: the only way past
 * the policies is to hold the system role's credentials.
 */
import type { Client, PoolClient } from "pg";

type Queryable = Pick<Client | PoolClient, "query">;

export const ROLE_NAME_RE = /^[a-z_][a-z0-9_]{0,62}$/;

export const systemUserName = () => process.env.BEACON_DB_SYSTEM_USER || "beacon_system";

/** Development / test default for the system role password (refused in production). */
export const DEV_SYSTEM_PASSWORD = "beacon_system";

export type RoleFlags = { user: string; rolsuper: boolean; rolbypassrls: boolean };

export async function currentRoleFlags(c: Queryable): Promise<RoleFlags> {
  const r = await c.query<{ user: string; rolsuper: boolean; rolbypassrls: boolean }>(
    "select current_user as user, rolsuper, rolbypassrls from pg_roles where rolname = current_user",
  );
  const row = r.rows[0];
  return { user: row?.user ?? "unknown", rolsuper: Boolean(row?.rolsuper), rolbypassrls: Boolean(row?.rolbypassrls) };
}

export const isUnsafeAppRole = (f: RoleFlags) => f.rolsuper || f.rolbypassrls;

/**
 * Connection string for the system role: `DATABASE_SYSTEM_URL` when set,
 * otherwise `DATABASE_URL` with the system role's credentials. In production a
 * missing password is a startup error, never a silent fallback.
 */
export function deriveSystemUrl(opts: { databaseUrl: string; systemUrl?: string; user?: string; password?: string; production: boolean }): string {
  if (opts.systemUrl) return opts.systemUrl;
  const user = opts.user || "beacon_system";
  if (!ROLE_NAME_RE.test(user)) throw new Error("Invalid BEACON_DB_SYSTEM_USER");
  const password = opts.password || (opts.production ? "" : DEV_SYSTEM_PASSWORD);
  if (!password) {
    throw new Error("System database credentials missing: set DATABASE_SYSTEM_URL or BEACON_DB_SYSTEM_PASSWORD (run `pnpm release` with DATABASE_ADMIN_URL to create the role)");
  }
  const u = new URL(opts.databaseUrl);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(password);
  return u.toString();
}

const quoteIdent = (name: string) => {
  if (!ROLE_NAME_RE.test(name)) throw new Error(`Invalid role name ${name}`);
  return `"${name}"`;
};
const quoteLiteral = (s: string) => `'${s.replace(/'/g, "''")}'`;

/**
 * Create or update the BYPASSRLS system role. Needs a superuser connection
 * (only superusers may grant BYPASSRLS).
 */
export async function ensureSystemRole(admin: Queryable, user: string, password: string) {
  const exists = (await admin.query("select 1 from pg_roles where rolname = $1", [user])).rowCount;
  const attrs = `login password ${quoteLiteral(password)} nosuperuser bypassrls nocreatedb nocreaterole noinherit`;
  await admin.query(exists ? `alter role ${quoteIdent(user)} ${attrs}` : `create role ${quoteIdent(user)} ${attrs}`);
}

/**
 * DML privileges for the system role on every current table of `public`
 * (run as a superuser or as the tables' owner), plus default privileges so
 * tables created later by `ownerRole` (migrations) are covered too.
 */
export async function grantSystemRole(c: Queryable, systemUser: string, ownerRole?: string) {
  const sys = quoteIdent(systemUser);
  const dbName = (await c.query<{ db: string }>("select current_database() as db")).rows[0].db;
  await c.query(`grant connect on database "${dbName.replace(/"/g, '""')}" to ${sys}`);
  await c.query(`grant usage on schema public to ${sys}`);
  await c.query(`grant select, insert, update, delete on all tables in schema public to ${sys}`);
  await c.query(`grant usage, select on all sequences in schema public to ${sys}`);
  const owner = ownerRole ? `for role ${quoteIdent(ownerRole)} ` : "";
  await c.query(`alter default privileges ${owner}in schema public grant select, insert, update, delete on tables to ${sys}`);
  await c.query(`alter default privileges ${owner}in schema public grant usage, select on sequences to ${sys}`);
}

export async function roleExists(c: Queryable, user: string): Promise<{ exists: boolean; bypassrls: boolean; superuser: boolean }> {
  const r = await c.query<{ rolbypassrls: boolean; rolsuper: boolean }>("select rolbypassrls, rolsuper from pg_roles where rolname = $1", [user]);
  return { exists: r.rowCount === 1, bypassrls: Boolean(r.rows[0]?.rolbypassrls), superuser: Boolean(r.rows[0]?.rolsuper) };
}
