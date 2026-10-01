import "server-only";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { resolveCredentials } from "@/ai/registry";
import { withOrg } from "@/db";
import { makeT, type Locale } from "@/i18n/core";
import { FR } from "@/i18n/fr";
import type { Actor } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/service";
import { can } from "@/lib/auth/rbac";
import { log } from "@/lib/logger";
import { loadMedia } from "@/services/media";
import { AGENT_SYSTEM, sessionDetails } from "./prompt";
import { appendMessage, createConversation, loadConversation, type StoredMessage } from "./store";
import { toolsForRole } from "./tools";
import { repairToolPairs } from "./transcript";
import type { AgentTool } from "./types";

type Block = Anthropic.Beta.BetaContentBlockParam;
type Msg = Anthropic.Beta.BetaMessageParam;

/** Events streamed to the chat UI (NDJSON). */
export type AgentEvent =
  | { type: "conversation"; id: string; title: string }
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string; label: string }
  | { type: "tool_end"; id: string; ok: boolean; links: string[]; error?: string }
  | { type: "error"; code: "not_connected" | "refused" | "failed" | "limit"; message?: string }
  | { type: "done" };

const MAX_ROUNDS = 16;
const MAX_RESULT_CHARS = 40_000;
const TOOL_TIMEOUT_MS = 120_000;

/** Stored user turns reference uploaded photos by id; the API needs the bytes. */
type StoredImage = { type: "image"; source: { type: "beacon_media"; media_id: string } };
const isStoredImage = (b: unknown): b is StoredImage =>
  typeof b === "object" && b !== null && (b as StoredImage).type === "image" && (b as StoredImage).source?.type === "beacon_media";

async function hydrate(ctx: AuthContext, messages: StoredMessage[]): Promise<Msg[]> {
  const out: Msg[] = [];
  for (const m of messages) {
    const content: Block[] = [];
    for (const b of m.content) {
      if (isStoredImage(b)) {
        const loaded = await withOrg(ctx.org.id, (tx) => loadMedia(tx, ctx.org.id, b.source.media_id));
        // Private photos belong to their uploader: another member's id never reaches the model.
        const row = loaded && (loaded.visibility !== "PRIVATE" || loaded.createdBy === ctx.user.id) ? loaded : null;
        content.push(
          row
            ? { type: "image", source: { type: "base64", media_type: row.mime as "image/webp", data: Buffer.from(row.bytes).toString("base64") } }
            : { type: "text", text: "[photo no longer available]" },
        );
      } else content.push(b as Block);
    }
    out.push({ role: m.role, content });
  }
  return out;
}

function toolDefs(tools: AgentTool[]): Anthropic.Beta.BetaToolUnion[] {
  return tools.map((t) => {
    const schema = z.toJSONSchema(t.input) as Record<string, unknown>;
    delete schema.$schema;
    return {
      name: t.name,
      description: t.description,
      input_schema: schema as Anthropic.Beta.BetaTool.InputSchema,
      eager_input_streaming: true,
    };
  });
}

/** Collect app paths from a tool result so the UI can offer them as buttons. */
function linksOf(result: unknown): string[] {
  const found = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || found.size >= 3) return;
    if (Array.isArray(v)) v.slice(0, 5).forEach((x) => walk(x, depth + 1));
    else if (v && typeof v === "object")
      for (const [k, x] of Object.entries(v)) {
        if (k === "link" && typeof x === "string" && /^\/(?!\/)/.test(x)) found.add(x);
        else walk(x, depth + 1);
      }
  };
  walk(result, 0);
  return [...found];
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`Tool timed out after ${ms / 1000}s`)), ms))]);
}

