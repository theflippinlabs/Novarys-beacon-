import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { AiRefusalError, type LlmProvider, type ProviderCredentials } from "../types";

/** Claude via the official Anthropic SDK. Server-side refusal fallbacks are enabled. */
export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic" as const;
  readonly label = "Anthropic Claude";
  readonly model: string;
  private client: Anthropic;

  constructor(creds: ProviderCredentials) {
    this.model = creds.model || "claude-opus-5-5";
    this.client = new Anthropic({ apiKey: creds.apiKey, timeout: 120_000, maxRetries: 2 });
  }

  async generateObject<S extends z.ZodType>(args: { system: string; prompt: string; schema: S; maxTokens?: number }): Promise<z.infer<S>> {
    const res = await this.client.beta.messages.parse({
      model: this.model,
      max_tokens: args.maxTokens ?? 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system: args.system,
      messages: [{ role: "user", content: args.prompt }],
      output_config: { effort: "medium", format: betaZodOutputFormat(args.schema) },
    });
    if (res.stop_reason === "refusal") throw new AiRefusalError();
    if (res.parsed_output === null || res.parsed_output === undefined) throw new Error("Model output did not match the schema");
    return res.parsed_output as z.infer<S>;
  }

  async answer(prompt: string) {
    const res = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      messages: [{ role: "user", content: prompt }],
    });
    if (res.stop_reason === "refusal") throw new AiRefusalError();
    const text = res.content.map((b) => (b.type === "text" ? b.text : "")).join("");
    return { text, citations: [] };
  }
}
