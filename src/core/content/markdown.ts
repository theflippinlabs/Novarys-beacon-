import { escapeHtml } from "@/core/util/text";
import { mediaIdFromUrl } from "@/core/media/image";

/**
 * Minimal, safe Markdown → HTML renderer for Beacon drafts. Input is
 * HTML-escaped FIRST, then a small subset of Markdown is transformed
 * (headings, lists, blockquotes, tables, bold/italic, links, autolinks).
 * Link targets are restricted to http(s) and site-relative paths, so user or
 * model content can never inject script, event handlers or javascript: URLs.
 * Images (`![alt](src)`) render only when `src` is this site's own uploaded
 * media (`/api/media/<uuid>`, relative or on one of `imageOrigins`); any other
 * image degrades to a plain link, so drafts never hot-link remote images.
 */
export type MarkdownOptions = { imageOrigins?: readonly string[] };

const safeHref = (raw: string) => {
  const h = raw.replace(/&amp;/g, "&");
  return /^(https?:\/\/|\/(?!\/))/i.test(h) ? escapeHtml(h) : "#";
};

function inlineWith(s: string, opts: MarkdownOptions): string {
  const imgs: string[] = [];
  return s
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt: string, h: string) => {
      const src = h.replace(/&amp;/g, "&");
      if (!mediaIdFromUrl(src, opts.imageOrigins)) return `<a href="${safeHref(h)}" rel="noopener noreferrer">${alt || "image"}</a>`;
      imgs.push(`<img src="${escapeHtml(src)}" alt="${alt}" loading="lazy" decoding="async">`);
      return `\u0000${imgs.length - 1}\u0000`;
    })
    .replace(/\{cta:([A-Z_]+)\}/g, '<span class="cta-tag">$1</span>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, h) => `<a href="${safeHref(h)}" rel="noopener noreferrer">${t}</a>`)
    .replace(/&lt;(https?:\/\/[^\s&]+)&gt;/g, (_, h) => `<a href="${safeHref(h)}" rel="noopener noreferrer">${h}</a>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])_([^_]+)_(?=$|[\s.,;:!?)])/g, "$1<em>$2</em>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\u0000(\d+)\u0000/g, (_, i: string) => imgs[Number(i)] ?? "");
}

export function renderMarkdown(md: string, opts: MarkdownOptions = {}): string {
  const inline = (s: string) => inlineWith(s, opts);
  const lines = escapeHtml(md.replace(/\u0000/g, "")).split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const lvl = Math.min(h[1].length, 4);
      out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`);
      i++;
      continue;
    }
    if (/^\|.*\|$/.test(line.trim())) {
      const rows: string[] = [];
      while (i < lines.length && /^\|.*\|$/.test(lines[i].trim())) rows.push(lines[i++].trim());
      const cells = (r: string) => r.slice(1, -1).split("|").map((c) => c.trim());
      const [head, sep, ...body] = rows;
      const hasSep = sep && /^[\s|:-]+$/.test(sep);
      out.push(
        `<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${(hasSep ? body : [sep, ...body].filter(Boolean))
          .map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table>`,
      );
      continue;
    }
    if (/^&gt;\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^&gt;\s?/.test(lines[i])) buf.push(lines[i++].replace(/^&gt;\s?/, ""));
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`);
      continue;
    }
    if (/^\s*([-*→]|\d+[.)])\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]/.test(line);
      const items: string[] = [];
      while (i < lines.length && /^\s*([-*→]|\d+[.)])\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*→]|\d+[.)])\s+/, ""));
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((it) => `<li>${inline(it)}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|&gt;|\||\s*([-*→]|\d+[.)])\s)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}
