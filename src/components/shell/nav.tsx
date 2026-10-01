"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { logoutAction } from "@/app/actions/auth";
import { useI18n } from "@/i18n/client";

type Section = { href: string; label: string; short?: string; icon: ReactNode };

/* 24px stroke icons, inline so the shell has no icon dependency. */
const I = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {d}
  </svg>
);

export const SECTIONS: Section[] = [
  { href: "/", label: "Overview", icon: I(<path d="M12 2.5l2.2 7.3L21.5 12l-7.3 2.2L12 21.5l-2.2-7.3L2.5 12l7.3-2.2z" />) },
  { href: "/products", label: "Products", icon: I(<><path d="M3.5 7.5L12 3l8.5 4.5v9L12 21l-8.5-4.5z" /><path d="M3.5 7.5L12 12l8.5-4.5M12 12v9" /></>) },
  { href: "/discovery", label: "Discovery", icon: I(<><circle cx="11" cy="11" r="6.5" /><path d="M20.5 20.5l-4.8-4.8" /></>) },
  { href: "/queries", label: "Queries", icon: I(<><path d="M4 5h16v11H9l-5 4z" /><path d="M10 9.2a2 2 0 113 1.7c-.6.3-1 .8-1 1.4" /></>) },
  { href: "/content", label: "Content", icon: I(<><path d="M6 3h9l4 4v14H6z" /><path d="M15 3v4h4M9 12h7M9 16h7" /></>) },
  { href: "/distribution", label: "Distribution", icon: I(<><circle cx="6" cy="12" r="2.2" /><circle cx="18" cy="6" r="2.2" /><circle cx="18" cy="18" r="2.2" /><path d="M8 11l8-4M8 13l8 4" /></>) },
  { href: "/ai-visibility", label: "AI Visibility", short: "AI", icon: I(<><path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" /><circle cx="12" cy="12" r="2.8" /></>) },
  { href: "/opportunities", label: "Opportunities", short: "Opport.", icon: I(<><path d="M3 17l6-6 4 4 8-8" /><path d="M15 7h6v6" /></>) },
  { href: "/conversions", label: "Conversions", icon: I(<path d="M4 4h16l-6 8v6l-4 2v-8z" />) },
  { href: "/referrals", label: "Referrals", icon: I(<><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M17 7v6M14 10h6" /></>) },
  { href: "/revenue", label: "Revenue", icon: I(<><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></>) },
  { href: "/autopilot", label: "Autopilot", icon: I(<><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.5 2" /></>) },
  { href: "/settings", label: "Settings", icon: I(<><circle cx="12" cy="12" r="3" /><path d="M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3M5.3 5.3l2.1 2.1M16.6 16.6l2.1 2.1M5.3 18.7l2.1-2.1M16.6 7.4l2.1-2.1" /></>) },
];

/** The four sections pinned to the mobile tab bar; everything else lives under "More". */
const TABS = ["/", "/products", "/content", "/opportunities"];

function isActive(path: string, href: string) {
  return href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
}

/** Desktop sidebar navigation (lg and up). */
export function Nav() {
  const path = usePathname();
  const { t } = useI18n();
  return (
    <nav className="flex flex-col gap-0.5" aria-label={t("Primary")}>
      {SECTIONS.map(({ href, label }, i) => {
        const active = isActive(path, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`group flex items-center gap-3 whitespace-nowrap border-l-2 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.16em] transition-colors ${active ? "border-blue-bright bg-gradient-to-r from-blue/15 to-transparent text-platinum" : "border-transparent text-muted hover:text-chrome"}`}
          >
            <span className={`w-5 text-[9px] ${active ? "text-blue-bright" : "text-line-strong group-hover:text-muted"}`}>{String(i + 1).padStart(2, "0")}</span>
            {t(label)}
          </Link>
        );
      })}
    </nav>
  );
}

/** Mobile bottom tab bar (below lg) with a "More" sheet for the remaining sections. */
export function MobileTabBar({ userName, role }: { userName: string; role: string }) {
  const path = usePathname();
  const { t } = useI18n();
  // The sheet remembers the path it was opened on, so navigating closes it.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === path;
  const setOpen = (v: boolean) => setOpenOn(v ? path : null);
  useEffect(() => {
    document.body.style.overflow = open ? "hidden" : "";
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  const tabs = TABS.map((h) => SECTIONS.find((s) => s.href === h)!);
  const moreActive = !TABS.some((h) => isActive(path, h));

  return (
    <>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true" aria-label={t("All sections")}>
          <button type="button" aria-label={t("Close menu")} className="absolute inset-0 bg-obsidian/70 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div className="pb-safe absolute inset-x-0 bottom-0 max-h-[85vh] overflow-y-auto rounded-t-2xl border-t border-line-strong bg-panel shadow-[0_-12px_40px_-12px_rgb(13_122_236/0.35)]">
            <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-line-strong" />
            <div className="flex items-center justify-between px-5 pb-2 pt-4">
              <div className="min-w-0">
                <div className="truncate text-sm text-platinum">{userName}</div>
                <div className="eyebrow mt-0.5">{role}</div>
              </div>
              <form action={logoutAction}>
                <button className="rounded-full border border-line-strong px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-chrome">{t("Sign out")}</button>
              </form>
            </div>
            <nav aria-label={t("All sections")} className="grid grid-cols-3 gap-2 p-4 pb-6">
              {SECTIONS.map((s) => {
                const active = isActive(path, s.href);
                return (
                  <Link
                    key={s.href}
                    href={s.href}
                    aria-current={active ? "page" : undefined}
                    className={`flex flex-col items-center gap-2 rounded-xl border px-2 py-3 text-center text-[11px] ${active ? "glow-blue border-blue bg-blue/10 text-platinum" : "border-line bg-panel-2 text-chrome"}`}
                  >
                    <span className={active ? "text-blue-bright" : "text-chrome"}>{s.icon}</span>
                    {t(s.label)}
                  </Link>
                );
              })}
            </nav>
          </div>
        </div>
      )}
      <nav aria-label={t("Tabs")} className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-obsidian/90 backdrop-blur-xl lg:hidden">
        <div className="mx-auto grid max-w-xl grid-cols-5">
          {tabs.map((s) => {
            const active = isActive(path, s.href);
            return (
              <Link key={s.href} href={s.href} aria-current={active ? "page" : undefined} className={`relative flex flex-col items-center gap-1 pb-2 pt-2.5 text-[10px] ${active ? "text-platinum" : "text-muted"}`}>
                {active && <span className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-blue-bright shadow-[0_0_10px_rgb(26_189_245)]" />}
                <span className={active ? "text-blue-bright" : ""}>{s.icon}</span>
                {t(s.short ?? s.label)}
              </Link>
            );
          })}
          <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} className={`relative flex flex-col items-center gap-1 pb-2 pt-2.5 text-[10px] ${moreActive || open ? "text-platinum" : "text-muted"}`}>
            {moreActive && <span className="absolute inset-x-5 top-0 h-0.5 rounded-full bg-blue-bright shadow-[0_0_10px_rgb(26_189_245)]" />}
            <span className={moreActive || open ? "text-blue-bright" : ""}>
              {I(
                <>
                  <circle cx="5" cy="12" r="1.4" />
                  <circle cx="12" cy="12" r="1.4" />
                  <circle cx="19" cy="12" r="1.4" />
                </>,
              )}
            </span>
            {t("More")}
          </button>
        </div>
      </nav>
    </>
  );
}
