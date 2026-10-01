/**
 * DEMO fixture (`pnpm db:seed:demo`): example content quoted in the Beacon
 * specification brief. None of it is measured or verified, so everything is
 * created in a reviewable, inactive state and labelled as demo data:
 * - queries: status CANDIDATE, cluster "Demo: brief examples", demo note;
 * - AI-visibility prompts: inactive, category "Demo: from brief (review, then activate)";
 * - products: the Novarys product NAMES only (status UNKNOWN, every fact left
 *   empty for onboarding), created only when missing. Products have no label
 *   column, so the names themselves are the only thing seeded.
 * Idempotent: re-running adds nothing.
 */
import { and, eq } from "drizzle-orm";
import type { Tx } from "../index";
import { aiVisibilityPrompts, products } from "../schema";
import { addQuery } from "@/services/queries";
import { slugify } from "@/core/util/text";

export const DEMO_CLUSTER = "Demo: brief examples";
export const DEMO_QUERY_NOTE = "DEMO DATA (pnpm db:seed:demo): example from the Beacon specification brief, not measured demand. Validate relevance before activating.";
export const DEMO_PROMPT_CATEGORY = "Demo: from brief (review, then activate)";

export const DEMO_PRODUCTS = ["Novus Live", "Operator", "NovaLex", "Aerys / Iris"];

export const DEMO_QUERIES: Record<string, string[]> = {
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

export const DEMO_PROMPTS = ["Best software for managing TikTok LIVE moderation", "AI tools for TikTok agencies", "Software for analyzing legal contracts", "OSINT investigation platform"];

export type DemoSeedResult = { productsCreated: string[]; queriesCreated: number; promptsCreated: number };

/** Seed the demo fixture into one organisation (run inside `asSystem` or `withOrg`). */
export async function seedDemo(tx: Tx, organizationId: string): Promise<DemoSeedResult> {
  const out: DemoSeedResult = { productsCreated: [], queriesCreated: 0, promptsCreated: 0 };
  for (const name of DEMO_PRODUCTS) {
    const slug = slugify(name);
    const exists = await tx.query.products.findFirst({ where: and(eq(products.organizationId, organizationId), eq(products.slug, slug)) });
    const product = exists ?? (await tx.insert(products).values({ organizationId, name, slug, status: "UNKNOWN", onboardingStep: 1 }).returning())[0];
    if (!exists) out.productsCreated.push(name);
    for (const q of DEMO_QUERIES[name] ?? []) {
      const row = await addQuery(tx, organizationId, { query: q, productId: product.id, status: "CANDIDATE", source: "IMPORTED", clusterName: DEMO_CLUSTER, notes: DEMO_QUERY_NOTE, brandTerms: [name] });
      if (row) out.queriesCreated++;
    }
  }
  for (const prompt of DEMO_PROMPTS) {
    const exists = await tx.query.aiVisibilityPrompts.findFirst({ where: and(eq(aiVisibilityPrompts.organizationId, organizationId), eq(aiVisibilityPrompts.prompt, prompt)) });
    if (exists) continue;
    await tx.insert(aiVisibilityPrompts).values({ organizationId, prompt, category: DEMO_PROMPT_CATEGORY, active: false });
    out.promptsCreated++;
  }
  return out;
}
