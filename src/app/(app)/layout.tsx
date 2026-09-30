import { logoutAction } from "@/app/actions/auth";
import { Nav } from "@/components/shell/nav";
import { requireAuth } from "@/lib/auth/session";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireAuth();
  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="sticky top-0 z-20 border-b border-line bg-obsidian/95 backdrop-blur lg:h-screen lg:border-b-0 lg:border-r">
        <div className="flex h-full flex-col">
          <div className="flex items-center justify-between px-4 py-4 lg:block lg:px-5 lg:py-6">
            <div>
              <div className="flex items-center gap-2">
                <span className="inline-block h-2.5 w-2.5 rotate-45 bg-gold" aria-hidden />
                <span className="font-mono text-xs uppercase tracking-[0.3em] text-platinum">Beacon</span>
              </div>
              <div className="eyebrow mt-1.5 hidden lg:block">{ctx.org.branding.displayName ?? ctx.org.name}</div>
            </div>
            <form action={logoutAction} className="lg:hidden">
              <button className="eyebrow hover:text-chrome">Sign out</button>
            </form>
          </div>
          <div className="px-2 pb-2 lg:flex-1 lg:overflow-y-auto">
            <Nav />
          </div>
          <div className="hidden border-t border-line px-5 py-4 lg:block">
            <div className="truncate text-xs text-chrome">{ctx.user.name}</div>
            <div className="eyebrow mt-0.5">{ctx.role}</div>
            <form action={logoutAction} className="mt-3">
              <button className="eyebrow hover:text-chrome">Sign out →</button>
            </form>
          </div>
        </div>
      </aside>
      <main className="min-w-0 px-4 py-8 sm:px-8 lg:px-12">
        <div className="mx-auto max-w-[1400px]">{children}</div>
      </main>
    </div>
  );
}
