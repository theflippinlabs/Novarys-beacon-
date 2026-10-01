import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, withOrg, type Tx } from "@/db";
import { aiMentions, aiRuns, aiVisibilityPrompts, aiVisibilityTests } from "@/db/schema";
import type { LlmProvider } from "@/ai/types";
import { promptSummaries, runPromptTests } from "@/services/ai-visibility";
import { newOrg, seedCompleteProduct, uid } from "./helpers";

let orgId: string;
let productId: string;
let competitorId: string;
let domain: string;
const run = <T,>(fn: (tx: Tx) => Promise<T>) => withOrg(orgId, fn);

const provider = (id: LlmProvider["id"], model: string, answer: LlmProvider["answer"]): LlmProvider => ({ id, label: id, model, answer });

beforeAll(async () => {
  orgId = (await newOrg("aivis")).org.id;
  const slug = `beacon-live-${uid()}`;
  const seeded = await seedCompleteProduct(orgId, { name: "Beacon Live", slug, competitorName: "ModBot" });
  productId = seeded.product.id;
  competitorId = seeded.competitor.id;
  domain = seeded.product.domain!;
});
afterAll(closeDb);

async function newPrompt(text = "What is the best tool to moderate TikTok live chat?") {
  return (await run((tx) => tx.insert(aiVisibilityPrompts).values({ organizationId: orgId, productId, prompt: text, category: "moderation" }).returning()))[0];
}

describe("runPromptTests", () => {
  it("stores a SAMPLED_OBSERVATION with positions, citations and an ai_mentions row", async () => {
    const prompt = await newPrompt();
    const llm = provider("anthropic", "fake-model-1", async (p) => {
      expect(p).toBe(prompt.prompt);
      return { text: `Popular options are ModBot and Beacon Live. Docs: https://${domain}/docs.`, citations: ["https://reviews.example/tiktok-moderation"] };
    });
    const results = await runPromptTests(run, orgId, prompt.id, [llm]);
    expect(results).toEqual([{ provider: "anthropic", ok: true, mentioned: true }]);

    const tests = await run((tx) => tx.select().from(aiVisibilityTests).where(eq(aiVisibilityTests.promptId, prompt.id)));
    expect(tests).toHaveLength(1);
    const t = tests[0];
    expect(t).toMatchObject({ provider: "anthropic", model: "fake-model-1", label: "SAMPLED_OBSERVATION", ownDomainCited: true, orgMentioned: true, position: 2 });
    expect(t.productsMentioned).toEqual([{ productId, name: "Beacon Live", position: 2 }]);
    expect(t.competitorsMentioned).toEqual([{ competitorId, name: "ModBot", position: 1 }]);
    expect(t.citations).toEqual(expect.arrayContaining(["https://reviews.example/tiktok-moderation", `https://${domain}/docs`]));

    const mentions = await run((tx) => tx.select().from(aiMentions).where(eq(aiMentions.testId, t.id)));
    expect(mentions).toEqual([expect.objectContaining({ productId, engine: "anthropic:fake-model-1", source: "SAMPLED_TEST", context: prompt.prompt })]);
    const runs = await run((tx) => tx.select().from(aiRuns).where(eq(aiRuns.task, "analyzeVisibility")));
    expect(runs.length).toBeGreaterThanOrEqual(1);

    const summary = await run((tx) => promptSummaries(tx, orgId, productId));
    expect(summary.find((s) => s.prompt.id === prompt.id)).toMatchObject({ testsRun: 1, mentions: 1, cited: 1, competitors: ["ModBot"] });
  });

  it("a response that mentions nothing is stored without mentions", async () => {
    const prompt = await newPrompt("Which tool helps with live chat?");
    await runPromptTests(run, orgId, prompt.id, [provider("openai", "gpt-fake", async () => ({ text: "There are several tools; it depends on your needs.", citations: [] }))]);
    const [t] = await run((tx) => tx.select().from(aiVisibilityTests).where(eq(aiVisibilityTests.promptId, prompt.id)));
    expect(t).toMatchObject({ orgMentioned: false, position: null, productsMentioned: [], ownDomainCited: false });
    expect(await run((tx) => tx.select().from(aiMentions).where(eq(aiMentions.testId, t.id)))).toHaveLength(0);
  });

  it("one failing provider is reported, others still recorded", async () => {
    const prompt = await newPrompt("Recommend a TikTok live moderation app");
    const results = await runPromptTests(run, orgId, prompt.id, [
      provider("openai", "broken", async () => {
        throw new Error("rate limited");
      }),
      provider("perplexity", "sonar-fake", async () => ({ text: "Beacon Live.", citations: [] })),
    ]);
    expect(results).toEqual([
      { provider: "openai", ok: false, error: "rate limited" },
      { provider: "perplexity", ok: true, mentioned: true },
    ]);
    expect(await run((tx) => tx.select().from(aiVisibilityTests).where(eq(aiVisibilityTests.promptId, prompt.id)))).toHaveLength(1);
  });

  it("throws when every provider fails, and for unknown prompts", async () => {
    const prompt = await newPrompt("Anything?");
    const failing = (id: LlmProvider["id"]) =>
      provider(id, "x", async () => {
        throw new Error(`${id} down`);
      });
    await expect(runPromptTests(run, orgId, prompt.id, [failing("anthropic"), failing("openai")])).rejects.toThrow(/All providers failed: anthropic: anthropic down; openai: openai down/);
    expect(await run((tx) => tx.select().from(aiVisibilityTests).where(eq(aiVisibilityTests.promptId, prompt.id)))).toHaveLength(0);
    await expect(runPromptTests(run, orgId, "00000000-0000-4000-8000-000000000000", [failing("anthropic")])).rejects.toThrow("Prompt not found");
    // A prompt of another org is not found either.
    const other = await newOrg("aivis-other");
    await expect(runPromptTests((fn) => withOrg(other.org.id, fn), other.org.id, prompt.id, [failing("anthropic")])).rejects.toThrow("Prompt not found");
  });
});
