import type { LlmProvider, ProviderCredentials, ProviderId } from "../types";

/**
 * Minimal adapter for OpenAI-compatible chat-completions APIs (OpenAI,
 * Perplexity). Used only for sampled AI-visibility observations: answers
 * obtained through an API can differ from what a consumer app shows.
 */
export class OpenAICompatibleProvider implements LlmProvider {
  readonly model: string;
  private baseUrl: string;
  constructor(
    readonly id: Extract<ProviderId, "openai" | "perplexity">,
    readonly label: string,
    private creds: ProviderCredentials,
    defaults: { baseUrl: string; model: string },
  ) {
    this.model = creds.model || defaults.model;
    this.baseUrl = creds.baseUrl || defaults.baseUrl;
  }

  async answer(prompt: string) {
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.creds.apiKey}` },
      body: JSON.stringify({ model: this.model, messages: [{ role: "user", content: prompt }] }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`${this.label} API error ${res.status}`);
    const json = (await res.json()) as { choices?: { message?: { content?: string } }[]; citations?: string[]; search_results?: { url: string }[] };
    const text = json.choices?.[0]?.message?.content ?? "";
    const citations = [...(json.citations ?? []), ...(json.search_results ?? []).map((r) => r.url)];
    return { text, citations: [...new Set(citations)] };
  }
}
