/**
 * Daily Beacon briefing (pure). A briefing stores a snapshot of measured
 * state; "since the previous analysis" lines are computed against the
 * PREVIOUS stored snapshot (not a fixed window). A source that is not
 * connected, or connected without data, yields a line in that state, never a
 * measured 0. The text is deterministic: lines carry a key, numbers and
 * links; the UI renders them through t().
 */

export type SourceState = "OK" | "NOT_CONNECTED" | "NO_DATA_YET";

export type SnapshotRef = { title: string; href: string; product?: string | null };

export type BriefingSnapshot = {
  version: 1;
  /** When the snapshot was taken (ISO). */
  at: string;
  search: {
    state: SourceState;
    provider: string | null;
    /** Newest day of imported search data and the trailing window used. */
    lastDay: string | null;
    windowStart: string | null;
    clicks: number;
    impressions: number;
    /** `${productId}::${query}` keys whose weighted position is 4 to 10 in the window. */
    top10: string[];
    /** Page URL to impressions in the window (pages with at least PAGE_MIN impressions). */
    pages: Record<string, number>;
    pagesCapped: boolean;
    /** Display data for top10 keys: query text and the link to its search page. */
    queryRefs: Record<string, SnapshotRef>;
  };
  gaps: { ids: string[]; refs: Record<string, SnapshotRef> };
  citations: { state: SourceState; ids: string[]; refs: Record<string, SnapshotRef> };
  drafts: { count: number; ids: string[] };
  signups: { state: SourceState; model: string; count: number };
  mrr: { state: SourceState; model: string; byCurrency: { currency: string; cents: number }[] };
};

export type LineState = SourceState | "BASELINE" | "NO_NEW_DATA";
export type LineKey = "CLICKS" | "IMPRESSIONS" | "ENTERED_TOP10" | "LOST_PAGES" | "NEW_GAPS" | "NEW_CITATIONS" | "DRAFTS" | "SIGNUPS_ORGANIC" | "MRR_ORGANIC";
export type LineItem = { label: string; href: string; detail?: { now: number; prev: number } };
export type BriefingLine = {
  key: LineKey;
  state: LineState;
  now: number | null;
  prev: number | null;
  /** Relative change vs the previous briefing (null when not comparable or prev is 0). */
  deltaPct: number | null;
  href: string;
  vars?: Record<string, string | number>;
  money?: { currency: string; cents: number; prev: number | null }[];
  items?: LineItem[];
};

/** Organic discovery channels (what "attributed to organic discovery" means). */
export const ORGANIC_CHANNELS = ["ORGANIC_SEARCH", "AI_REFERRAL"] as const;
/** Pages with at least this many impressions in the window are tracked for visibility loss. */
export const PAGE_MIN = 10;
/** A page "lost visibility" when it had at least LOST_MIN_PREV impressions and lost at least LOST_DROP of them. */
export const LOST_MIN_PREV = 20;
export const LOST_DROP = 0.5;
export const MAX_ITEMS = 10;

export function deltaPct(now: number, prev: number | null): number | null {
  if (prev === null || prev === 0) return null;
  return (now - prev) / prev;
}

const newIds = (cur: string[], prev: string[] | null) => {
  if (!prev) return null;
  const before = new Set(prev);
  return cur.filter((id) => !before.has(id));
};

/** Pages whose impressions fell by at least LOST_DROP since the previous snapshot (biggest loss first). */
export function lostPages(prev: Record<string, number>, cur: Record<string, number>, curCapped: boolean): { page: string; now: number; prev: number }[] {
  const out: { page: string; now: number; prev: number }[] = [];
  for (const [page, before] of Object.entries(prev)) {
    if (before < LOST_MIN_PREV) continue;
    const has = Object.prototype.hasOwnProperty.call(cur, page);
    // Absent from a capped map is unknown (it may have been cut by the cap), not a loss.
    if (!has && curCapped) continue;
    const now = has ? cur[page] : 0;
    if (now <= before * (1 - LOST_DROP)) out.push({ page, now, prev: before });
  }
  return out.sort((a, b) => b.prev - b.now - (a.prev - a.now) || a.page.localeCompare(b.page));
}

