import type { Metadata } from "next";
import { getT } from "@/i18n/server";
import { requireAuth } from "@/lib/auth/session";
import { AgentView } from "./agent-view";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Agent") };
}

/** `/agent?q=...` (from the command palette) prefills the message box; the user still presses Send. */
export default async function AgentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const ctx = await requireAuth();
  const q = (await searchParams).q;
  const prefill = typeof q === "string" ? q.replace(/[\u0000-\u0008\u000b-\u001f]/g, "").slice(0, 2000) : undefined;
  return <AgentView ctx={ctx} conversationId={null} items={[]} initialInput={prefill} />;
}
