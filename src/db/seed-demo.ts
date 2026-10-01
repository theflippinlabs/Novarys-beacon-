/**
 * `pnpm db:seed:demo`: explicit DEMO mode. Loads the example fixture
 * (src/db/fixtures/demo.ts) into an existing organisation (BEACON_DEMO_ORG_SLUG,
 * default BEACON_BOOTSTRAP_ORG_SLUG or "novarys"). Refuses to run with
 * NODE_ENV=production unless BEACON_ALLOW_DEMO_SEED=true. Never called by
 * `release` or at startup.
 */
import { demoSeedDecision } from "./fixtures/guard";

async function main() {
  const decision = demoSeedDecision(process.env);
  if (!decision.allowed) {
    console.error(decision.reason);
    process.exit(2);
  }
  // Database modules load only after the guard passed.
  const { eq } = await import("drizzle-orm");
  const { asSystem, closeDb } = await import("./index");
  const { organizations } = await import("./schema");
  const { seedDemo } = await import("./fixtures/demo");
  const slug = process.env.BEACON_DEMO_ORG_SLUG ?? process.env.BEACON_BOOTSTRAP_ORG_SLUG ?? "novarys";
  try {
    const org = await asSystem((tx) => tx.query.organizations.findFirst({ where: eq(organizations.slug, slug) }));
    if (!org) throw new Error(`Organisation "${slug}" not found. Run \`pnpm db:seed\` or /setup first, or set BEACON_DEMO_ORG_SLUG.`);
    const res = await asSystem((tx) => seedDemo(tx, org.id));
    console.log(`demo seed complete in "${slug}": ${res.productsCreated.length} product name(s), ${res.queriesCreated} candidate query(ies), ${res.promptsCreated} inactive prompt(s), all labelled demo`);
  } finally {
    await closeDb();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
