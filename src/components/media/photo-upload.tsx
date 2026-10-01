"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useFormStatus } from "react-dom";
import { useI18n } from "@/i18n/client";

/** Formats the picker offers. On iPhone this opens Photo Library / Take Photo / Choose File. */
export const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif";

const MAX_SIDE = 2560;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
/** Keep a submit under the server-action body limit (40 MB) with room for multipart overhead. */
const MAX_TOTAL_BYTES = 38 * 1024 * 1024;
const MAX_FILES = 12;

type Item = { key: string; name: string; file: File | null; preview: string | null; error?: string };

/** Formats that may carry transparency: keep them as they are when they are already small. */
const KEEP_IF_SMALL = new Set(["image/png", "image/webp", "image/gif"]);

/**
 * Downscales a photo in the browser to at most 2560 px (JPEG) so phone photos
 * upload quickly. Safari decodes HEIC here, so iPhone photos arrive as JPEG.
 * Falls back to the original file whenever the browser cannot decode it; the
 * server validates and re-encodes everything anyway.
 */
export async function prepare(file: File, keepAlpha: boolean): Promise<File> {
  if ((KEEP_IF_SMALL.has(file.type) || keepAlpha) && file.type !== "image/heic" && file.type !== "image/heif" && file.size <= 5 * 1024 * 1024) return file;
  if (typeof createImageBitmap !== "function") return file;
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale));
    const h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      bmp.close();
      return file;
    }
    ctx.drawImage(bmp, 0, 0, w, h);
    bmp.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    canvas.width = canvas.height = 0;
    if (!blob || (blob.size >= file.size && file.type === "image/jpeg")) return file;
    return new File([blob], `${file.name.replace(/\.[^.]+$/, "") || "photo"}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
  } catch {
    return file;
  }
}

function SubmitButton({ count, disabled, kind }: { count: number; disabled: boolean; kind: "photos" | "logo" | "images" }) {
  const { pending } = useFormStatus();
  const { t } = useI18n();
  const label = pending ? t("Uploading…") : kind === "logo" ? t("Upload logo") : count === 1 ? t("Upload 1 image") : t("Upload {n} images", { n: count });
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      aria-busy={pending}
      className="inline-flex min-h-11 items-center justify-center gap-2 border border-gold bg-gradient-to-b from-gold-bright to-gold px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-obsidian transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {pending && <span aria-hidden className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-obsidian/30 border-t-obsidian" />}
      {label}
    </button>
  );
}

function PickerButton({ inputId, label, onPick, multiple }: { inputId: string; label: string; onPick: (files: File[]) => void; multiple: boolean }) {
  const { pending } = useFormStatus();
  return (
    <label
      htmlFor={inputId}
      className={`flex min-h-14 cursor-pointer items-center justify-center gap-3 border border-dashed border-blue/60 bg-obsidian/60 px-5 py-3 text-sm text-platinum transition-colors hover:border-blue-bright has-[:focus-visible]:outline has-[:focus-visible]:outline-1 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-blue-bright ${pending ? "pointer-events-none opacity-50" : ""}`}
    >
      <svg aria-hidden viewBox="0 0 24 24" className="h-6 w-6 shrink-0 text-blue-bright" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <circle cx="9" cy="10" r="1.8" />
        <path d="m21 16-5-5-8 8" />
      </svg>
      <span className="font-mono text-[12px] uppercase tracking-[0.14em]">{label}</span>
      <input
        id={inputId}
        type="file"
        accept={IMAGE_ACCEPT}
        multiple={multiple}
        disabled={pending}
        className="sr-only"
        onChange={(e) => {
          const files = Array.from(e.currentTarget.files ?? []);
          e.currentTarget.value = "";
          if (files.length) onPick(files);
        }}
      />
    </label>
  );
}

/**
 * Touch-friendly image uploader: pick (or shoot) photos, preview them, then
 * submit them to a server action as `files`. Hidden fields (target ids and
 * `_back`) are passed as children from the server page.
 */
export function PhotoUpload({ action, kind = "photos", children, compact = false }: { action: (fd: FormData) => Promise<void>; kind?: "photos" | "logo" | "images"; children?: ReactNode; compact?: boolean }) {
  const { t } = useI18n();
  const inputId = useId();
  const [items, setItems] = useState<Item[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const previews = useRef(new Set<string>());
  const multiple = kind !== "logo";

  useEffect(() => {
    const urls = previews.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const pick = async (files: File[]) => {
    setNotice(null);
    let chosen = files.filter((f) => f.type === "" || f.type.startsWith("image/"));
    if (chosen.length < files.length) setNotice(t("Only image files can be uploaded."));
    const room = multiple ? MAX_FILES - items.filter((i) => i.file).length : 1;
    if (chosen.length > room) {
      chosen = chosen.slice(0, Math.max(0, room));
      setNotice(t("You can upload up to 12 images at a time."));
    }
    if (!chosen.length) return;
    setBusy(true);
    const prepared: Item[] = [];
    for (const f of chosen) {
      const file = await prepare(f, kind === "logo");
      const preview = URL.createObjectURL(file);
      previews.current.add(preview);
      const tooBig = file.size > MAX_FILE_BYTES;
      prepared.push({ key: `${f.name}-${f.lastModified}-${Math.random().toString(36).slice(2, 8)}`, name: f.name, file: tooBig ? null : file, preview, error: tooBig ? t("The image is too large (15 MB maximum).") : undefined });
    }
    setItems((prev) => (multiple ? [...prev, ...prepared] : prepared));
    setBusy(false);
  };

  const remove = (key: string) =>
    setItems((prev) => {
      const it = prev.find((i) => i.key === key);
      if (it?.preview) {
        URL.revokeObjectURL(it.preview);
        previews.current.delete(it.preview);
      }
      return prev.filter((i) => i.key !== key);
    });

  const ready = items.filter((i) => i.file);
  const total = ready.reduce((s, i) => s + (i.file?.size ?? 0), 0);
  const overTotal = total > MAX_TOTAL_BYTES;

  const submit = async (fd: FormData) => {
    fd.delete("files");
    for (const it of ready) fd.append("files", it.file!, it.file!.name);
    await action(fd);
  };

  const pickLabel = kind === "logo" ? t("Upload a logo") : kind === "images" ? t("Add images") : t("Add photos");

  return (
    <form action={submit} className="flex flex-col gap-3">
      {children}
      <PickerButton inputId={inputId} label={pickLabel} onPick={pick} multiple={multiple} />
      {!compact && <p className="text-[11px] text-muted">{t("JPEG, PNG, WebP, GIF or HEIC, up to 15 MB each. Location and camera data are removed.")}</p>}
      <div aria-live="polite" className="text-xs">
        {busy && <span className="text-chrome">{t("Preparing images…")}</span>}
        {notice && <span className="text-warn">{notice}</span>}
        {overTotal && <span className="text-warn">{t("Too many large photos at once. Upload them in smaller batches.")}</span>}
      </div>
      {items.length > 0 && (
        <ul className="grid grid-cols-3 gap-2 sm:grid-cols-4" aria-label={t("Selected images")}>
          {items.map((it) => (
            <li key={it.key} className="relative border border-line bg-obsidian">
              {it.preview ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={it.preview}
                  alt={it.name}
                  className="aspect-square w-full object-cover"
                  onError={(e) => {
                    e.currentTarget.style.display = "none";
                  }}
                />
              ) : null}
              <div className="truncate px-1.5 py-1 text-[10px] text-muted" title={it.name}>
                {it.error ? <span className="text-crit">{it.error}</span> : it.name}
              </div>
              <button
                type="button"
                onClick={() => remove(it.key)}
                aria-label={t("Remove {name}", { name: it.name })}
                className="absolute right-1 top-1 flex h-8 w-8 items-center justify-center border border-line-strong bg-obsidian/90 text-sm text-platinum hover:border-crit hover:text-crit"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {ready.length > 0 && (
        <div>
          <SubmitButton count={ready.length} disabled={busy || overTotal} kind={kind} />
        </div>
      )}
    </form>
  );
}
