"use client";

import { useI18n } from "@/i18n/client";

export function PrintButton() {
  const { t } = useI18n();
  return (
    <button type="button" onClick={() => window.print()} className="inline-flex items-center gap-2 border border-line-strong px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-platinum hover:border-blue-bright">
      {t("Print")}
    </button>
  );
}
