"use client";

import { useEffect, useState } from "react";
import { consumeNewKeyAction } from "@/app/actions/products";
import { useI18n } from "@/i18n/client";

/**
 * A newly created API key, shown once: the key is kept in this component's
 * state for the current view and displayed only once its cookie has been
 * cleared, so a reload after the key was seen (or the refresh that clearing
 * the cookie triggers) never shows it again.
 */
export function NewKeyNotice({ value, slug }: { value: string | null; slug: string }) {
  const { t } = useI18n();
  const [key, setKey] = useState(value);
  const [consumed, setConsumed] = useState<string | null>(null);
  // A key created later in the same view replaces the previous one.
  if (value && value !== key) setKey(value);
  useEffect(() => {
    if (!value) return;
    let live = true;
    // Shown even if clearing fails (the key would otherwise be lost); the cookie then expires after 2 minutes.
    consumeNewKeyAction(slug)
      .catch(() => undefined)
      .finally(() => {
        if (live) setConsumed(value);
      });
    return () => {
      live = false;
    };
  }, [value, slug]);
  if (!key || consumed !== key) return null;
  return (
    <div className="mb-6 border border-gold px-4 py-3">
      <div className="eyebrow text-gold">{t("New key (shown once)")}</div>
      <code className="num mt-1 block break-all text-sm text-platinum">{key}</code>
    </div>
  );
}
