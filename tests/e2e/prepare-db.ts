import { execSync } from "node:child_process";
import { Client } from "pg";

/** Reset the E2E database and apply migrations (runs before the web server starts). */
async function main() {
  const url = process.env.DATABASE_URL ?? "postgres://beacon:beacon@localhost:5432/beacon_e2e";
  if (!/beacon_e2e/.test(url)) throw new Error("Refusing to reset a non-E2E database");
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query("drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;");
  await c.end();
  execSync("npx tsx src/db/migrate.ts", { env: { ...process.env, DATABASE_URL: url }, stdio: "inherit" });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