/** Briefing lines for the current snapshot compared with the previous one (null for the first briefing). */
export function briefingLines(prev: BriefingSnapshot | null, cur: BriefingSnapshot, links: { search: string; gaps: string; citations: string; drafts: string; conversions: string; revenue: string; connect: string; tracking: string }): BriefingLine[] {
  const lines: BriefingLine[] = [];
  const s = cur.search;
  const ps = prev && prev.search.state === "OK" ? prev.search : null;
  if (s.state !== "OK") {
    for (const key of ["CLICKS", "IMPRESSIONS", "ENTERED_TOP10", "LOST_PAGES"] as const) lines.push({ key, state: s.state, now: null, prev: null, deltaPct: null, href: s.state === "NOT_CONNECTED" ? links.connect : links.search });
  } else {
    const noNew = ps !== null && ps.lastDay === s.lastDay;
    const vars = { start: s.windowStart ?? "", end: s.lastDay ?? "" };
    for (const [key, now, before] of [
      ["CLICKS", s.clicks, ps?.clicks ?? null],
      ["IMPRESSIONS", s.impressions, ps?.impressions ?? null],
    ] as const)
      lines.push({ key, state: noNew ? "NO_NEW_DATA" : "OK", now, prev: before, deltaPct: deltaPct(now, before), href: links.search, vars });
    if (!ps) {
      lines.push({ key: "ENTERED_TOP10", state: "BASELINE", now: s.top10.length, prev: null, deltaPct: null, href: links.search, vars });
      lines.push({ key: "LOST_PAGES", state: "BASELINE", now: Object.keys(s.pages).length, prev: null, deltaPct: null, href: links.search, vars });
    } else {
      const entered = newIds(s.top10, ps.top10) ?? [];
      lines.push({
        key: "ENTERED_TOP10",
        state: noNew ? "NO_NEW_DATA" : "OK",
        now: entered.length,
        prev: null,
        deltaPct: null,
        href: links.search,
        vars,
        items: entered.slice(0, MAX_ITEMS).map((k) => ({ label: s.queryRefs[k]?.title ?? k.split("::").slice(1).join("::"), href: s.queryRefs[k]?.href ?? links.search })),
      });
      const lost = lostPages(ps.pages, s.pages, s.pagesCapped);
      lines.push({
        key: "LOST_PAGES",
        state: noNew ? "NO_NEW_DATA" : "OK",
        now: lost.length,
        prev: null,
        deltaPct: null,
        href: links.search,
        vars,
        items: lost.slice(0, MAX_ITEMS).map((l) => ({ label: l.page, href: links.search, detail: { now: l.now, prev: l.prev } })),
      });
    }
  }

  const gapsNew = newIds(cur.gaps.ids, prev ? prev.gaps.ids : null);
  lines.push(
    gapsNew === null
      ? { key: "NEW_GAPS", state: "BASELINE", now: cur.gaps.ids.length, prev: null, deltaPct: null, href: links.gaps }
      : { key: "NEW_GAPS", state: "OK", now: gapsNew.length, prev: null, deltaPct: null, href: links.gaps, items: gapsNew.slice(0, MAX_ITEMS).map((id) => ({ label: cur.gaps.refs[id]?.title ?? id, href: cur.gaps.refs[id]?.href ?? links.gaps })) },
  );

  if (cur.citations.state !== "OK") lines.push({ key: "NEW_CITATIONS", state: cur.citations.state, now: null, prev: null, deltaPct: null, href: cur.citations.state === "NOT_CONNECTED" ? "/ai-visibility" : links.citations });
  else {
    const citNew = newIds(cur.citations.ids, prev && prev.citations.state === "OK" ? prev.citations.ids : null);
    lines.push(
      citNew === null
        ? { key: "NEW_CITATIONS", state: "BASELINE", now: cur.citations.ids.length, prev: null, deltaPct: null, href: links.citations }
        : { key: "NEW_CITATIONS", state: "OK", now: citNew.length, prev: null, deltaPct: null, href: links.citations, items: citNew.slice(0, MAX_ITEMS).map((id) => ({ label: cur.citations.refs[id]?.title ?? id, href: cur.citations.refs[id]?.href ?? links.citations })) },
    );
  }

  const prevDrafts = prev ? prev.drafts.count : null;
  lines.push({ key: "DRAFTS", state: "OK", now: cur.drafts.count, prev: prevDrafts, deltaPct: null, href: links.drafts });

  const sg = cur.signups;
  lines.push(
    sg.state !== "OK"
      ? { key: "SIGNUPS_ORGANIC", state: sg.state, now: null, prev: null, deltaPct: null, href: links.tracking, vars: { model: sg.model } }
      : { key: "SIGNUPS_ORGANIC", state: "OK", now: sg.count, prev: prev && prev.signups.state === "OK" ? prev.signups.count : null, deltaPct: null, href: links.conversions, vars: { model: sg.model } },
  );

  const m = cur.mrr;
  if (m.state !== "OK") lines.push({ key: "MRR_ORGANIC", state: m.state, now: null, prev: null, deltaPct: null, href: links.connect, vars: { model: m.model } });
  else {
    const before = prev && prev.mrr.state === "OK" ? prev.mrr.byCurrency : null;
    lines.push({
      key: "MRR_ORGANIC",
      state: "OK",
      now: null,
      prev: null,
      deltaPct: null,
      href: links.revenue,
      vars: { model: m.model },
      money: m.byCurrency.map((c) => ({ currency: c.currency, cents: c.cents, prev: before ? (before.find((b) => b.currency === c.currency)?.cents ?? 0) : null })),
    });
  }
  return lines;
}

