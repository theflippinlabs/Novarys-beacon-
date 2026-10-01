import { hmac } from "@/lib/security/crypto";

/**
 * Confirmation step for impactful agent writes (changing a product's domain
 * or status). The tool does not run: it answers `needs_confirmation` with a
 * summary and an id bound to the conversation, the tool and its exact input.
 * The id becomes valid only when the user presses Confirm in the chat (the UI
 * sends it with the next turn); the model cannot confirm on its own.
 */
export function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (v && typeof v === "object")
    return `{${Object.keys(v as Record<string, unknown>)
      .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(v);
}

export function confirmationId(conversationId: string, tool: string, input: unknown): string {
  return hmac(`${conversationId}|${tool}|${stableStringify(input)}`, "agent-confirm").slice(0, 32);
}

export type NeedsConfirmation = { status: "needs_confirmation"; confirmation_id: string; summary: string; instructions: string };

export function needsConfirmation(id: string, summary: string): NeedsConfirmation {
  return {
    status: "needs_confirmation",
    confirmation_id: id,
    summary,
    instructions: "Nothing was changed. Tell the user in one sentence what will change and ask them to press Confirm or Cancel below your message. If they confirm, call this tool again with exactly the same input.",
  };
}

export const isNeedsConfirmation = (v: unknown): v is NeedsConfirmation =>
  Boolean(v && typeof v === "object" && (v as NeedsConfirmation).status === "needs_confirmation" && typeof (v as NeedsConfirmation).confirmation_id === "string");
