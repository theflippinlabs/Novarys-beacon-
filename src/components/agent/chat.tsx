"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { renderMarkdown } from "@/core/content/markdown";
import { useI18n } from "@/i18n/client";

export type ChatItem =
  | { kind: "user"; key: string; text: string; images: string[] }
  | { kind: "assistant"; key: string; text: string }
  | { kind: "tool"; key: string; id: string; label: string; status: "running" | "ok" | "error"; links: string[]; error?: string }
  | { kind: "notice"; key: string; tone: "error" | "info"; text: string; link?: { href: string; label: string } };

type Attachment = { localId: string; preview: string; id?: string; error?: string };

type SpeechRecognitionLike = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  start: () => void;
  stop: () => void;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
};

const SUGGESTIONS = [
  "What needs my attention today?",
  "Generate opportunities for my product and tell me the top three.",
  "Draft a LinkedIn post about my product’s strongest verified feature.",
  "Run a technical SEO audit of my product’s website.",
];

const SECTION_LABELS: Record<string, string> = {
  "": "Overview",
  agent: "Agent",
  products: "Products",
  discovery: "Discovery",
  queries: "Queries",
  content: "Content",
  distribution: "Distribution",
  "ai-visibility": "AI Visibility",
  opportunities: "Opportunities",
  conversions: "Conversions",
  referrals: "Referrals",
  revenue: "Revenue",
  autopilot: "Autopilot",
  settings: "Settings",
};

/** "/products/acme-live/knowledge" → "Products · acme-live" (readable, translated). */
function linkLabel(href: string, t: (k: string) => string) {
  const [path] = href.split(/[?#]/);
  const parts = path.split("/").filter(Boolean);
  const section = t(SECTION_LABELS[parts[0] ?? ""] ?? "Open");
  const sub = parts[1] && !/^[0-9a-f-]{36}$/i.test(parts[1]) ? ` · ${parts[1]}` : "";
  return `${section}${sub}`;
}

let seq = 0;
const nextKey = () => `k${Date.now().toString(36)}${(seq++).toString(36)}`;

/** Downscale a photo in the browser (also decodes HEIC on iPhone) before upload. */
async function downscale(file: File, max = 2048): Promise<Blob> {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext("2d")!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    return await new Promise<Blob>((res, rej) => canvas.toBlob((b) => (b ? res(b) : rej(new Error("encode"))), "image/jpeg", 0.88));
  } catch {
    return file;
  }
}

function Markdown({ text }: { text: string }) {
  return <div className="prose-beacon text-[0.95rem] [&_p]:my-1.5" dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }} />;
}

