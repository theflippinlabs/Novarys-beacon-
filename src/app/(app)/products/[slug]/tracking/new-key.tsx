"use client";

import { useEffect, useState } from "react";
import { consumeNewKeyAction } from "@/app/actions/products";
import { useI18n } from "@/i18n/client";

/**
 * A newly created API key, shown once: the key is kept in this component's
 * state for the current view while its cookie is cleared right away, so a
 * reload (or the refresh that clearing the cookie triggers) never shows it again.
 */
export function NewKeyNotice({ value, slug }: { value: string | null; slug: string }) {
  const { t } = useI18n();
  const [key, setKey] = useState(value);
  // A key created later in the same view replaces the previous one.
  if (value && value !== key) setKey(value);
  useEffect(() => {
    if (value) void consumeNewKeyAction(slug);
  }, [value, slug]);
  if (!key) return null;
  return (
    <div className="mb-6 border border-gold px-4 py-3">
      <div className="eyebrow text-gold">{t("New key (shown once)")}</div>
      <code className="num mt-1 block break-all text-sm text-platinum">{key}</code>
    </div>
  );
}
