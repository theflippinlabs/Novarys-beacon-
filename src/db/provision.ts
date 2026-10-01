/**
 * Idempotent database provisioning, run by `pnpm release` BEFORE migrations.
 *
 * Managed databases (e.g. Railway) hand out a SUPERUSER, and superusers bypass
 * row-level security, so Beacon runs with two dedicated roles:
 *
 *   application role  NOSUPERUSER NOBYPASSRLS: runs migrations and the app (DATABASE_URL)
 *   system role       NOSUPERUSER BYPASSRLS, DML only: `asSystem` (worker, auth, key-resolved APIs)
 *
 *   DATABASE_ADMIN_URL          superuser connection (provider-supplied)
 *   BEACON_DB_APP_USER          application role name (default: beacon_app)
 *   BEACON_DB_APP_PASSWORD      application role password (24+ chars)
 *   BEACON_DB_SYSTEM_USER       system role name (default: beacon_system)
 *   BEACON_DB_SYSTEM_PASSWORD   system role password (24+ chars)
 *
 * Without DATABASE_ADMIN_URL provisioning is skipped only when it is safe: in
 * production the release FAILS if DATABASE_URL is a superuser/BYPASSRLS role or
 * if the system role does not exist yet (migration 0005 removes the old
 * session-setting bypass, so the system role must exist first).
 */
import { Client } from "pg";
import { currentRoleFlags, ensureSystemRole, grantSystemRole, isUnsafeAppRole, ROLE_NAME_RE, roleExists, systemUserName } from "./roles";

const production = process.env.NODE_ENV === "production";

function fail(message: string): never {
  console.error(`provision: ${message}`);
  process.exit(1);
}

async function withClient<T>(url: string, fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function withoutAdmin() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (production) fail("DATABASE_URL is required");
    console.log("DATABASE_ADMIN_URL and DATABASE_URL not set, skipping role provisioning");
    return;
  }
  await withClient(url, async (c) => {
    const flags = await currentRoleFlags(c);
    const sys = await roleExists(c, systemUserName());
    if (isUnsafeAppRole(flags)) {
      const msg = `DATABASE_URL connects as "${flags.user}", a ${flags.rolsuper ? "superuser" : "BYPASSRLS"} role that disables row-level security. Set DATABASE_ADMIN_URL so release can create the application and system roles.`;
      if (production) fail(msg);
      console.warn(`provision: WARNING ${msg}`);
      return;
    }
    if (!sys.exists || !sys.bypassrls) {
      const msg = `system role "${systemUserName()}" ${sys.exists ? "lacks BYPASSRLS" : "does not exist"}. Set DATABASE_ADMIN_URL (superuser) so release can create it.`;
      if (production) fail(msg);
      console.warn(`provision: WARNING ${msg}`);
      return;
    }
    const usage = await c.query<{ ok: boolean }>("select has_schema_privilege($1, 'public', 'USAGE') as ok", [systemUserName()]);
    if (!usage.rows[0]?.ok) {
      const msg = `system role "${systemUserName()}" has no privileges on this database. Set DATABASE_ADMIN_URL so release can grant them.`;
      if (production) fail(msg);
      console.warn(`provision: WARNING ${msg}`);
      return;
    }
    console.log(`DATABASE_ADMIN_URL not set; role "${flags.user}" is already safe and system role "${systemUserName()}" exists, skipping role provisioning`);
  });
}

async function main() {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) return withoutAdmin();

  const appUser = process.env.BEACON_DB_APP_USER ?? "beacon_app";
  const appPassword = process.env.BEACON_DB_APP_PASSWORD;
  const sysUser = systemUserName();
  const sysPassword = process.env.BEACON_DB_SYSTEM_PASSWORD;
  if (!ROLE_NAME_RE.test(appUser)) fail("Invalid BEACON_DB_APP_USER");
  if (!ROLE_NAME_RE.test(sysUser)) fail("Invalid BEACON_DB_SYSTEM_USER");
  if (appUser === sysUser) fail("BEACON_DB_APP_USER and BEACON_DB_SYSTEM_USER must differ");
  if (!appPassword || appPassword.length < 24) fail("BEACON_DB_APP_PASSWORD must be at least 24 characters");
  if (!sysPassword || sysPassword.length < 24) fail("BEACON_DB_SYSTEM_PASSWORD must be at least 24 characters");

  await withClient(adminUrl, async (c) => {
    const admin = await currentRoleFlags(c);
    if (!admin.rolsuper) fail(`DATABASE_ADMIN_URL must connect as a superuser (connected as "${admin.user}")`);
    const dbName = (await c.query("select current_database() as db")).rows[0].db as string;
    const pw = appPassword.replace(/'/g, "''");
    const exists = (await c.query("select 1 from pg_roles where rolname = $1", [appUser])).rowCount;
    if (!exists) await c.query(`create role "${appUser}" login password '${pw}' nosuperuser nobypassrls nocreaterole nocreatedb`);
    else await c.query(`alter role "${appUser}" login password '${pw}' nosuperuser nobypassrls nocreaterole nocreatedb`);
    await c.query(`grant connect, create on database "${dbName}" to "${appUser}"`);
    await c.query(`grant usage, create on schema public to "${appUser}"`);

    await ensureSystemRole(c, sysUser, sysPassword);
    // Existing tables (whoever owns them) plus everything the app role creates later in migrations.
    await grantSystemRole(c, sysUser, appUser);
    console.log(`provisioned application role "${appUser}" and system role "${sysUser}" on database "${dbName}"`);
  });
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
