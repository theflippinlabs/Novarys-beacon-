import type { AnswerResult, LlmProvider, ProviderCredentials, ProviderId } from "../types";

export type ChatCompletionJson = {
  model?: string;
  choices?: { message?: { content?: string; annotations?: { type?: string; url_citation?: { url: string; title?: string; start_index?: number; end_index?: number } }[] } }[];
  citations?: string[];
  search_results?: { url: string; title?: string }[];
};

/** Pure parser for chat-completions answers (exported for tests). */
export function parseChatCompletion(id: "openai" | "perplexity", json: ChatCompletionJson, opts: { webSearchRequested?: boolean } = {}): AnswerResult {
  const msg = json.choices?.[0]?.message;
  const text = msg?.content ?? "";
  const details = new Map<string, { url: string; title: string | null; offsets: number[] }>();
  const add = (url: string, title: string | null | undefined, offset?: number) => {
    if (!url) return;
    const d = details.get(url) ?? { url, title: title ?? null, offsets: [] };
    if (!d.title && title) d.title = title;
    if (typeof offset === "number") d.offsets.push(offset);
    details.set(url, d);
  };
  for (const a of msg?.annotations ?? []) if (a.type === "url_citation" && a.url_citation) add(a.url_citation.url, a.url_citation.title, a.url_citation.start_index);
  (json.citations ?? []).forEach((u, i) => {
    add(u, null);
    // Perplexity references citation i+1 as "[i+1]" in the text.
    const d = details.get(u);
    if (d) for (const m of text.matchAll(new RegExp(`\\[${i + 1}\\]`, "g"))) d.offsets.push(m.index ?? 0);
  });
  for (const r of json.search_results ?? []) add(r.url, r.title);
  const citationDetails = [...details.values()];
  const grounded = id === "perplexity" || citationDetails.length > 0 || Boolean(opts.webSearchRequested);
  return { text, citations: citationDetails.map((d) => d.url), servedModel: json.model ?? null, grounded, params: { webSearch: id === "perplexity" ? "built-in" : Boolean(opts.webSearchRequested) }, citationDetails };
}

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

  /**
   * Perplexity (Sonar) answers are always web-grounded and return `citations`
   * / `search_results`, referenced in the text as [1], [2]... OpenAI search
   * models (model id containing "search") are asked for web search and
   * return `url_citation` annotations with character offsets.
   */
  async answer(prompt: string): Promise<AnswerResult> {
    const openaiSearch = this.id === "openai" && /search/i.test(this.model);
    const body: Record<string, unknown> = { model: this.model, messages: [{ role: "user", content: prompt }] };
    if (openaiSearch) body.web_search_options = {};
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.creds.apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw await providerError(this.label, res);
    return parseChatCompletion(this.id, (await res.json()) as ChatCompletionJson, { webSearchRequested: openaiSearch });
  }
}

/**
 * Error with the provider's own explanation (e.g. "Incorrect API key
 * provided", "insufficient permissions", "exceeded your current quota"), so a
 * person can fix the cause. Key fragments are masked; the HTTP status is kept
 * for the integration health (401/403 mean the credentials need replacing).
 */
export async function providerError(label: string, res: Response): Promise<Error & { status: number }> {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { error?: { message?: string; code?: string } | string };
      detail = typeof j.error === "string" ? j.error : (j.error?.message ?? "");
    } catch {
      detail = text;
    }
  } catch {
    // Body unreadable: the status alone is reported.
  }
  detail = detail
    .replace(/\b(sk|pplx)-[A-Za-z0-9_*-]{6,}/g, "$1-[redacted]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
  return Object.assign(new Error(detail ? `${label} API error ${res.status}: ${detail}` : `${label} API error ${res.status}`), { status: res.status });
}
