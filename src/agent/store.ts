import { and, asc, desc, eq, sql } from "drizzle-orm";
import { withOrg } from "@/db";
import { agentConversations, agentMessages } from "@/db/schema";
import type { AuthContext } from "@/lib/auth/service";

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
    const rows = await tx.select({ role: agentMessages.role, content: agentMessages.content }).from(agentMessages).where(eq(agentMessages.conversationId, id)).orderBy(asc(agentMessages.seq));
    return { conversation: conv, messages: rows as StoredMessage[] };
  });
}

export async function createConversation(ctx: AuthContext, title: string) {
  return withOrg(ctx.org.id, async (tx) => {
    const [row] = await tx.insert(agentConversations).values({ organizationId: ctx.org.id, userId: ctx.user.id, title: title.slice(0, 80) }).returning();
    return row;
  });
}

/** Append-only: history is replayed byte-for-byte on the next turn. */
export async function appendMessage(ctx: AuthContext, conversationId: string, message: StoredMessage) {
  await withOrg(ctx.org.id, async (tx) => {
    const [{ next }] = await tx
      .select({ next: sql<number>`coalesce(max(${agentMessages.seq}), 0) + 1` })
      .from(agentMessages)
      .where(eq(agentMessages.conversationId, conversationId));
    await tx.insert(agentMessages).values({ organizationId: ctx.org.id, conversationId, seq: Number(next), role: message.role, content: message.content });
    await tx.update(agentConversations).set({ updatedAt: new Date() }).where(eq(agentConversations.id, conversationId));
  });
}

export async function deleteConversation(ctx: AuthContext, id: string) {
  await withOrg(ctx.org.id, (tx) => tx.delete(agentConversations).where(and(owned(ctx), eq(agentConversations.id, id))));
}