// ─── Top 5 actions ───────────────────────────────────────────────────────

export type ActionKind = "BLOCKING_SEO" | "INTEGRATION" | "FACT_CHECK" | "OPPORTUNITY" | "DRAFT";
export type ActionCandidate = {
  kind: ActionKind;
  /** Stable id of the underlying entity (audit, integration, asset, opportunity). */
  id: string;
  href: string;
  /** Entity name shown in the action text (product, provider, title). */
  subject: string;
  product?: string | null;
  count?: number;
  priority?: number;
  potential?: string;
  status?: string;
  ageDays?: number;
};
export type TopAction = ActionCandidate & { rank: number; tier: number };

/**
 * Tiers, highest first: blocking issues (critical SEO problems, expired then
 * failing integrations, HIGH fact-check blockers), high-potential
 * opportunities, drafts awaiting approval, other opportunities. Within a
 * tier: priority score, then count, then age, then id (deterministic).
 */
export function actionTier(a: ActionCandidate): number {
  switch (a.kind) {
    case "BLOCKING_SEO":
      return 0;
    case "INTEGRATION":
      return a.status === "EXPIRED" ? 1 : 2;
    case "FACT_CHECK":
      return 3;
    case "OPPORTUNITY":
      return a.potential === "HIGH" ? 4 : 6;
    case "DRAFT":
      return 5;
  }
}

export function rankTopActions(candidates: ActionCandidate[], limit = 5): TopAction[] {
  const seen = new Set<string>();
  return candidates
    .filter((c) => {
      const k = `${c.kind}:${c.id}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .map((c) => ({ ...c, tier: actionTier(c) }))
    .sort((a, b) => a.tier - b.tier || (b.priority ?? 0) - (a.priority ?? 0) || (b.count ?? 0) - (a.count ?? 0) || (b.ageDays ?? 0) - (a.ageDays ?? 0) || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((c, i) => ({ ...c, rank: i + 1 }));
}

/** Localised time-of-day greeting key ("Good morning" until 12:00, "Good afternoon" until 18:00, else "Good evening"). */
export function greetingKey(hour: number): "Good morning" | "Good afternoon" | "Good evening" {
  if (hour >= 5 && hour < 12) return "Good morning";
  if (hour >= 12 && hour < 18) return "Good afternoon";
  return "Good evening";
}
