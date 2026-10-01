import { sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { analyticsDaily } from "@/db/schema";
import type { AnalyticsRow } from "@/integrations/types";
import { eventTypesFor } from "@/core/conversions/events";

const KEY_COLS = ["report", "day", "landingPage", "source", "medium", "campaign", "country", "device"] as const;

/**
 * Upsert GA4 daily rows (re-imports replace earlier values, so overlapping
 * syncs never double count). Rows that collapse onto the same key after
 * clipping are merged first.
 */
export async function upsertAnalyticsDaily(tx: Tx, target: { organizationId: string; productId: string; integrationId: string }, rows: AnalyticsRow[]) {
  const merged = new Map<string, AnalyticsRow>();
  for (const r of rows) {
    const key = KEY_COLS.map((k) => r[k]).join("\u0001");
    const prev = merged.get(key);
    merged.set(key, prev ? { ...prev, sessions: prev.sessions + r.sessions, users: prev.users + r.users, engagedSessions: prev.engagedSessions + r.engagedSessions, keyEvents: prev.keyEvents + r.keyEvents } : r);
  }
  const all = [...merged.values()];
  for (let i = 0; i < all.length; i += 500) {
    await tx
      .insert(analyticsDaily)
      .values(all.slice(i, i + 500).map((r) => ({ ...target, ...r })))
      .onConflictDoUpdate({
        target: [analyticsDaily.integrationId, analyticsDaily.report, analyticsDaily.day, analyticsDaily.landingPage, analyticsDaily.source, analyticsDaily.medium, analyticsDaily.campaign, analyticsDaily.country, analyticsDaily.device],
        set: { sessions: sql`excluded.sessions`, users: sql`excluded.users`, engagedSessions: sql`excluded.engaged_sessions`, keyEvents: sql`excluded.key_events`, updatedAt: new Date() },
      });
  }
  return all.length;
}

/**
 * Link confidence between two systems:
 * - MEASURED: same system and same identifier (Beacon landing page → Beacon conversion of the same visitor)
 * - MODELLED: joined on the page path only (Search Console page ↔ GA4 landing page ↔ Beacon landing page);
 *   the people behind the numbers are not known to be the same
 * - UNKNOWN: one side has no data (or is not connected), so no link can be drawn
 */
export type LinkLabel = "MEASURED" | "MODELLED" | "UNKNOWN";

export type JourneyRow = {
  path: string;
  search: { clicks: number; impressions: number } | null;
  analytics: { sessions: number; organicSessions: number; keyEvents: number } | null;
  beacon: { visitors: number; signups: number; subscriptions: number } | null;
  links: { searchToAnalytics: LinkLabel; analyticsToBeacon: LinkLabel; searchToBeacon: LinkLabel; beaconToConversion: LinkLabel };
};

/** Normalised path of a page URL or GA4 landing page ("/pricing", never a trailing slash except "/"). */
export function pagePath(raw: string): string | null {
  if (!raw || raw === "(not set)") return null;
  let p = raw;
  try {
    p = /^https?:\/\//i.test(raw) ? new URL(raw).pathname : raw.split("?")[0].split("#")[0];
  } catch {
    return null;
  }
  if (!p.startsWith("/")) p = `/${p}`;
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

export function linkLabels(r: Pick<JourneyRow, "search" | "analytics" | "beacon">): JourneyRow["links"] {
  const both = (a: unknown, b: unknown): LinkLabel => (a && b ? "MODELLED" : "UNKNOWN");
  return {
    searchToAnalytics: both(r.search, r.analytics),
    analyticsToBeacon: both(r.analytics, r.beacon),
    searchToBeacon: both(r.search, r.beacon),
    beaconToConversion: r.beacon && r.beacon.visitors > 0 ? "MEASURED" : "UNKNOWN",
  };
}

/**
 * Page-level journey for the last `days`: Search Console page clicks
 * (search_daily page rows), GA4 sessions by landing page (analytics_daily
 * "landing" report) and Beacon visitors and conversions by landing page
 * (the event's landing URL, else its first touch's landing URL), joined on
 * the page path. Each link is
 * labelled MEASURED, MODELLED or UNKNOWN; nothing is extrapolated.
 */
export async function journey(tx: Tx, organizationId: string, opts: { days: number; productId?: string | null; limit?: number }): Promise<JourneyRow[]> {
  const pf = (col: string) => (opts.productId ? sql`and ${sql.raw(col)} = ${opts.productId}` : sql``);
  const search = await tx.execute<{ page: string; clicks: number; impressions: number }>(sql`
    select page, sum(clicks)::int as clicks, sum(impressions)::int as impressions from search_daily
    where organization_id = ${organizationId} and page is not null and query is null and country is null and device is null
      and day >= current_date - ${opts.days}::int ${pf("product_id")}
    group by page`);
  const ga = await tx.execute<{ page: string; sessions: number; organic: number; key_events: number }>(sql`
    select landing_page as page, sum(sessions)::int as sessions, sum(sessions) filter (where medium = 'organic')::int as organic, sum(key_events)::float as key_events
    from analytics_daily where organization_id = ${organizationId} and report = 'landing' and day >= current_date - ${opts.days}::int ${pf("product_id")}
    group by landing_page`);
  const signups = sql.join(eventTypesFor("SIGNUP_COMPLETED").map((t) => sql`${t}`), sql`, `);
  const subs = sql.join(eventTypesFor("SUBSCRIPTION_STARTED").map((t) => sql`${t}`), sql`, `);
  const beacon = await tx.execute<{ page: string; visitors: number; signups: number; subs: number }>(sql`
    select coalesce(e.landing_url, ft.landing_url) as page, count(distinct e.visitor_id) filter (where e.type = 'PAGE_VIEW')::int as visitors,
      count(*) filter (where e.type::text in (${signups}))::int as signups, count(*) filter (where e.type::text in (${subs}))::int as subs
    from conversion_events e left join attribution_events ft on ft.id = e.first_touch_id
    where e.organization_id = ${organizationId} and coalesce(e.landing_url, ft.landing_url) is not null and e.occurred_at >= now() - make_interval(days => ${opts.days}) ${pf("e.product_id")}
    group by 1`);

  const rows = new Map<string, Omit<JourneyRow, "links">>();
  const at = (path: string) => rows.get(path) ?? rows.set(path, { path, search: null, analytics: null, beacon: null }).get(path)!;
  for (const r of search.rows) {
    const p = pagePath(r.page);
    if (!p) continue;
    const e = at(p);
    e.search = { clicks: (e.search?.clicks ?? 0) + Number(r.clicks), impressions: (e.search?.impressions ?? 0) + Number(r.impressions) };
  }
  for (const r of ga.rows) {
    const p = pagePath(r.page);
    if (!p) continue;
    const e = at(p);
    e.analytics = { sessions: (e.analytics?.sessions ?? 0) + Number(r.sessions), organicSessions: (e.analytics?.organicSessions ?? 0) + Number(r.organic ?? 0), keyEvents: (e.analytics?.keyEvents ?? 0) + Number(r.key_events ?? 0) };
  }
  for (const r of beacon.rows) {
    const p = pagePath(r.page);
    if (!p) continue;
    const e = at(p);
    e.beacon = { visitors: (e.beacon?.visitors ?? 0) + Number(r.visitors), signups: (e.beacon?.signups ?? 0) + Number(r.signups), subscriptions: (e.beacon?.subscriptions ?? 0) + Number(r.subs) };
  }
  const weight = (r: Omit<JourneyRow, "links">) => (r.search?.clicks ?? 0) + (r.analytics?.sessions ?? 0) + (r.beacon?.visitors ?? 0);
  return [...rows.values()]
    .sort((a, b) => weight(b) - weight(a) || a.path.localeCompare(b.path))
    .slice(0, opts.limit ?? 50)
    .map((r) => ({ ...r, links: linkLabels(r) }));
}
