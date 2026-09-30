import { migrate } from "drizzle-orm/node-postgres/migrator";
import { closeDb, db } from "./index";

async function main() {
  await migrate(db(), { migrationsFolder: new URL("./migrations", import.meta.url).pathname });
  console.log("migrations applied");
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
