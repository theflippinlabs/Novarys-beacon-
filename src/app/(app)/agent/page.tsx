import type { Metadata } from "next";
import { getT } from "@/i18n/server";
import { requireAuth } from "@/lib/auth/session";
import { AgentView } from "./agent-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Agent") };
}

export default async function AgentPage() {
  const ctx = await requireAuth();
  return <AgentView ctx={ctx} conversationId={null} items={[]} />;
}
