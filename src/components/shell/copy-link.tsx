"use client";

import { useState } from "react";
import { useI18n } from "@/i18n/client";

/** Read-only link with a copy button (invitation links shown once to the admin). */
export function CopyLink({ value, label }: { value: string; label: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
      <input readOnly value={value} aria-label={label} onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1 font-mono text-xs" />
      <button
        type="button"
        className="rounded-full border border-line-strong px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-chrome hover:border-blue-bright hover:text-platinum"
        onClick={async () => {
          try {
            await navigator.clipboard.writeText(value);
            setCopied(true);
          } catch {
            setCopied(false);
          }
        }}
      >
        {copied ? t("Copied") : t("Copy link")}
      </button>
    </div>
  );
}
