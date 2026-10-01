import Image from "next/image";
import Link from "next/link";
import { logoutAction } from "@/app/actions/auth";
import { LocaleToggle } from "@/components/shell/locale-toggle";
import { CommandPalette, SearchButton } from "@/components/shell/command-palette";
import { MobileTabBar, Nav, NotificationBell } from "@/components/shell/nav";
import { withOrg } from "@/db";
import { unreadCount } from "@/services/notifications";
import { getT } from "@/i18n/server";
import { requireAuth } from "@/lib/auth/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireAuth();
  const t = await getT();
  const orgName = ctx.org.branding.displayName ?? ctx.org.name;
  const unread = await withOrg(ctx.org.id, (tx) => unreadCount(tx, ctx.org.id, ctx.user.id)).catch(() => 0);
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15rem_1fr]">
      {/* Mobile header */}
      <header className="pt-safe sticky top-0 z-30 border-b border-line bg-obsidian/85 backdrop-blur-xl lg:hidden">
        <div className="flex h-14 items-center justify-between gap-3 px-4">
          <Link href="/" className="flex min-w-0 items-center gap-2.5">
            <Image src="/brand/beacon-emblem-64.png" alt="" width={30} height={30} priority />
            <div className="min-w-0 leading-tight">
              <div className="text-gradient-chrome font-mono text-[13px] font-semibold uppercase tracking-[0.28em]">Beacon</div>
              <div className="truncate text-[10px] text-muted">{orgName}</div>
            </div>
          </Link>
          <div className="flex items-center gap-2">
            <SearchButton variant="mobile" />
            <NotificationBell unread={unread} />
            <LocaleToggle />
          </div>
        </div>
        <div className="h-px bg-gradient-to-r from-transparent via-blue/60 to-transparent" />
      </header>

      {/* Desktop sidebar */}
      <aside className="sticky top-0 z-20 hidden h-screen border-r border-line bg-obsidian/95 backdrop-blur lg:block">
        <div className="flex h-full flex-col">
          <div className="px-5 py-6">
            <div className="flex items-center gap-2">
              <Image src="/brand/beacon-emblem-64.png" alt="" width={28} height={28} priority />
              <span className="text-gradient-chrome font-mono text-xs font-semibold uppercase tracking-[0.3em]">Beacon</span>
              <NotificationBell unread={unread} className="ml-auto" />
            </div>
            <div className="eyebrow mt-1.5">{orgName}</div>
          </div>
          <div className="flex-1 overflow-y-auto px-2 pb-2">
            <SearchButton variant="sidebar" />
            <Nav />
          </div>
          <div className="border-t border-line px-5 py-4">
            <div className="truncate text-xs text-chrome">{ctx.user.name}</div>
            <div className="eyebrow mt-0.5">{t(ctx.role)}</div>
            <div className="mt-3 flex items-center justify-between gap-2">
              <form action={logoutAction}>
                <button className="eyebrow hover:text-chrome">{t("Sign out →")}</button>
              </form>
              <LocaleToggle />
            </div>
          </div>
        </div>
      </aside>

      <main className="min-w-0 overflow-x-clip px-4 pb-[calc(6rem+env(safe-area-inset-bottom))] pt-6 sm:px-8 lg:px-12 lg:py-8">
        <div className="mx-auto max-w-[1400px]">{children}</div>
      </main>

      <CommandPalette />
      <MobileTabBar userName={ctx.user.name} role={t(ctx.role)} />
    </div>
  );
}
