import Link from "next/link";
import type { ChatItem } from "@/components/agent/chat";
import { AgentChat } from "@/components/agent/chat";
import { listConversations } from "@/agent/store";
import { deleteConversationAction } from "@/app/actions/agent";
import { getI18n } from "@/i18n/server";
import type { AuthContext } from "@/lib/auth/service";

/** Shared layout for /agent and /agent/[id]. */
export async function AgentView({ ctx, conversationId, title, items, initialInput }: { ctx: AuthContext; conversationId: string | null; title?: string; items: ChatItem[]; initialInput?: string }) {
  const { t, intl } = await getI18n();
  const history = await listConversations(ctx);
  return (
    <div className="mx-auto max-w-3xl">
      <header className="mb-5 flex flex-col gap-3 border-b border-line pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="eyebrow mb-1">{t("Beacon agent")}</div>
          <h1 className="text-gradient-gold line-clamp-2 text-xl font-semibold tracking-tight md:text-2xl">{title ?? t("What should we do today?")}</h1>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {history.length > 0 && (
            <details className="relative">
              <summary className="cursor-pointer list-none rounded-full border border-line-strong px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-chrome hover:text-platinum">{t("History")}</summary>
              <div className="absolute right-0 z-30 mt-2 max-h-80 w-72 overflow-y-auto rounded-xl border border-line-strong bg-panel p-1 shadow-xl">
                {history.map((c) => (
                  <Link key={c.id} href={`/agent/${c.id}`} className={`block rounded-lg px-3 py-2 text-sm hover:bg-panel-2 ${c.id === conversationId ? "text-platinum" : "text-chrome"}`}>
                    <div className="truncate">{c.title}</div>
                    <div className="text-[10px] text-muted">{c.updatedAt.toLocaleString(intl, { dateStyle: "medium", timeStyle: "short" })}</div>
                  </Link>
                ))}
              </div>
            </details>
          )}
          {conversationId && (
            <form action={deleteConversationAction}>
              <input type="hidden" name="id" value={conversationId} />
              <button className="rounded-full border border-line-strong px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-muted hover:border-crit/60 hover:text-crit">{t("Delete")}</button>
            </form>
          )}
          <Link href="/agent" className="rounded-full bg-gradient-to-b from-gold-bright to-gold px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-obsidian">
            {t("New")}
          </Link>
        </div>
      </header>
      <AgentChat key={conversationId ?? `new:${initialInput ?? ""}`} conversationId={conversationId} initialItems={items} initialInput={initialInput} />
    </div>
  );
}
