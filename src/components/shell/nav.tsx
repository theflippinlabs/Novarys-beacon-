"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  ["/", "Overview"],
  ["/products", "Products"],
  ["/discovery", "Discovery"],
  ["/queries", "Queries"],
  ["/content", "Content"],
  ["/distribution", "Distribution"],
  ["/ai-visibility", "AI Visibility"],
  ["/opportunities", "Opportunities"],
  ["/conversions", "Conversions"],
  ["/referrals", "Referrals"],
  ["/revenue", "Revenue"],
  ["/autopilot", "Autopilot"],
  ["/settings", "Settings"],
] as const;

export function Nav() {
  const path = usePathname();
  return (
    <nav className="flex gap-0.5 overflow-x-auto lg:flex-col" aria-label="Primary">
      {NAV.map(([href, label], i) => {
        const active = href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={`group flex items-center gap-3 whitespace-nowrap border-l-2 px-3 py-2 font-mono text-[11px] uppercase tracking-[0.16em] transition-colors ${active ? "border-gold bg-panel-2 text-platinum" : "border-transparent text-muted hover:text-chrome"}`}
          >
            <span className={`hidden w-5 text-[9px] lg:inline ${active ? "text-gold" : "text-line-strong group-hover:text-muted"}`}>{String(i + 1).padStart(2, "0")}</span>
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
