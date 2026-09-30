import type { z } from "zod";

export type ProviderId = "anthropic" | "openai" | "perplexity";

export class AiRefusalError extends Error {
  constructor(message = "The model declined this request") {
    super(message);
    this.name = "AiRefusalError";
  }
}

/**
 * Provider abstraction. Beacon is never hard-wired to one LLM: every provider
 * implements free-form answering (used for sampled AI-visibility tests) and,
 * optionally, schema-constrained generation (used for content rewriting).
 */
export interface LlmProvider {
  readonly id: ProviderId;
  readonly label: string;
  readonly model: string;
  generateObject?<S extends z.ZodType>(args: { system: string; prompt: string; schema: S; maxTokens?: number }): Promise<z.infer<S>>;
  answer(prompt: string): Promise<{ text: string; citations: string[] }>;
}

export type ProviderCredentials = { apiKey: string; model?: string; baseUrl?: string };
