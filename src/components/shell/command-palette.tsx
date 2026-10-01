"use client";

import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, useTransition, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { runAuditAction } from "@/app/actions/discovery";
import { gapDraftAction } from "@/app/actions/intel";
import { runProductAnalysisAction } from "@/app/actions/products";
import { generateReportAction } from "@/app/actions/reports";
import { rankItems } from "@/core/command/fuzzy";
import { useI18n } from "@/i18n/client";
import { SECTIONS } from "./nav";

const OPEN_EVENT = "beacon:open-palette";

/** Opens the command palette from anywhere (search buttons, other components). */
export function openCommandPalette() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

type Group = "commands" | "navigation" | "results" | "agent";
type Item = {
  key: string;
  group: Group;
  label: string;
  detail?: string | null;
  keywords?: string[];
  /** Navigate to this app path. */
  href?: string;
  /** Run an existing server action (it redirects with a flash message). */
  run?: () => Promise<unknown>;
};

type Context = {
  products: { id: string; name: string; slug: string; crawlable: boolean }[];
  latestAuditId: string | null;
  clusters: { id: string; name: string; productId: string }[];
  can: { productWrite: boolean; jobRun: boolean; contentWrite: boolean };
};
type Hit = { kind: string; id: string; label: string; detail: string | null; href: string };

const EXTRA_PAGES: { href: string; label: string }[] = [
  { href: "/discovery/domains", label: "Domains" },
  { href: "/discovery/links", label: "Internal links" },
  { href: "/discovery/history", label: "Crawl history" },
  { href: "/queries/search", label: "Search performance" },
  { href: "/settings/integrations", label: "Integrations" },
  { href: "/settings/health", label: "Health" },
  { href: "/settings/audit", label: "Audit log" },
];

const KIND_LABEL: Record<string, string> = {
  product: "Product",
  opportunity: "Opportunity",
  content: "Content",
  query: "Query",
  cluster: "Query cluster",
  audit: "Audit",
  report: "Report",
};

function form(fields: Record<string, string>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

/** Search button for the mobile header and the desktop sidebar. */
export function SearchButton({ variant }: { variant: "mobile" | "sidebar" }) {
  const { t } = useI18n();
  // Platform detection on the client only (the server renders the generic shortcut).
  const mac = useSyncExternalStore(
    () => () => undefined,
    () => /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent),
    () => false,
  );
  if (variant === "mobile")
    return (
      <button type="button" onClick={openCommandPalette} aria-label={t("Search and commands")} aria-haspopup="dialog" className="grid h-9 w-9 place-items-center rounded-full border border-line-strong text-chrome hover:text-platinum">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
          <circle cx="11" cy="11" r="6.5" />
          <path d="M20.5 20.5l-4.8-4.8" />
        </svg>
      </button>
    );
  return (
    <button
      type="button"
      onClick={openCommandPalette}
      aria-haspopup="dialog"
      aria-keyshortcuts="Control+K Meta+K"
      className="mx-1 mb-3 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-lg border border-line bg-panel/60 px-3 py-2 text-left text-xs text-muted hover:border-blue-bright hover:text-chrome"
    >
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
        <circle cx="11" cy="11" r="6.5" />
        <path d="M20.5 20.5l-4.8-4.8" />
      </svg>
      <span className="flex-1">{t("Search or run a command")}</span>
      <kbd className="rounded border border-line-strong px-1.5 font-mono text-[10px] text-chrome">{mac ? "⌘K" : "Ctrl K"}</kbd>
    </button>
  );
}

/**
 * Ctrl/Cmd+K command palette: navigation, workspace search (GET /api/search),
 * commands and agent hand-off. Mutating commands call existing server actions
 * (same RBAC, validation and audit as the buttons in the app); human-gated
 * steps (approve, publish, verify, submit) are never run from here, only
 * navigated to. ARIA combobox + listbox, focus trapped while open, full-screen
 * sheet on phones.
 */
