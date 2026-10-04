"use client";

import type { ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useI18n } from "@/i18n/client";

const VARIANTS = {
  gold: "bg-gradient-to-b from-gold-bright to-gold text-obsidian hover:brightness-110 border-gold",
  ghost: "bg-transparent text-platinum border-line-strong hover:border-blue-bright",
} as const;

/**
 * Submit button that shows the request is running and cannot be pressed
 * twice. Used where the server is deliberately slow (password hashing), so
 * a person does not resubmit while waiting.
 */
export function SubmitButton({ children, variant = "gold" }: { children: ReactNode; variant?: keyof typeof VARIANTS }) {
  const { pending } = useFormStatus();
  const { t } = useI18n();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={`inline-flex min-h-10 items-center gap-2 border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors disabled:cursor-wait disabled:opacity-60 md:min-h-0 ${VARIANTS[variant]}`}
    >
      {pending ? t("Please wait…") : children}
    </button>
  );
}
