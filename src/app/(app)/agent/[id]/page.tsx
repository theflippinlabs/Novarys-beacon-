import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { toChatItems } from "@/agent/display";
import { loadConversation } from "@/agent/store";
import { getT } from "@/i18n/server";
import { requireAuth } from "@/lib/auth/session";
import { AgentView } from "../agent-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Agent") };
}

export default async function AgentConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await requireAuth();
  if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
  const loaded = await loadConversation(ctx, id);
  if (!loaded) notFound();
  return <AgentView ctx={ctx} conversationId={id} title={loaded.conversation.title} items={toChatItems(loaded.messages)} />;
}
