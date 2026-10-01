import type Anthropic from "@anthropic-ai/sdk";

type Block = Anthropic.Beta.BetaContentBlockParam;
type Msg = Anthropic.Beta.BetaMessageParam;

/**
 * If a turn was interrupted between a tool call and its result (crash,
 * redeploy), give each orphaned tool_use an error result so the transcript
 * stays valid. Only fills gaps; never rewrites content that was sent.
 */
export function repairToolPairs(input: Msg[]): Msg[] {
  const messages = [...input];
  const out: Msg[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    out.push(m);
    if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
    const ids = m.content.filter((b): b is Anthropic.Beta.BetaToolUseBlockParam => b.type === "tool_use").map((b) => b.id);
    if (!ids.length) continue;
    const next = messages[i + 1];
    const answered = new Set(
      next?.role === "user" && Array.isArray(next.content)
        ? next.content.filter((b): b is Anthropic.Beta.BetaToolResultBlockParam => b.type === "tool_result").map((b) => b.tool_use_id)
        : [],
    );
    const missing: Block[] = ids.filter((id) => !answered.has(id)).map((id) => ({ type: "tool_result", tool_use_id: id, is_error: true, content: "Interrupted before this tool finished." }));
    if (!missing.length) continue;
    if (next?.role === "user") {
      messages[i + 1] = { role: "user", content: [...missing, ...(Array.isArray(next.content) ? next.content : [{ type: "text" as const, text: next.content }])] };
    } else out.push({ role: "user", content: missing });
  }
  return out;
}

