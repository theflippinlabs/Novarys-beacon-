import { and, asc, desc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { competitors, competitorWatches, competitorWatchSnapshots } from "@/db/schema";
import {
  diffSummary,
  excerptOf,
  extractMainLines,
  HOST_DELAY_MS,
  interleaveByHost,
  MANUAL_MIN_INTERVAL_MS,
  MAX_CHECKS_PER_RUN,
  MAX_PAGE_BYTES,
  MAX_WATCHES_PER_ORG,
  REQUEST_DEADLINE_MS,
  robotsDecision,
  selectDue,
  storedText,
  textHash,
  validateWatchUrl,
  type WatchDiff,
  type WatchKind,
  type WatchStatus,
} from "@/core/competitors/watch";
import type { Signal } from "@/core/notifications/notifications";
import { withDeadline } from "@/core/seo/crawl";
import { audit, type Actor } from "@/lib/audit";
import { assertOwned } from "@/lib/owned";
import { redactErrorText } from "@/lib/security/redact";
import { safeFetch } from "@/lib/security/ssrf";
import { applySignals, type Delivery } from "./notifications";
import { domainVerificationBypassed } from "./seo";

/**
 * Competitor page watch (audit item 19): a low-budget, robots-compliant
 * weekly check of the competitor pages a member chose to watch (pricing
 * first). One GET per watched page, no crawling beyond it, robots.txt for
 * Beacon's token respected, per-host politeness, a hard deadline per request
 * and per run. Network I/O never runs inside a transaction: watches are read
 * in one transaction, fetched, then each result is written in its own.
 *
 * A content change only stores a snapshot with a factual diff summary and
 * notifies members that the page needs human review. Nothing here writes to
 * the knowledge graph or to comparison facts.
 */
type Run = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
export type WatchFetcher = (url: string, opts: { maxBytes: number }) => Promise<{ status: number; body: string; headers: Record<string, string>; url: string }>;

const USER_AGENT = "NovarysBeacon/1.0 (+competitor-watch)";
const defaultFetcher: WatchFetcher = (url, opts) => safeFetch(url, { method: "GET", maxBytes: opts.maxBytes, timeoutMs: REQUEST_DEADLINE_MS, maxRedirects: 3, userAgent: USER_AGENT });

/** Plain http is only accepted for local development hosts (BEACON_SSRF_ALLOW_PRIVATE outside production). */
const allowLocalHttp = (host: string) => domainVerificationBypassed(host);
const safeUrlFor = (raw: string) => validateWatchUrl(raw, { allowLocalHttp });

// ─── Management (tenant transaction) ─────────────────────────────────────

export async function addWatch(tx: Tx, actor: Actor, input: { competitorId: string; url: string; kind: WatchKind }) {
  await assertOwned(tx, competitors, input.competitorId, actor.organizationId, "Competitor not found");
  const url = safeUrlFor(input.url).toString();
  const n = await tx.execute<{ n: number }>(sql`select count(*)::int as n from competitor_watches where organization_id = ${actor.organizationId}`);
  if (Number(n.rows[0]?.n ?? 0) >= MAX_WATCHES_PER_ORG) throw new Error(`At most ${MAX_WATCHES_PER_ORG} pages can be watched per workspace. Remove one first.`);
  const [row] = await tx
    .insert(competitorWatches)
    .values({ organizationId: actor.organizationId, competitorId: input.competitorId, url, kind: input.kind, createdBy: actor.userId ?? null })
    .onConflictDoNothing()
    .returning({ id: competitorWatches.id });
  if (!row) throw new Error("This page is already watched.");
  await audit(tx, actor, "competitor_watch.add", "competitor_watch", row.id, { competitorId: input.competitorId, host: new URL(url).host, kind: input.kind });
  return row;
}

export async function setWatchActive(tx: Tx, actor: Actor, id: string, active: boolean) {
  const [row] = await tx.update(competitorWatches).set({ active }).where(and(eq(competitorWatches.organizationId, actor.organizationId), eq(competitorWatches.id, id))).returning({ id: competitorWatches.id });
  if (!row) throw new Error("Watched page not found");
  await audit(tx, actor, active ? "competitor_watch.resume" : "competitor_watch.pause", "competitor_watch", id);
}

export async function removeWatch(tx: Tx, actor: Actor, id: string) {
  const [row] = await tx.delete(competitorWatches).where(and(eq(competitorWatches.organizationId, actor.organizationId), eq(competitorWatches.id, id))).returning({ id: competitorWatches.id, url: competitorWatches.url });
  if (!row) throw new Error("Watched page not found");
  await audit(tx, actor, "competitor_watch.remove", "competitor_watch", id, { host: new URL(row.url).host });
}

/** "Check now": the watch must be active and not checked in the last MANUAL_MIN_INTERVAL_MS (politeness). */
export async function assertCheckAllowed(tx: Tx, organizationId: string, id: string, now = new Date()) {
  const w = await tx.query.competitorWatches.findFirst({ where: and(eq(competitorWatches.organizationId, organizationId), eq(competitorWatches.id, id)), columns: { id: true, active: true, lastFetchedAt: true } });
  if (!w) throw new Error("Watched page not found");
  if (!w.active) throw new Error("This page is paused. Resume it before checking it.");
  if (w.lastFetchedAt && now.getTime() - w.lastFetchedAt.getTime() < MANUAL_MIN_INTERVAL_MS) throw new Error("This page was checked less than 10 minutes ago. Try again later.");
  return w;
}

export type WatchRow = Omit<typeof competitorWatches.$inferSelect, "lastText"> & { competitorName: string; competitorDomain: string | null };
export type SnapshotRow = typeof competitorWatchSnapshots.$inferSelect;

const WATCH_COLUMNS = {
  id: competitorWatches.id,
  organizationId: competitorWatches.organizationId,
  competitorId: competitorWatches.competitorId,
  url: competitorWatches.url,
  kind: competitorWatches.kind,
  active: competitorWatches.active,
  status: competitorWatches.status,
  httpStatus: competitorWatches.httpStatus,
  lastFetchedAt: competitorWatches.lastFetchedAt,
  lastSuccessAt: competitorWatches.lastSuccessAt,
  lastChangedAt: competitorWatches.lastChangedAt,
  contentHash: competitorWatches.contentHash,
  excerpt: competitorWatches.excerpt,
  finalUrl: competitorWatches.finalUrl,
  error: competitorWatches.error,
  createdBy: competitorWatches.createdBy,
  createdAt: competitorWatches.createdAt,
  updatedAt: competitorWatches.updatedAt,
  competitorName: competitors.name,
  competitorDomain: competitors.domain,
};

/** Watched pages with their latest snapshots (newest first, `perWatch` each). */
export async function listWatches(tx: Tx, organizationId: string, opts: { perWatch?: number } = {}): Promise<(WatchRow & { snapshots: SnapshotRow[] })[]> {
  const rows = await tx
    .select(WATCH_COLUMNS)
    .from(competitorWatches)
    .innerJoin(competitors, eq(competitors.id, competitorWatches.competitorId))
    .where(eq(competitorWatches.organizationId, organizationId))
    .orderBy(asc(competitors.name), asc(competitorWatches.url));
  if (!rows.length) return [];
  const per = opts.perWatch ?? 5;
  const snaps = await tx.execute<{ id: string }>(sql`
    select id from (
      select id, row_number() over (partition by watch_id order by fetched_at desc, id) as rn
      from competitor_watch_snapshots where organization_id = ${organizationId}
    ) s where rn <= ${per}`);
  const ids = snaps.rows.map((r) => r.id);
  const full = ids.length ? await tx.select().from(competitorWatchSnapshots).where(and(eq(competitorWatchSnapshots.organizationId, organizationId), inArray(competitorWatchSnapshots.id, ids))).orderBy(desc(competitorWatchSnapshots.fetchedAt)) : [];
  return rows.map((r) => ({ ...r, snapshots: full.filter((s) => s.watchId === r.id) }));
}

/** Competitors a page can be attached to. */
export async function watchableCompetitors(tx: Tx, organizationId: string) {
  return tx.select({ id: competitors.id, name: competitors.name, domain: competitors.domain }).from(competitors).where(eq(competitors.organizationId, organizationId)).orderBy(asc(competitors.name));
}

/** Detected changes (CHANGED snapshots) in the last `days` days, newest first. */
export async function recentChanges(tx: Tx, organizationId: string, opts: { days?: number; limit?: number; competitorId?: string } = {}) {
  const since = new Date(Date.now() - (opts.days ?? 30) * 86_400_000);
  return tx
    .select({
      id: competitorWatchSnapshots.id,
      watchId: competitorWatchSnapshots.watchId,
      fetchedAt: competitorWatchSnapshots.fetchedAt,
      diff: competitorWatchSnapshots.diff,
      excerpt: competitorWatchSnapshots.excerpt,
      url: competitorWatches.url,
      kind: competitorWatches.kind,
      competitorId: competitors.id,
      competitorName: competitors.name,
    })
    .from(competitorWatchSnapshots)
    .innerJoin(competitorWatches, eq(competitorWatches.id, competitorWatchSnapshots.watchId))
    .innerJoin(competitors, eq(competitors.id, competitorWatches.competitorId))
    .where(
      and(
        eq(competitorWatchSnapshots.organizationId, organizationId),
        eq(competitorWatchSnapshots.kind, "CHANGED"),
        gte(competitorWatchSnapshots.fetchedAt, since),
        opts.competitorId ? eq(competitors.id, opts.competitorId) : undefined,
      ),
    )
    .orderBy(desc(competitorWatchSnapshots.fetchedAt))
    .limit(opts.limit ?? 25);
}

// ─── Fetch (no transaction open) ─────────────────────────────────────────

export type FetchOutcome = { status: WatchStatus; httpStatus: number | null; finalUrl: string | null; lines: string[] | null; error: string | null; fetchedAt: Date };

const errText = (e: unknown) => redactErrorText((e as Error)?.message ?? String(e)).slice(0, 300);
const sleep = (ms: number) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/**
 * Per-run fetch context: robots.txt answers cached per origin and the next
 * time each host may be requested (politeness, Crawl-delay honoured).
 */
export class PoliteFetcher {
  private robots = new Map<string, { status: number | null; body: string | null; error: string | null }>();
  private nextAt = new Map<string, number>();
  private delays = new Map<string, number>();
  constructor(
    private fetcher: WatchFetcher = defaultFetcher,
    private hostDelayMs = HOST_DELAY_MS,
    private deadlineMs = REQUEST_DEADLINE_MS,
  ) {}

  private async request(url: string, maxBytes: number) {
    const host = new URL(url).host.toLowerCase();
    await sleep((this.nextAt.get(host) ?? 0) - Date.now());
    try {
      return await withDeadline(this.fetcher(url, { maxBytes }), this.deadlineMs, url);
    } finally {
      this.nextAt.set(host, Date.now() + (this.delays.get(host) ?? this.hostDelayMs));
    }
  }

  private async robotsFor(origin: string) {
    const cached = this.robots.get(origin);
    if (cached) return cached;
    let entry: { status: number | null; body: string | null; error: string | null };
    try {
      const r = await this.request(`${origin}/robots.txt`, 512 * 1024);
      entry = { status: r.status, body: r.body, error: null };
    } catch (e) {
      entry = { status: null, body: null, error: errText(e) };
    }
    this.robots.set(origin, entry);
    return entry;
  }

  /** Robots decision for `url` (also records the host's politeness delay). */
  async decide(url: string) {
    const u = new URL(url);
    const r = await this.robotsFor(u.origin);
    const d = robotsDecision(r.status, r.body, url, this.hostDelayMs);
    this.delays.set(u.host.toLowerCase(), d.delayMs);
    return { ...d, robotsError: r.error };
  }

  /** Check one page: robots first (blocked means no fetch), then one GET. */
  async check(rawUrl: string, now = () => new Date()): Promise<FetchOutcome> {
    const out = (status: WatchStatus, o: Partial<FetchOutcome> = {}): FetchOutcome => ({ status, httpStatus: null, finalUrl: null, lines: null, error: null, fetchedAt: now(), ...o });
    let url: string;
    try {
      url = safeUrlFor(rawUrl).toString();
    } catch (e) {
      return out("FETCH_ERROR", { error: errText(e) });
    }
    const first = await this.decide(url);
    if (!first.allowed)
      return out("BLOCKED_BY_ROBOTS", { error: first.reason === "DISALLOWED" ? "Disallowed by robots.txt for NovarysBeacon: the page was not fetched." : `robots.txt is unavailable${first.robotsError ? ` (${first.robotsError})` : ""}, so the site is treated as disallowed: the page was not fetched.` });
    let res: Awaited<ReturnType<WatchFetcher>>;
    try {
      res = await this.request(url, MAX_PAGE_BYTES);
    } catch (e) {
      return out("FETCH_ERROR", { error: errText(e) });
    }
    const finalUrl = res.url || url;
    if (finalUrl !== url) {
      // Redirected: the target must still be an https public URL that robots.txt allows; otherwise the content is discarded.
      try {
        safeUrlFor(finalUrl);
      } catch (e) {
        return out("FETCH_ERROR", { httpStatus: res.status, finalUrl, error: `Redirected to a URL that cannot be watched: ${errText(e)}` });
      }
      if (new URL(finalUrl).origin !== new URL(url).origin) {
        const target = await this.decide(finalUrl);
        if (!target.allowed) return out("BLOCKED_BY_ROBOTS", { httpStatus: res.status, finalUrl, error: "The page redirects to a URL that robots.txt does not allow: its content was discarded." });
      }
    }
    if (res.status < 200 || res.status >= 300) return out("HTTP_ERROR", { httpStatus: res.status, finalUrl, error: `HTTP ${res.status}` });
    const type = res.headers["content-type"] ?? "";
    if (type && !/html/i.test(type)) return out("NOT_HTML", { httpStatus: res.status, finalUrl, error: `Not an HTML page (${type.slice(0, 80)})` });
    const lines = extractMainLines(res.body);
    if (!lines.length) return out("FETCH_ERROR", { httpStatus: res.status, finalUrl, error: "No readable text on the page (it may need JavaScript to render)." });
    return out("OK", { httpStatus: res.status, finalUrl, lines });
  }
}

// ─── Run ─────────────────────────────────────────────────────────────────

export type WatchRunResult = { checked: number; ok: number; baselines: number; changed: number; blocked: number; failed: number; skipped: number; deliveries: Delivery[] };

/** Write one check result in its own transaction (row locked; the diff is computed against the stored state). */
export async function recordOutcome(tx: Tx, organizationId: string, watchId: string, o: FetchOutcome, opts: { emailConfigured?: boolean } = {}) {
  const [w] = await tx.select().from(competitorWatches).where(and(eq(competitorWatches.organizationId, organizationId), eq(competitorWatches.id, watchId))).for("update");
  if (!w) return { result: "gone" as const, deliveries: [] as Delivery[] };
  const base = { lastFetchedAt: o.fetchedAt, status: o.status, httpStatus: o.httpStatus, finalUrl: o.finalUrl, error: o.error };
  if (o.status !== "OK" || !o.lines) {
    await tx.update(competitorWatches).set(base).where(eq(competitorWatches.id, w.id));
    return { result: o.status === "BLOCKED_BY_ROBOTS" ? ("blocked" as const) : ("failed" as const), deliveries: [] as Delivery[] };
  }
  const hash = textHash(o.lines)!;
  const excerpt = excerptOf(o.lines);
  const text = storedText(o.lines);
  if (!w.contentHash) {
    await tx.update(competitorWatches).set({ ...base, contentHash: hash, excerpt, lastText: text, lastSuccessAt: o.fetchedAt }).where(eq(competitorWatches.id, w.id));
    await tx.insert(competitorWatchSnapshots).values({ organizationId, watchId: w.id, kind: "BASELINE", fetchedAt: o.fetchedAt, contentHash: hash, excerpt, diff: null, httpStatus: o.httpStatus, finalUrl: o.finalUrl });
    return { result: "baseline" as const, deliveries: [] as Delivery[] };
  }
  if (w.contentHash === hash) {
    await tx.update(competitorWatches).set({ ...base, excerpt, lastSuccessAt: o.fetchedAt }).where(eq(competitorWatches.id, w.id));
    return { result: "unchanged" as const, deliveries: [] as Delivery[] };
  }
  const diff: WatchDiff = diffSummary(w.lastText ? w.lastText.split("\n") : [], text.split("\n"));
  await tx.update(competitorWatches).set({ ...base, contentHash: hash, excerpt, lastText: text, lastSuccessAt: o.fetchedAt, lastChangedAt: o.fetchedAt }).where(eq(competitorWatches.id, w.id));
  await tx.insert(competitorWatchSnapshots).values({ organizationId, watchId: w.id, kind: "CHANGED", fetchedAt: o.fetchedAt, contentHash: hash, previousHash: w.contentHash, excerpt, diff, httpStatus: o.httpStatus, finalUrl: o.finalUrl });
  const comp = await tx.query.competitors.findFirst({ where: eq(competitors.id, w.competitorId), columns: { name: true } });
  const signal: Signal = {
    kind: "COMPETITOR_PAGE_CHANGED",
    severity: w.kind === "PRICING" ? "MEDIUM" : "LOW",
    item: {
      fp: `cwatch:${w.id}:${hash.slice(0, 16)}`,
      key: "{competitor}: {url} changed ({added} line(s) added, {removed} removed). Review it before updating any fact.",
      vars: { competitor: comp?.name ?? "", url: w.url, added: diff.linesAdded, removed: diff.linesRemoved },
      href: `/ai-visibility#watch-${w.id}`,
    },
  };
  const applied = await applySignals(tx, organizationId, [signal], o.fetchedAt, { emailConfigured: opts.emailConfigured });
  await audit(tx, { organizationId, actorType: "SYSTEM" }, "competitor_watch.changed", "competitor_watch", w.id, { linesAdded: diff.linesAdded, linesRemoved: diff.linesRemoved, pricesAppeared: diff.pricesAppeared.length, pricesDisappeared: diff.pricesDisappeared.length });
  return { result: "changed" as const, deliveries: applied.deliveries };
}

/**
 * One run for an organisation: the due watches (or `watchIds` for "Check
 * now"), at most MAX_CHECKS_PER_RUN, interleaved by host; stops starting new
 * checks once `runDeadlineMs` has elapsed (the rest stay due).
 */
export async function runCompetitorWatch(
  run: Run,
  organizationId: string,
  opts: { watchIds?: string[]; fetcher?: WatchFetcher; hostDelayMs?: number; requestDeadlineMs?: number; runDeadlineMs?: number; max?: number; emailConfigured?: boolean; now?: () => Date; onProgress?: () => void } = {},
): Promise<WatchRunResult> {
  const now = opts.now ?? (() => new Date());
  const all = await run((tx) =>
    tx
      .select({ id: competitorWatches.id, url: competitorWatches.url, active: competitorWatches.active, lastFetchedAt: competitorWatches.lastFetchedAt })
      .from(competitorWatches)
      .where(and(eq(competitorWatches.organizationId, organizationId), opts.watchIds ? inArray(competitorWatches.id, opts.watchIds.length ? opts.watchIds : ["00000000-0000-0000-0000-000000000000"]) : undefined)),
  );
  const due = interleaveByHost(selectDue(all, now(), { ids: opts.watchIds, max: opts.max ?? MAX_CHECKS_PER_RUN }));
  const polite = new PoliteFetcher(opts.fetcher, opts.hostDelayMs ?? HOST_DELAY_MS, opts.requestDeadlineMs ?? REQUEST_DEADLINE_MS);
  const started = Date.now();
  const res: WatchRunResult = { checked: 0, ok: 0, baselines: 0, changed: 0, blocked: 0, failed: 0, skipped: 0, deliveries: [] };
  for (const w of due) {
    if (Date.now() - started > (opts.runDeadlineMs ?? 10 * 60_000)) {
      res.skipped++;
      continue;
    }
    const outcome = await polite.check(w.url, now);
    const r = await run((tx) => recordOutcome(tx, organizationId, w.id, outcome, { emailConfigured: opts.emailConfigured }));
    opts.onProgress?.();
    res.checked++;
    if (r.result === "baseline") res.baselines++;
    if (r.result === "changed") res.changed++;
    if (r.result === "baseline" || r.result === "changed" || r.result === "unchanged") res.ok++;
    if (r.result === "blocked") res.blocked++;
    if (r.result === "failed") res.failed++;
    res.deliveries.push(...r.deliveries);
  }
  return res;
}

/** Organisations with at least one active watch (scheduler, system role). */
export async function orgsWithActiveWatches(tx: Tx): Promise<string[]> {
  const r = await tx.execute<{ organization_id: string }>(sql`select distinct organization_id from competitor_watches where active`);
  return r.rows.map((x) => x.organization_id);
}
