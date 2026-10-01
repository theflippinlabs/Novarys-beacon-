import { execSync } from "node:child_process";
import { Client } from "pg";
import { ensureSystemRole, grantSystemRole, roleExists } from "../../src/db/roles";
import { testSystemUrl } from "./db-urls";

/**
 * Reset the integration-test database, apply migrations and provision the
 * BYPASSRLS system role used by `asSystem`.
 *
 * Creating the role needs a superuser once per Postgres cluster:
 * TEST_DATABASE_ADMIN_URL (default postgres://postgres:postgres@localhost:5432/<db>).
 * Locally: `sudo -u postgres psql -c "alter role postgres password 'postgres'"`, or create
 * the role yourself: `sudo -u postgres psql -c "create role beacon_system login bypassrls password 'beacon_system'"`.
 * Table grants are then issued by the app role, which owns the freshly migrated tables.
 */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://beacon:beacon@localhost:5432/beacon_test";
  const sysUrl = new URL(testSystemUrl(url));
  const sysUser = decodeURIComponent(sysUrl.username);
  const sysPassword = decodeURIComponent(sysUrl.password);

  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    await c.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
    const sys = await roleExists(c, sysUser);
    if (!sys.exists || !sys.bypassrls) await createSystemRoleAsAdmin(url, sysUser, sysPassword);
  } finally {
    await c.end();
  }
  execSync("npx tsx src/db/migrate.ts", { env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
  const owner = new Client({ connectionString: url });
  await owner.connect();
  try {
    await grantSystemRole(owner, sysUser);
  } finally {
    await owner.end();
  }
}

async function createSystemRoleAsAdmin(url: string, user: string, password: string) {
  const fallback = new URL(url);
  fallback.username = "postgres";
  fallback.password = "postgres";
  const adminUrl = process.env.TEST_DATABASE_ADMIN_URL ?? fallback.toString();
  const a = new Client({ connectionString: adminUrl });
  try {
    await a.connect();
  } catch (e) {
    throw new Error(
      `The system role "${user}" is missing and no superuser connection works (${(e as Error).message}). Set TEST_DATABASE_ADMIN_URL or run: sudo -u postgres psql -c "create role ${user} login bypassrls password '${password}'"`,
    );
  }
  try {
    await ensureSystemRole(a, user, password);
  } finally {
    await a.end();
  }
}
