/**
 * Idempotent seed.
 *
 * Creates the bootstrap organisation + owner from environment variables and
 * the initial Novarys product records. Per the Beacon specification, only
 * information confirmed in the repository is seeded: the repository contains
 * no product facts, so products are created with their NAMES ONLY and every
 * other field left unknown for human completion in the onboarding wizard.
 *
 * Example queries and AI-visibility prompts quoted in the Beacon brief are
 * seeded as CANDIDATE queries / inactive prompts, clearly labelled, so a human
 * decides whether they are relevant.
 */
import { and, eq } from "drizzle-orm";
import { asSystem, closeDb } from "./index";
import { aiVisibilityPrompts, organizations, products } from "./schema";
import { createOrganizationWithOwner, hasAnyUser } from "@/lib/auth/service";
import { addQuery } from "@/services/queries";
import { slugify } from "@/core/util/text";

const SEED_PRODUCTS = ["Novus Live", "Operator", "NovaLex", "Aerys / Iris"];

const BRIEF_QUERIES: Record<string, string[]> = {
  "Novus Live": [
    "TikTok live moderation",
    "TikTok moderator software",
    "TikTok agency software",
    "TikTok live analytics",
    "TikTok moderation dashboard",
    "AI moderation for TikTok",
    "TikTok agency analytics",
    "TikTok creator moderation",
    "TikTok live management",
  ],
};

const BRIEF_PROMPTS = ["Best software for managing TikTok LIVE moderation", "AI tools for TikTok agencies", "Software for analyzing legal contracts", "OSINT investigation platform"];

async function main() {
  const orgName = process.env.BEACON_BOOTSTRAP_ORG_NAME ?? "Novarys";
  const orgSlug = process.env.BEACON_BOOTSTRAP_ORG_SLUG ?? slugify(orgName);
  const email = process.env.BEACON_BOOTSTRAP_ADMIN_EMAIL;
  const password = process.env.BEACON_BOOTSTRAP_ADMIN_PASSWORD;

  let org = await asSystem((tx) => tx.query.organizations.findFirst({ where: eq(organizations.slug, orgSlug) }));
  if (!org) {
    if (await hasAnyUser()) throw new Error(`Organisation "${orgSlug}" not found and users already exist — create it from the app instead.`);
    if (!email || !password) throw new Error("Set BEACON_BOOTSTRAP_ADMIN_EMAIL and BEACON_BOOTSTRAP_ADMIN_PASSWORD (or use the /setup page).");
    org = (await createOrganizationWithOwner({ orgName, orgSlug, email, name: "Owner", password })).org;
    console.log(`created organisation ${orgSlug} with owner ${email}`);
  }
  const orgId = org.id;

  await asSystem(async (tx) => {
    for (const name of SEED_PRODUCTS) {
      const slug = slugify(name);
      const exists = await tx.query.products.findFirst({ where: and(eq(products.organizationId, orgId), eq(products.slug, slug)) });
      const product = exists ?? (await tx.insert(products).values({ organizationId: orgId, name, slug, status: "UNKNOWN", onboardingStep: 1 }).returning())[0];
      if (!exists) console.log(`seeded product ${name} (name only — complete onboarding in the app)`);
      for (const q of BRIEF_QUERIES[name] ?? [])
        await addQuery(tx, orgId, { query: q, productId: product.id, status: "CANDIDATE", source: "IMPORTED", clusterName: "Brief examples", notes: "From the Beacon specification brief — validate relevance before activating.", brandTerms: [name] });
    }
    for (const prompt of BRIEF_PROMPTS) {
      const exists = await tx.query.aiVisibilityPrompts.findFirst({ where: and(eq(aiVisibilityPrompts.organizationId, orgId), eq(aiVisibilityPrompts.prompt, prompt)) });
      if (!exists) await tx.insert(aiVisibilityPrompts).values({ organizationId: orgId, prompt, category: "From brief (review, then activate)", active: false });
    }
  });
  console.log("seed complete");
  await closeDb();
}

main().catch(async (e) => {
  console.error(e);
  await closeDb();
  process.exit(1);
});
