/**
 * Idempotent database provisioning for managed Postgres (e.g. Railway), run
 * before migrations. Managed databases hand out a SUPERUSER, and superusers
 * bypass row-level security, so Beacon creates a dedicated non-superuser,
 * non-BYPASSRLS application role and runs migrations and the app as that role.
 *
 *   DATABASE_ADMIN_URL      superuser connection (provider-supplied)
 *   BEACON_DB_APP_USER      application role name (default: beacon_app)
 *   BEACON_DB_APP_PASSWORD  application role password
 */
import { Client } from "pg";

async function main() {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    console.log("DATABASE_ADMIN_URL not set, skipping role provisioning");
    return;
  }
  const user = process.env.BEACON_DB_APP_USER ?? "beacon_app";
  const password = process.env.BEACON_DB_APP_PASSWORD;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(user)) throw new Error("Invalid BEACON_DB_APP_USER");
  if (!password || password.length < 24) throw new Error("BEACON_DB_APP_PASSWORD must be at least 24 characters");
  const c = new Client({ connectionString: adminUrl });
  await c.connect();
  try {
    const db = (await c.query("select current_database() as db")).rows[0].db as string;
    const exists = (await c.query("select 1 from pg_roles where rolname = $1", [user])).rowCount;
    const pw = password.replace(/'/g, "''");
    if (!exists) await c.query(`create role "${user}" login password '${pw}' nosuperuser nobypassrls nocreaterole nocreatedb`);
    else await c.query(`alter role "${user}" login password '${pw}' nosuperuser nobypassrls`);
    await c.query(`grant connect, create on database "${db}" to "${user}"`);
    await c.query(`grant usage, create on schema public to "${user}"`);
    console.log(`provisioned non-superuser application role "${user}" on database "${db}"`);
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
