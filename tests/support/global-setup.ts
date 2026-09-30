import { execSync } from "node:child_process";
import { Client } from "pg";

/** Reset the integration-test database and apply migrations. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://beacon:beacon@localhost:5432/beacon_test";
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await c.end();
  execSync("npx tsx src/db/migrate.ts", { env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
}
