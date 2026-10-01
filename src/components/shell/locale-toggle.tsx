"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { LOCALE_COOKIE, LOCALES } from "@/i18n/core";
import { useI18n } from "@/i18n/client";

/** EN / FR switch. Stores the choice in a cookie and re-renders the server tree. */
export function LocaleToggle({ className = "" }: { className?: string }) {
  const { locale, t } = useI18n();
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <div role="group" aria-label={t("Language")} className={`inline-flex shrink-0 overflow-hidden rounded-full border border-line-strong p-0.5 ${pending ? "opacity-60" : ""} ${className}`}>
      {LOCALES.map((l) => (
        <button
          key={l}
          type="button"
          lang={l}
          aria-pressed={l === locale}
          onClick={() => {
            if (l === locale) return;
            document.cookie = `${LOCALE_COOKIE}=${l}; path=/; max-age=31536000; samesite=lax`;
            start(() => router.refresh());
          }}
          className={`rounded-full px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] transition-colors ${l === locale ? "bg-gradient-to-b from-gold-bright to-gold text-obsidian" : "text-muted hover:text-chrome"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}
