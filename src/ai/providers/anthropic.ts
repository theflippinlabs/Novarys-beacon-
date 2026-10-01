import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { AiRefusalError, type AnswerResult, type LlmProvider, type ProviderCredentials } from "../types";

/** Claude via the official Anthropic SDK. Server-side refusal fallbacks are enabled. */
export class AnthropicProvider implements LlmProvider {
  readonly id = "anthropic" as const;
  readonly label = "Anthropic Claude";
  readonly model: string;
  private client: Anthropic;

  private webSearch: boolean;

  constructor(creds: ProviderCredentials & { webSearch?: boolean }) {
    this.webSearch = creds.webSearch ?? true;
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

  /**
   * Sampled AI-visibility answer. With web search enabled (default, see
   * BEACON_ANTHROPIC_WEB_SEARCH) the server-side `web_search_20260209` tool
   * grounds the answer and text blocks carry `web_search_result_location`
   * citations; their character offsets in the concatenated answer are kept so
   * mentions near a cited source can be measured. If the organisation's API
   * key cannot use web search (400), the answer is sampled ungrounded and
   * recorded as such.
   */
  async answer(prompt: string): Promise<AnswerResult> {
    if (this.webSearch) {
      try {
        return await this.answerOnce(prompt, true);
      } catch (e) {
        if (!(e instanceof Anthropic.BadRequestError)) throw e;
      }
    }
    return this.answerOnce(prompt, false);
  }

  private async answerOnce(prompt: string, grounded: boolean): Promise<AnswerResult> {
    const tools: Anthropic.Beta.BetaToolUnion[] = grounded ? [{ type: "web_search_20260209", name: "web_search", max_uses: 3 }] : [];
    const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: prompt }];
    let text = "";
    let served: string | null = null;
    let searches = 0;
    const details = new Map<string, { url: string; title: string | null; offsets: number[] }>();
    // Server tools may pause a long turn (pause_turn); continue it a bounded number of times.
    for (let turn = 0; turn < 3; turn++) {
      const res = await this.client.beta.messages.create({
        model: this.model,
        max_tokens: 4000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "low" },
        messages,
        ...(tools.length ? { tools } : {}),
      });
      if (res.stop_reason === "refusal") throw new AiRefusalError();
      served = res.model ?? served;
      searches += res.usage?.server_tool_use?.web_search_requests ?? 0;
      for (const b of res.content) {
        if (b.type !== "text") continue;
        const start = text.length;
        text += b.text;
        for (const c of b.citations ?? []) {
          if (c.type !== "web_search_result_location") continue;
          const d = details.get(c.url) ?? { url: c.url, title: c.title ?? null, offsets: [] };
          d.offsets.push(start);
          details.set(c.url, d);
        }
      }
      if (res.stop_reason !== "pause_turn") break;
      messages.push({ role: "assistant", content: res.content });
    }
    const citationDetails = [...details.values()];
    return {
      text,
      citations: citationDetails.map((d) => d.url),
      servedModel: served,
      grounded,
      params: { maxTokens: 4000, effort: "low", webSearch: grounded ? { tool: "web_search_20260209", maxUses: 3, searches } : false },
      citationDetails,
    };
  }
}
