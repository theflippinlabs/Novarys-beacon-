import type { ChatItem } from "@/components/agent/chat";
import { mediaUrl } from "@/services/media";
import type { StoredMessage } from "./store";
import { AGENT_TOOLS } from "./tools";

type AnyBlock = { type: string; [k: string]: unknown };

function linksIn(text: string): string[] {
  try {
    const found = new Set<string>();
    const walk = (v: unknown, d: number) => {
      if (d > 4 || found.size >= 3) return;
      if (Array.isArray(v)) v.slice(0, 5).forEach((x) => walk(x, d + 1));
      else if (v && typeof v === "object")
        for (const [k, x] of Object.entries(v)) {
          if (k === "link" && typeof x === "string" && /^\/(?!\/)/.test(x)) found.add(x);
          else walk(x, d + 1);
        }
    };
    walk(JSON.parse(text), 0);
    return [...found];
  } catch {
    return [];
  }
}

/** Turn the stored API transcript into chat bubbles (thinking blocks are never shown). */
export function toChatItems(messages: StoredMessage[]): ChatItem[] {
  const labels = new Map(AGENT_TOOLS.map((t) => [t.name, t.label]));
  const items: ChatItem[] = [];
  let n = 0;
  const key = () => `h${n++}`;
  for (const m of messages) {
    const blocks = m.content as AnyBlock[];
    if (m.role === "user") {
      const results = blocks.filter((b) => b.type === "tool_result");
      for (const r of results) {
        const id = String(r.tool_use_id);
        const content = typeof r.content === "string" ? r.content : "";
        const it = items.find((x) => x.kind === "tool" && x.id === id);
        if (it && it.kind === "tool") Object.assign(it, { status: r.is_error ? "error" : "ok", links: r.is_error ? [] : linksIn(content), error: r.is_error ? content : undefined });
      }
      const text = blocks
        .filter((b) => b.type === "text")
        .map((b) => String(b.text))
        .join("\n");
      const images = blocks
        .filter((b) => b.type === "image" && (b.source as { type?: string })?.type === "beacon_media")
        .map((b) => mediaUrl(String((b.source as { media_id: string }).media_id)));
      if (text || images.length) items.push({ kind: "user", key: key(), text, images });
    } else {
      let buf = "";
      const flush = () => {
        if (buf.trim()) items.push({ kind: "assistant", key: key(), text: buf });
        buf = "";
      };
      for (const b of blocks) {
        if (b.type === "text") buf += String(b.text);
        else if (b.type === "tool_use") {
          flush();
          items.push({ kind: "tool", key: key(), id: String(b.id), label: labels.get(String(b.name)) ?? String(b.name), status: "running", links: [] });
        }
      }
      flush();
    }
  }
  // A tool that never got a result was interrupted.
  for (const it of items) if (it.kind === "tool" && it.status === "running") it.status = "error";
  return items;
}
