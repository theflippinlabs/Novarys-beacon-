import { and, asc, desc, eq, sql } from "drizzle-orm";
import { withOrg, type Tx } from "@/db";
import { agentConversations, agentMessages } from "@/db/schema";
import type { AuthContext } from "@/lib/auth/service";
import type { SeqMessage, SummaryNote } from "./window";

export type StoredMessage = { role: "user" | "assistant"; content: unknown[] };

/** Conversations are private to the member who started them. */
const owned = (ctx: AuthContext) => and(eq(agentConversations.organizationId, ctx.org.id), eq(agentConversations.userId, ctx.user.id));

export function listConversations(ctx: AuthContext, limit = 30) {
  return withOrg(ctx.org.id, (tx) =>
    tx
      .select({ id: agentConversations.id, title: agentConversations.title, updatedAt: agentConversations.updatedAt })
      .from(agentConversations)
      .where(owned(ctx))
      .orderBy(desc(agentConversations.updatedAt))
      .limit(limit),
  );
}

export async function loadConversation(ctx: AuthContext, id: string) {
  return withOrg(ctx.org.id, async (tx) => {
    const [conv] = await tx.select().from(agentConversations).where(and(owned(ctx), eq(agentConversations.id, id)));
    if (!conv) return null;
    const rows = await tx
      .select({ role: agentMessages.role, content: agentMessages.content })
      .from(agentMessages)
      .where(and(eq(agentMessages.conversationId, id), eq(agentMessages.kind, "message")))
      .orderBy(asc(agentMessages.seq));
    return { conversation: conv, messages: rows as StoredMessage[] };
  });
}

/**
 * Everything the agent loop needs to build what it sends: every message with
 * its seq, plus the latest running summary note (if the conversation got long).
 */
export async function loadAgentHistory(ctx: AuthContext, id: string): Promise<{ messages: SeqMessage[]; summary: SummaryNote | null } | null> {
  return withOrg(ctx.org.id, async (tx) => {
    const [conv] = await tx.select({ id: agentConversations.id }).from(agentConversations).where(and(owned(ctx), eq(agentConversations.id, id)));
    if (!conv) return null;
    const rows = await tx
      .select({ seq: agentMessages.seq, role: agentMessages.role, content: agentMessages.content, kind: agentMessages.kind, through: agentMessages.summaryThroughSeq })
      .from(agentMessages)
      .where(eq(agentMessages.conversationId, id))
      .orderBy(asc(agentMessages.seq));
    let summary: SummaryNote | null = null;
    const messages: SeqMessage[] = [];
    for (const r of rows) {
      if (r.kind === "summary") {
        const text = (r.content as { type?: string; text?: string }[]).find((b) => b.type === "text")?.text;
        if (text && r.through !== null) summary = { throughSeq: r.through, text };
      } else messages.push({ seq: r.seq, role: r.role, content: r.content });
    }
    return { messages, summary };
  });
}

/** Appends a running summary note covering every message up to `throughSeq` (earlier rows are never edited). */
export async function appendSummary(ctx: AuthContext, conversationId: string, throughSeq: number, text: string) {
  await withOrg(ctx.org.id, async (tx) => {
    await lockConversation(tx, conversationId);
    const seq = await nextSeq(tx, conversationId);
    await tx.insert(agentMessages).values({ organizationId: ctx.org.id, conversationId, seq, role: "user", kind: "summary", summaryThroughSeq: throughSeq, content: [{ type: "text", text }] });
  });
}

export async function createConversation(ctx: AuthContext, title: string) {
  return withOrg(ctx.org.id, async (tx) => {
    const [row] = await tx.insert(agentConversations).values({ organizationId: ctx.org.id, userId: ctx.user.id, title: title.slice(0, 80) }).returning();
    return row;
  });
}

/** Serialises writers of one conversation: the row lock is held until the transaction ends. */
async function lockConversation(tx: Tx, conversationId: string) {
  const [row] = await tx.select({ id: agentConversations.id }).from(agentConversations).where(eq(agentConversations.id, conversationId)).for("update");
  if (!row) throw new Error("Conversation not found.");
}

async function nextSeq(tx: Tx, conversationId: string): Promise<number> {
  const [{ next }] = await tx
    .select({ next: sql<number>`coalesce(max(${agentMessages.seq}), 0) + 1` })
    .from(agentMessages)
    .where(eq(agentMessages.conversationId, conversationId));
  return Number(next);
}

/**
 * Append-only: history is replayed byte-for-byte on the next turn. Two turns
 * of the same conversation (two tabs) cannot race for a seq: the conversation
 * row is locked before the next seq is read. Returns the stored seq.
 */
export async function appendMessage(ctx: AuthContext, conversationId: string, message: StoredMessage): Promise<number> {
  return withOrg(ctx.org.id, async (tx) => {
    await lockConversation(tx, conversationId);
    const seq = await nextSeq(tx, conversationId);
    await tx.insert(agentMessages).values({ organizationId: ctx.org.id, conversationId, seq, role: message.role, content: message.content });
    await tx.update(agentConversations).set({ updatedAt: new Date() }).where(eq(agentConversations.id, conversationId));
    return seq;
  });
}

export async function deleteConversation(ctx: AuthContext, id: string) {
  await withOrg(ctx.org.id, (tx) => tx.delete(agentConversations).where(and(owned(ctx), eq(agentConversations.id, id))));
}
