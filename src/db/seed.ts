/**
 * Idempotent bootstrap seed (`pnpm db:seed`, optional: `/setup` does the same
 * from the browser). Creates the bootstrap organisation and its owner from
 * environment variables, and nothing else: no products, queries or prompts.
 * Example content from the Beacon brief lives in the explicit DEMO fixture
 * (`pnpm db:seed:demo`, src/db/fixtures/demo.ts). Neither runs in `release`.
 */
import { eq } from "drizzle-orm";
import { asSystem, closeDb } from "./index";
import { organizations } from "./schema";
import { createOrganizationWithOwner, hasAnyUser } from "@/lib/auth/service";
import { slugify } from "@/core/util/text";

async function main() {
  const orgName = process.env.BEACON_BOOTSTRAP_ORG_NAME ?? "Novarys";
  const orgSlug = process.env.BEACON_BOOTSTRAP_ORG_SLUG ?? slugify(orgName);
  const email = process.env.BEACON_BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BEACON_BOOTSTRAP_ADMIN_PASSWORD;

  const org = await asSystem((tx) => tx.query.organizations.findFirst({ where: eq(organizations.slug, orgSlug) }));
  if (org) {
    console.log(`organisation ${orgSlug} already exists; nothing to do`);
  } else {
    if (await hasAnyUser()) throw new Error(`Organisation "${orgSlug}" not found and users already exist. Create it from the app instead.`);
    if (!email || !password) throw new Error("Set BEACON_BOOTSTRAP_ADMIN_EMAIL and BEACON_BOOTSTRAP_ADMIN_PASSWORD (or use the /setup page).");
    await createOrganizationWithOwner({ orgName, orgSlug, email, name: "Owner", password });
    console.log(`created organisation ${orgSlug} with owner ${email}`);
  }
  console.log("seed complete");
  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(1);
});
