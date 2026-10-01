"use client";

import { useRef, useState } from "react";
import { useI18n } from "@/i18n/client";
import { IMAGE_ACCEPT, prepare } from "./photo-upload";

/**
 * A URL input with a "Choose an image" button right next to it: the picked
 * image (photo library, camera or files on iPhone) is uploaded immediately and
 * its address fills the field, so saving the form saves the image.
 */
export function ImageUrlField({ name, defaultValue, productId, placeholder = "https://…" }: { name: string; defaultValue?: string | null; productId?: string; placeholder?: string }) {
  const { t } = useI18n();
  const [value, setValue] = useState(defaultValue ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function pick(files: FileList | null) {
    const file = files?.[0];
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const ready = await prepare(file, true);
      const fd = new FormData();
      fd.append("file", ready, ready.name || file.name);
      if (productId) fd.append("productId", productId);
      const res = await fetch("/api/media/upload", { method: "POST", body: fd });
      const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
      if (!res.ok || !data.url) throw new Error(data.error ?? "Upload failed");
      setValue(data.url);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  const preview = /^https?:\/\/[^\s]+\/api\/media\/[0-9a-f-]{36}$/i.test(value) || value.startsWith("/api/media/") ? value : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-stretch gap-2">
        {preview && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt={t("Current logo")} className="h-11 w-11 shrink-0 border border-line bg-obsidian object-contain" />
        )}
        <input name={name} type="url" value={value} onChange={(e) => setValue(e.target.value)} placeholder={placeholder} className="min-w-0 flex-1" />
      </div>
      <input ref={fileRef} type="file" accept={IMAGE_ACCEPT} className="hidden" onChange={(e) => void pick(e.target.files)} />
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        disabled={busy}
        className="inline-flex items-center justify-center gap-2 self-start rounded border border-dashed border-blue/60 px-4 py-2.5 font-mono text-[11px] uppercase tracking-[0.14em] text-platinum hover:border-blue-bright disabled:opacity-50"
      >
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden className="text-blue-bright">
          <rect x="3" y="5" width="18" height="15" rx="2.5" />
          <circle cx="9" cy="10.5" r="1.8" />
          <path d="M21 16l-5-5-8 9" />
        </svg>
        {busy ? t("Uploading…") : preview ? t("Choose another image") : t("Choose an image")}
      </button>
      {error && (
        <span role="alert" className="text-[11px] text-crit">
          {t(error)}
        </span>
      )}
    </div>
  );
}
