"use client";

import { useRef, useState } from "react";
import { useI18n } from "@/i18n/client";

/**
 * Multiline secret (e.g. a service account key) with a file picker: on a
 * phone, loading the downloaded .json file avoids copy and paste, which
 * alters quotes and line breaks. The file is read in the browser and only
 * submitted with the form, like a pasted value.
 */
export function SecretFileField({ name }: { name: string }) {
  const { t } = useI18n();
  const area = useRef<HTMLTextAreaElement>(null);
  const [loaded, setLoaded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <label className="inline-flex w-fit cursor-pointer items-center rounded-full border border-line-strong px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] text-chrome hover:border-blue-bright hover:text-platinum">
        {t("Choose the JSON file")}
        <input
          type="file"
          accept=".json,application/json,text/plain"
          className="sr-only"
          onChange={async (e) => {
            const file = e.currentTarget.files?.[0];
            setError(null);
            setLoaded(null);
            if (!file) return;
            if (file.size > 20_000) return setError(t("This file is too large to be a key file."));
            const text = await file.text();
            if (area.current) area.current.value = text;
            setLoaded(file.name);
          }}
        />
      </label>
      {loaded && <p className="text-[11px] text-ok">{t("Loaded: {name}. Now choose Save.", { name: loaded })}</p>}
      {error && <p className="text-[11px] text-crit">{error}</p>}
      <textarea ref={area} name={name} className="min-h-24 font-mono text-[11px]" autoComplete="off" placeholder={t("Or paste the content of the file here")} />
    </div>
  );
}
