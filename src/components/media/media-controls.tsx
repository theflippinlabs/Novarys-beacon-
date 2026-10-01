"use client";

import { useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useI18n } from "@/i18n/client";

const BTN = "inline-flex min-h-9 items-center gap-2 border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] transition-colors disabled:cursor-not-allowed disabled:opacity-40";

/** Submit button that asks for confirmation first (destructive actions). */
export function ConfirmSubmit({ children, message, variant = "danger", title }: { children: ReactNode; message: string; variant?: "danger" | "ghost"; title?: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      title={title}
      disabled={pending}
      onClick={(e) => {
        if (!window.confirm(message)) e.preventDefault();
      }}
      className={`${BTN} ${variant === "danger" ? "border-crit/50 bg-transparent text-crit hover:border-crit" : "border-line-strong bg-transparent text-platinum hover:border-blue-bright"}`}
    >
      {children}
    </button>
  );
}

/** Small submit button with a pending state. */
export function PendingSubmit({ children, title }: { children: ReactNode; title?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" title={title} disabled={pending} aria-busy={pending} className={`${BTN} border-line-strong bg-transparent text-platinum hover:border-blue-bright`}>
      {children}
    </button>
  );
}

/** Copies `text` to the clipboard. */
export function CopyButton({ text, label }: { text: string; label?: string }) {
  const { t } = useI18n();
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          window.prompt(t("Copy this Markdown:"), text);
        }
      }}
      className={`${BTN} border-line-strong bg-transparent text-platinum hover:border-blue-bright`}
    >
      <span aria-live="polite">{done ? t("Copied") : (label ?? t("Copy"))}</span>
    </button>
  );
}

/** Inserts `text` at the cursor of the textarea with id `targetId` (the draft editor); the user still saves a new version. */
export function InsertButton({ text, targetId }: { text: string; targetId: string }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={() => {
        const el = document.getElementById(targetId);
        if (!(el instanceof HTMLTextAreaElement)) return;
        const start = el.selectionStart ?? el.value.length;
        const end = el.selectionEnd ?? start;
        const before = el.value.slice(0, start);
        const insert = `${before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : ""}${text}\n\n`;
        el.setRangeText(insert, start, end, "end");
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.focus();
        el.scrollIntoView({ block: "center", behavior: "smooth" });
      }}
      className={`${BTN} border-gold-dim bg-transparent text-gold-bright hover:border-gold`}
    >
      {t("Insert into draft")}
    </button>
  );
}