export function CommandPalette() {
  const { t } = useI18n();
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  // Search results are kept with the query they answer, so stale results are never shown.
  const [found, setFound] = useState<{ q: string; hits: Hit[] }>({ q: "", hits: [] });
  const [context, setContext] = useState<Context | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);
  const listId = useId();
  const optionId = (i: number) => `${listId}-opt-${i}`;

  const show = useCallback(() => {
    restoreRef.current = document.activeElement as HTMLElement | null;
    setOpen(true);
  }, []);
  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setFound({ q: "", hits: [] });
    setActive(0);
    setError(null);
    // Return focus to what opened the palette.
    setTimeout(() => restoreRef.current?.focus?.(), 0);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open) close();
        else show();
      }
    };
    const onOpen = () => show();
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
  }, [open, show, close]);

  useEffect(() => {
    if (!open) return;
    document.body.style.overflow = "hidden";
    inputRef.current?.focus();
    if (!context)
      fetch("/api/search?context=1")
        .then((r) => (r.ok ? (r.json() as Promise<Context>) : null))
        .then((c) => c && setContext(c))
        .catch(() => undefined);
    return () => {
      document.body.style.overflow = "";
    };
  }, [open, context]);

  // Debounced entity search.
  const trimmed = query.trim();
  const hits = useMemo(() => (trimmed.length >= 2 && found.q === trimmed ? found.hits : []), [trimmed, found]);
  const loading = trimmed.length >= 2 && found.q !== trimmed;
  useEffect(() => {
    if (!open || trimmed.length < 2) return;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, { signal: ac.signal })
        .then((r) => (r.ok ? (r.json() as Promise<{ results: Hit[] }>) : { results: [] }))
        .then((d) => setFound({ q: trimmed, hits: d.results }))
        .catch(() => {
          if (!ac.signal.aborted) setFound({ q: trimmed, hits: [] });
        });
    }, 150);
    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [trimmed, open]);

  const staticItems = useMemo<Item[]>(() => {
    const items: Item[] = [];
    const c = context;
    if (c?.can.productWrite) items.push({ key: "cmd:add-product", group: "commands", label: t("Add product"), keywords: ["new product", "create product"], href: "/products" });
    if (c?.can.jobRun) {
      for (const p of c.products.filter((x) => x.crawlable))
        items.push({ key: `cmd:crawl:${p.id}`, group: "commands", label: t("Run crawl: {product}", { product: p.name }), keywords: ["crawl", "audit", "seo", p.slug], run: () => runAuditAction(form({ productId: p.id, _back: pathname })) });
      for (const p of c.products) items.push({ key: `cmd:analyze:${p.id}`, group: "commands", label: t("Analyze {product}", { product: p.name }), keywords: ["analyze", "analysis", p.slug], run: () => runProductAnalysisAction(form({ productId: p.id, _back: pathname })) });
      items.push({ key: "cmd:report", group: "commands", label: t("Generate weekly report"), keywords: ["report", "weekly"], run: () => generateReportAction(form({ _back: pathname })) });
    }
    items.push({ key: "cmd:critical", group: "commands", label: t("Show critical issues"), keywords: ["critical", "seo issues", "errors"], href: c?.latestAuditId ? `/discovery/audits/${c.latestAuditId}?severity=CRITICAL` : "/discovery" });
    items.push({ key: "cmd:gaps", group: "commands", label: t("Find content gaps"), keywords: ["gaps", "coverage"], href: "/queries#gaps" });
    items.push({ key: "cmd:opps", group: "commands", label: t("Show high-impact opportunities"), keywords: ["opportunities", "high potential"], href: "/opportunities?potential=HIGH" });
    if (c?.can.contentWrite)
      for (const cl of c.clusters) items.push({ key: `cmd:draft:${cl.id}`, group: "commands", label: t("Create draft for query cluster: {cluster}", { cluster: cl.name }), keywords: ["draft", "content", "cluster"], run: () => gapDraftAction(form({ productId: cl.productId, clusterId: cl.id, _back: pathname })) });
    for (const s of SECTIONS) items.push({ key: `nav:${s.href}`, group: "navigation", label: t(s.label), keywords: [s.label, s.href], href: s.href });
    for (const s of EXTRA_PAGES) items.push({ key: `nav:${s.href}`, group: "navigation", label: t(s.label), keywords: [s.label, s.href], href: s.href });
    return items;
  }, [context, t, pathname]);

  const items = useMemo<Item[]>(() => {
    const q = query.trim();
    const base = q
      ? rankItems(q, staticItems, 12)
      : [...staticItems.filter((i) => i.group === "commands").slice(0, 6), ...staticItems.filter((i) => i.group === "navigation")];
    const results: Item[] = hits.map((h) => ({ key: `res:${h.kind}:${h.id}`, group: "results", label: h.label, detail: [t(KIND_LABEL[h.kind] ?? h.kind), h.detail].filter(Boolean).join(" · "), href: h.href }));
    const ask: Item[] = q ? [{ key: "agent", group: "agent", label: t("Ask the agent: {text}", { text: q }), href: `/agent?q=${encodeURIComponent(q)}` }] : [];
    return [...base.filter((i) => i.group === "commands"), ...results, ...base.filter((i) => i.group === "navigation"), ...ask];
  }, [query, staticItems, hits, t]);

  const current = Math.min(active, Math.max(0, items.length - 1));

  function execute(item: Item | undefined) {
    if (!item || pending) return;
    if (item.href) {
      close();
      router.push(item.href);
      return;
    }
    if (item.run) {
      const run = item.run;
      setError(null);
      // The action redirects with a flash message (client-side navigation); its errors come back the same way.
      startTransition(async () => {
        try {
          await run();
          close();
        } catch {
          setError(t("The command could not be run. Try again."));
        }
      });
    }
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((current + 1) % Math.max(1, items.length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((current - 1 + items.length) % Math.max(1, items.length));
    } else if (e.key === "Home" && e.ctrlKey) {
      setActive(0);
    } else if (e.key === "End" && e.ctrlKey) {
      setActive(Math.max(0, items.length - 1));
    } else if (e.key === "Enter" && e.target === inputRef.current) {
      e.preventDefault();
      execute(items[current]);
    } else if (e.key === "Tab") {
      // Focus trap: cycle within the dialog.
      const focusables = [...(dialogRef.current?.querySelectorAll<HTMLElement>("input, button, [href], [tabindex]:not([tabindex='-1'])") ?? [])].filter((el) => !el.hasAttribute("disabled"));
      if (!focusables.length) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }

  useEffect(() => {
    document.getElementById(optionId(current))?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  if (!open) return null;

  const groups: { id: Group; label: string }[] = [
    { id: "commands", label: t("Commands") },
    { id: "results", label: t("Results") },
    { id: "navigation", label: t("Go to") },
    { id: "agent", label: t("Beacon agent") },
  ];
  let index = -1;

  return (
    <div className="fixed inset-0 z-50" role="presentation">
      <button type="button" tabIndex={-1} aria-hidden className="absolute inset-0 hidden bg-obsidian/70 backdrop-blur-sm sm:block" onClick={close} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("Search and commands")}
        onKeyDown={onKeyDown}
        className="pt-safe absolute inset-0 flex flex-col bg-panel sm:inset-x-0 sm:top-[12vh] sm:bottom-auto sm:mx-auto sm:max-h-[70vh] sm:w-full sm:max-w-xl sm:rounded-2xl sm:border sm:border-line-strong sm:shadow-[0_20px_60px_-20px_rgb(13_122_236/0.45)]"
      >
        <div className="flex items-center gap-2 border-b border-line px-3 py-2">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="shrink-0 text-blue-bright" aria-hidden>
            <circle cx="11" cy="11" r="6.5" />
            <path d="M20.5 20.5l-4.8-4.8" />
          </svg>
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={items.length ? optionId(current) : undefined}
            aria-label={t("Search or run a command")}
            placeholder={t("Search products, content, queries… or type a command")}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            autoComplete="off"
            spellCheck={false}
            className="min-w-0 flex-1 !border-0 !bg-transparent px-1 py-2 focus:!shadow-none"
          />
          <button type="button" onClick={close} className="rounded-full border border-line-strong px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-chrome hover:text-platinum">
            {t("Close")}
          </button>
        </div>
        <div id={listId} role="listbox" aria-label={t("Results")} className="min-h-0 flex-1 overflow-y-auto p-2">
          {groups.map((g) => {
            const inGroup = items.filter((i) => i.group === g.id);
            if (!inGroup.length) return null;
            return (
              <div key={g.id} role="group" aria-label={g.label} className="mb-2">
                <div className="eyebrow px-2 py-1" aria-hidden>
                  {g.label}
                </div>
                {inGroup.map((item) => {
                  index = items.indexOf(item);
                  const selected = index === current;
                  const i = index;
                  return (
                    <div
                      key={item.key}
                      id={optionId(i)}
                      role="option"
                      aria-selected={selected}
                      onMouseMove={() => setActive(i)}
                      onClick={() => execute(item)}
                      className={`flex cursor-pointer items-center justify-between gap-3 rounded-lg px-3 py-2.5 text-sm ${selected ? "bg-blue/15 text-platinum ring-1 ring-blue-bright/60" : "text-chrome"}`}
                    >
                      <span className="min-w-0 truncate">{item.label}</span>
                      {item.detail && <span className="shrink-0 truncate text-[11px] text-muted">{item.detail}</span>}
                      {item.run && <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.14em] text-gold">{t("Run")}</span>}
                    </div>
                  );
                })}
              </div>
            );
          })}
          {!items.length && <p className="px-3 py-6 text-center text-sm text-muted">{t("Nothing found.")}</p>}
        </div>
        <div className="pb-safe flex items-center justify-between gap-2 border-t border-line px-3 py-2 text-[11px] text-muted" aria-live="polite">
          <span>{pending ? t("Running…") : loading ? t("Searching…") : error ?? t("Enter to open, arrows to move, Esc to close.")}</span>
          <span className="hidden sm:inline">{t("Approvals and publishing stay on their pages.")}</span>
        </div>
      </div>
    </div>
  );
}