async function runTool(tool: AgentTool | undefined, name: string, input: unknown, ctx: AuthContext, actor: Actor, locale: Locale) {
  if (!tool) throw new Error(`Unknown tool: ${name}`);
  if (!can(ctx.role, tool.permission)) throw new Error(`Your role (${ctx.role}) does not allow this action.`);
  const parsed = tool.input.safeParse(input);
  if (!parsed.success) throw new Error(`Invalid input: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
  const t = makeT(locale === "fr" ? FR : null);
  return withTimeout(
    withOrg(ctx.org.id, (tx) => tool.run({ tx, ctx, actor, locale, t }, parsed.data)),
    TOOL_TIMEOUT_MS,
  );
}

/**
 * One user turn: persist the message, then loop model ↔ tools until the model
 * answers. Every assistant and tool-result message is persisted as soon as it
 * exists, so the stored history is always a valid, replayable transcript.
 */
export async function* runAgentTurn(opts: {
  ctx: AuthContext;
  actor: Actor;
  locale: Locale;
  conversationId?: string | null;
  text: string;
  mediaIds?: string[];
  signal?: AbortSignal;
}): AsyncGenerator<AgentEvent> {
  const { ctx, actor, locale } = opts;

  const creds = await withOrg(ctx.org.id, (tx) => resolveCredentials(tx, ctx.org.id, "anthropic"));
  if (!creds) {
    yield { type: "error", code: "not_connected" };
    return;
  }

  let conversationId = opts.conversationId ?? null;
  let history: StoredMessage[] = [];
  if (conversationId) {
    const loaded = await loadConversation(ctx, conversationId);
    if (!loaded) {
      yield { type: "error", code: "failed", message: "Conversation not found." };
      return;
    }
    history = loaded.messages;
  } else {
    const conv = await createConversation(ctx, opts.text.replace(/\s+/g, " ").trim() || "Photo");
    conversationId = conv.id;
    yield { type: "conversation", id: conv.id, title: conv.title };
  }

  const userContent: unknown[] = [
    ...(opts.mediaIds ?? []).map((id): StoredImage => ({ type: "image", source: { type: "beacon_media", media_id: id } })),
    ...(opts.text.trim() ? [{ type: "text", text: opts.text.trim() }] : []),
  ];
  const userMessage: StoredMessage = { role: "user", content: userContent };
  await appendMessage(ctx, conversationId, userMessage);
  history.push(userMessage);

  const tools = toolsForRole(ctx.role);
  const byName = new Map(tools.map((t) => [t.name, t]));
  const defs = toolDefs(tools);
  const system: Anthropic.Beta.BetaTextBlockParam[] = [
    { type: "text", text: AGENT_SYSTEM, cache_control: { type: "ephemeral" } },
    { type: "text", text: sessionDetails(ctx, locale) },
  ];
  const client = new Anthropic({ apiKey: creds.apiKey, timeout: 10 * 60_000, maxRetries: 2 });
  const model = creds.model || "claude-opus-5-5";
  let messages = repairToolPairs(await hydrate(ctx, history));
  let jsonRetries = 0;

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (opts.signal?.aborted) return;
    let message: Anthropic.Beta.BetaMessage;
    try {
      const stream = client.beta.messages.stream(
        {
          model,
          max_tokens: 32_000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: "medium" },
          cache_control: { type: "ephemeral" },
          system,
          tools: defs,
          messages,
        },
        { signal: opts.signal },
      );
      for await (const ev of stream) {
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") yield { type: "text", delta: ev.delta.text };
      }
      message = await stream.finalMessage();
      jsonRetries = 0;
    } catch (e) {
      if (opts.signal?.aborted) return;
      // Eager tool-input streaming: an unparseable tool input is retried; API errors are reported.
      if (!(e instanceof Anthropic.APIError) && e instanceof SyntaxError && jsonRetries++ < 2) continue;
      log.warn("agent.model_error", { err: (e as Error).message, status: e instanceof Anthropic.APIError ? e.status : undefined });
      yield {
        type: "error",
        code: "failed",
        message: e instanceof Anthropic.AuthenticationError ? "The Anthropic API key was rejected." : e instanceof Anthropic.RateLimitError ? "The AI provider is rate limiting requests. Try again in a moment." : "The AI provider could not be reached.",
      };
      return;
    }

    if (message.stop_reason === "refusal") {
      yield { type: "error", code: "refused" };
      return;
    }

    const assistant: StoredMessage = { role: "assistant", content: message.content as unknown[] };
    await appendMessage(ctx, conversationId, assistant);
    history.push(assistant);
    messages = [...messages, { role: "assistant", content: message.content as Block[] }];

    if (message.stop_reason === "pause_turn") continue;
    const calls = message.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (calls.length === 0) {
      yield { type: "done" };
      return;
    }

    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const call of calls) {
      const tool = byName.get(call.name);
      yield { type: "tool_start", id: call.id, name: call.name, label: tool?.label ?? call.name };
      // A tool input cut off by max_tokens may parse as a truncated object: never run it.
      if (message.stop_reason === "max_tokens") {
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: "Your tool input was cut off by the output limit. Retry with a shorter input." });
        yield { type: "tool_end", id: call.id, ok: false, links: [], error: "truncated" };
        continue;
      }
      try {
        const result = await runTool(tool, call.name, call.input, ctx, { ...actor, via: "agent" }, locale);
        let text = JSON.stringify(result ?? { ok: true });
        if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}… [truncated]`;
        results.push({ type: "tool_result", tool_use_id: call.id, content: text });
        yield { type: "tool_end", id: call.id, ok: true, links: linksOf(result) };
      } catch (e) {
        const msg = (e as Error).message || "Tool failed.";
        log.warn("agent.tool_error", { tool: call.name, err: msg });
        results.push({ type: "tool_result", tool_use_id: call.id, is_error: true, content: msg });
        yield { type: "tool_end", id: call.id, ok: false, links: [], error: msg };
      }
    }
    const toolMessage: StoredMessage = { role: "user", content: results };
    await appendMessage(ctx, conversationId, toolMessage);
    history.push(toolMessage);
    messages = [...messages, { role: "user", content: results }];
  }
  yield { type: "error", code: "limit" };
}