export function AgentChat({ conversationId: initialId, initialItems }: { conversationId: string | null; initialItems: ChatItem[] }) {
  const { t, locale } = useI18n();
  const [conversationId, setConversationId] = useState(initialId);
  const [items, setItems] = useState<ChatItem[]>(initialItems);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [listening, setListening] = useState(false);
  const [speak, setSpeak] = useState(false);
  const [speechSupported, setSpeechSupported] = useState(false);
  const recognition = useRef<SpeechRecognitionLike | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    // Feature detection must run after hydration (no window on the server).
    setSpeechSupported(Boolean(w.SpeechRecognition || w.webkitSpeechRecognition));
    try {
      setSpeak(localStorage.getItem("beacon_agent_speak") === "1");
    } catch {}
  }, []);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [items]);

  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [input]);

  const patch = useCallback((fn: (prev: ChatItem[]) => ChatItem[]) => setItems(fn), []);

  const say = useCallback(
    (text: string) => {
      if (!speak || typeof window === "undefined" || !("speechSynthesis" in window)) return;
      const plain = text.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*_`#>|]/g, "");
      const u = new SpeechSynthesisUtterance(plain);
      u.lang = locale === "fr" ? "fr-FR" : "en-GB";
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(u);
    },
    [speak, locale],
  );

  async function addPhotos(files: FileList | null) {
    if (!files?.length) return;
    const picked = [...files].slice(0, Math.max(0, 4 - attachments.length));
    for (const file of picked) {
      const localId = nextKey();
      const preview = URL.createObjectURL(file);
      setAttachments((a) => [...a, { localId, preview }]);
      try {
        const blob = await downscale(file);
        const fd = new FormData();
        fd.append("file", blob, file.name.replace(/\.\w+$/, "") + ".jpg");
        const res = await fetch("/api/agent/upload", { method: "POST", body: fd });
        const data = (await res.json()) as { id?: string; error?: string };
        if (!res.ok || !data.id) throw new Error(data.error ?? "Upload failed");
        setAttachments((a) => a.map((x) => (x.localId === localId ? { ...x, id: data.id } : x)));
      } catch (e) {
        setAttachments((a) => a.map((x) => (x.localId === localId ? { ...x, error: (e as Error).message } : x)));
      }
    }
    if (fileRef.current) fileRef.current.value = "";
  }

  function toggleMic() {
    if (listening) {
      recognition.current?.stop();
      return;
    }
    const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
    if (!Ctor) return;
    const rec = new Ctor();
    rec.lang = locale === "fr" ? "fr-FR" : "en-US";
    rec.interimResults = true;
    rec.continuous = false;
    const base = input ? `${input.trimEnd()} ` : "";
    rec.onresult = (e) => {
      let text = "";
      for (let i = 0; i < e.results.length; i++) text += e.results[i][0].transcript;
      setInput(base + text);
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recognition.current = rec;
    setListening(true);
    rec.start();
  }

  async function send(textOverride?: string) {
    const text = (textOverride ?? input).trim();
    const ready = attachments.filter((a) => a.id);
    if ((!text && !ready.length) || busy || attachments.some((a) => !a.id && !a.error)) return;
    recognition.current?.stop();
    setBusy(true);
    setInput("");
    setAttachments([]);
    const assistantKey = nextKey();
    let reply = "";
    patch((p) => [...p, { kind: "user", key: nextKey(), text, images: ready.map((a) => a.preview) }]);

    const abort = new AbortController();
    abortRef.current = abort;
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ conversationId, text, mediaIds: ready.map((a) => a.id) }),
        signal: abort.signal,
      });
      if (!res.ok || !res.body) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let segment = assistantKey;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const ev = JSON.parse(line) as
            | { type: "conversation"; id: string }
            | { type: "text"; delta: string }
            | { type: "tool_start"; id: string; label: string }
            | { type: "tool_end"; id: string; ok: boolean; links: string[]; error?: string }
            | { type: "error"; code: string; message?: string }
            | { type: "done" };
          if (ev.type === "conversation") {
            setConversationId(ev.id);
            window.history.replaceState(null, "", `/agent/${ev.id}`);
          } else if (ev.type === "text") {
            reply += ev.delta;
            const key = segment;
            patch((p) => {
              const i = p.findIndex((x) => x.key === key);
              if (i === -1) return [...p, { kind: "assistant", key, text: ev.delta }];
              const cur = p[i] as Extract<ChatItem, { kind: "assistant" }>;
              const copy = p.slice();
              copy[i] = { ...cur, text: cur.text + ev.delta };
              return copy;
            });
          } else if (ev.type === "tool_start") {
            patch((p) => [...p, { kind: "tool", key: nextKey(), id: ev.id, label: ev.label, status: "running", links: [] }]);
            segment = nextKey(); // text after a tool call starts a new bubble
          } else if (ev.type === "tool_end") {
            patch((p) => p.map((x) => (x.kind === "tool" && x.id === ev.id ? { ...x, status: ev.ok ? "ok" : "error", links: ev.links, error: ev.error } : x)));
          } else if (ev.type === "error") {
            const notice: ChatItem =
              ev.code === "not_connected"
                ? { kind: "notice", key: nextKey(), tone: "error", text: t("The agent needs an Anthropic API key. Add it in Settings → Integrations."), link: { href: "/settings/integrations", label: t("Open integrations →") } }
                : ev.code === "refused"
                  ? { kind: "notice", key: nextKey(), tone: "error", text: t("The AI declined this request.") }
                  : ev.code === "limit"
                    ? { kind: "notice", key: nextKey(), tone: "info", text: t("The agent reached its step limit for this request. Ask it to continue.") }
                    : { kind: "notice", key: nextKey(), tone: "error", text: ev.message ? t(ev.message) : t("Something went wrong. Try again.") };
            patch((p) => [...p, notice]);
          }
        }
      }
    } catch (e) {
      if (!abort.signal.aborted) patch((p) => [...p, { kind: "notice", key: nextKey(), tone: "error", text: t((e as Error).message || "Something went wrong. Try again.") }]);
    } finally {
      abortRef.current = null;
      setBusy(false);
      if (reply) say(reply);
    }
  }

  const pendingUploads = attachments.some((a) => !a.id && !a.error);
  const canSend = !busy && !pendingUploads && (input.trim().length > 0 || attachments.some((a) => a.id));

  return (
    <div className="flex min-h-[calc(100dvh-14rem)] flex-col lg:min-h-[calc(100dvh-10rem)]">
      <div className="flex-1 space-y-4 pb-4">
        {items.length === 0 && (
          <div className="grid gap-5 pt-2">
            <div className="flex items-center gap-3">
              <span className="glow-blue grid h-11 w-11 place-items-center rounded-full bg-panel-2 text-blue-bright">
                <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
                  <path d="M12 2.5l2.2 7.3L21.5 12l-7.3 2.2L12 21.5l-2.2-7.3L2.5 12l7.3-2.2z" />
                </svg>
              </span>
              <p className="text-sm text-chrome">{t("Ask me anything about your products, or tell me what to do — I read your Beacon data and do the work. Publishing and approvals stay with you.")}</p>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => send(t(s))} disabled={busy} className="rounded-xl border border-line bg-panel px-4 py-3 text-left text-sm text-chrome transition-colors hover:border-blue-bright hover:text-platinum">
                  {t(s)}
                </button>
              ))}
            </div>
          </div>
        )}

        {items.map((it) =>
          it.kind === "user" ? (
            <div key={it.key} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-md bg-gradient-to-b from-royal to-blue px-4 py-2.5 text-[0.95rem] text-white">
                {it.images.length > 0 && (
                  <div className="mb-2 flex flex-wrap gap-1.5">
                    {it.images.map((src) => (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img key={src} src={src} alt={t("Attached photo")} className="h-24 w-24 rounded-lg object-cover" />
                    ))}
                  </div>
                )}
                {it.text && <div className="whitespace-pre-wrap break-words">{it.text}</div>}
              </div>
            </div>
          ) : it.kind === "assistant" ? (
            <div key={it.key} className="max-w-[92%] rounded-2xl rounded-bl-md border border-line bg-panel px-4 py-2.5">
              <Markdown text={it.text} />
            </div>
          ) : it.kind === "tool" ? (
            <div key={it.key} className="flex flex-wrap items-center gap-2 pl-1 text-xs">
              <span
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.12em] ${it.status === "running" ? "border-blue/50 text-blue-bright" : it.status === "ok" ? "border-ok/40 text-ok" : "border-crit/50 text-crit"}`}
                title={it.error}
              >
                {it.status === "running" ? <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-bright" /> : it.status === "ok" ? "✓" : "✕"}
                {t(it.label)}
              </span>
              {it.links.slice(0, 2).map((href) => (
                <Link key={href} href={href} className="rounded-full border border-blue/40 px-2.5 py-1 text-[11px] text-blue-bright hover:border-blue-bright">
                  {linkLabel(href, t)} →
                </Link>
              ))}
            </div>
          ) : (
            <div key={it.key} role="status" className={`rounded-xl border px-4 py-3 text-sm ${it.tone === "error" ? "border-crit/50 text-crit" : "border-line-strong text-chrome"}`}>
              {it.text}{" "}
              {it.link && (
                <Link href={it.link.href} className="text-blue-bright underline">
                  {it.link.label}
                </Link>
              )}
            </div>
          ),
        )}
        {busy && !items.some((x) => x.kind === "tool" && x.status === "running") && (
          <div className="flex items-center gap-1.5 pl-2" aria-label={t("The agent is working")}>
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-1.5 w-1.5 animate-pulse rounded-full bg-blue-bright" style={{ animationDelay: `${i * 150}ms` }} />
            ))}
          </div>
        )}
        <div ref={endRef} />
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="sticky bottom-[calc(4.6rem+env(safe-area-inset-bottom))] z-20 rounded-2xl border border-line-strong bg-panel/95 p-2 shadow-[0_-8px_30px_-12px_rgb(0_0_0/0.8)] backdrop-blur-xl lg:bottom-4"
      >
        {attachments.length > 0 && (
          <div className="flex gap-2 overflow-x-auto px-1 pb-2">
            {attachments.map((a) => (
              <div key={a.localId} className="relative shrink-0">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={a.preview} alt="" className={`h-16 w-16 rounded-lg object-cover ${a.id ? "" : "opacity-50"}`} />
                {!a.id && !a.error && <span className="absolute inset-0 grid place-items-center text-[10px] text-platinum">{t("Uploading…")}</span>}
                {a.error && <span className="absolute inset-x-0 bottom-0 rounded-b-lg bg-crit/90 px-1 text-center text-[9px] text-white" title={t(a.error)}>{t("Failed")}</span>}
                <button type="button" onClick={() => setAttachments((x) => x.filter((y) => y.localId !== a.localId))} aria-label={t("Remove photo")} className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full bg-obsidian text-xs text-chrome ring-1 ring-line-strong">
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="flex items-end gap-1.5">
          <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/heic,image/heif" multiple className="hidden" onChange={(e) => void addPhotos(e.target.files)} />
          <button type="button" onClick={() => fileRef.current?.click()} disabled={busy || attachments.length >= 4} aria-label={t("Add a photo")} className="grid h-10 w-10 shrink-0 place-items-center rounded-full text-chrome hover:text-platinum disabled:opacity-40">
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <rect x="3" y="5" width="18" height="15" rx="2.5" />
              <circle cx="9" cy="10.5" r="1.8" />
              <path d="M21 16l-5-5-8 9" />
            </svg>
          </button>
          <textarea
            ref={textRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && window.matchMedia("(pointer: fine)").matches) {
                e.preventDefault();
                void send();
              }
            }}
            rows={1}
            placeholder={listening ? t("Listening…") : t("Message the agent…")}
            aria-label={t("Message the agent")}
            className="max-h-44 min-h-10 flex-1 resize-none !rounded-xl !border-0 !bg-transparent px-2 py-2 focus:!shadow-none"
          />
          {speechSupported && (
            <button type="button" onClick={toggleMic} disabled={busy} aria-pressed={listening} aria-label={listening ? t("Stop dictation") : t("Dictate a message")} className={`grid h-10 w-10 shrink-0 place-items-center rounded-full ${listening ? "glow-blue bg-blue/20 text-blue-bright" : "text-chrome hover:text-platinum"}`}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
                <rect x="9" y="3" width="6" height="11" rx="3" />
                <path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" />
              </svg>
            </button>
          )}
          {busy ? (
            <button type="button" onClick={() => abortRef.current?.abort()} aria-label={t("Stop")} className="grid h-10 w-10 shrink-0 place-items-center rounded-full border border-line-strong text-chrome">
              <span className="h-3 w-3 rounded-sm bg-chrome" />
            </button>
          ) : (
            <button type="submit" disabled={!canSend} aria-label={t("Send")} className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-gradient-to-b from-gold-bright to-gold text-obsidian disabled:opacity-35">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />
              </svg>
            </button>
          )}
        </div>
        <div className="flex items-center justify-between px-2 pt-1">
          <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-muted">
            <input
              type="checkbox"
              checked={speak}
              onChange={(e) => {
                setSpeak(e.target.checked);
                try {
                  localStorage.setItem("beacon_agent_speak", e.target.checked ? "1" : "0");
                } catch {}
                if (!e.target.checked) window.speechSynthesis?.cancel();
              }}
            />
            {t("Read replies aloud")}
          </label>
          <span className="text-[10px] text-muted">{conversationId ? t("Saved to your history") : t("New conversation")}</span>
        </div>
      </form>
    </div>
  );
}
