import { randomUUID } from "node:crypto";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { memberships, notificationPreferences, notifications, notificationWebhooks, users } from "@/db/schema";
import {
  conversionAnomaly,
  DEFAULT_THRESHOLDS,
  digestKey,
  digestLink,
  enteredBand,
  freshSignals,
  KIND_TITLES,
  maxSeverity,
  mergeDigest,
  NOTIFICATION_KINDS,
  parseThresholds,
  trafficDrop,
  type DigestParams,
  type NotificationChannel,
  type NotificationKind,
  type Severity,
  type Signal,
  type Thresholds,
} from "@/core/notifications/notifications";
import { eventTypesFor } from "@/core/conversions/events";
import { addDays, isoDay } from "@/core/util/text";
import { audit, type Actor } from "@/lib/audit";
import { assertSafeUrl } from "@/lib/security/ssrf";
import { encryptSecret } from "@/lib/security/crypto";
import { availability } from "./metrics";
import { searchDataState, searchTotals } from "./search-insights";

type Run = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
/** Signals already notified within this many days are not notified again. */
export const DEDUPE_DAYS = 90;

// ─── Preferences ─────────────────────────────────────────────────────────

export type PrefRow = typeof notificationPreferences.$inferSelect;

export async function loadPreferences(tx: Tx, organizationId: string): Promise<PrefRow[]> {
  return tx.select().from(notificationPreferences).where(eq(notificationPreferences.organizationId, organizationId));
}

/** Organisation thresholds (stored on the organisation-level IN_APP row of each kind). */
export function thresholdsFrom(prefs: PrefRow[]): Thresholds {
  const stored: Partial<Record<NotificationKind, Record<string, unknown>>> = {};
  for (const p of prefs) if (p.userId === null && p.channel === "IN_APP") stored[p.kind] = p.threshold;
  return parseThresholds(stored);
}

/**
 * Whether a channel is on: the member's own row, else the organisation
 * default row, else the built-in default (in-app on, email off, webhook on).
 */
export function channelEnabled(prefs: PrefRow[], userId: string | null, kind: NotificationKind, channel: NotificationChannel): boolean {
  const own = userId ? prefs.find((p) => p.userId === userId && p.kind === kind && p.channel === channel) : undefined;
  if (own) return own.enabled;
  const org = prefs.find((p) => p.userId === null && p.kind === kind && p.channel === channel);
  if (org) return org.enabled;
  return channel !== "EMAIL";
}

async function upsertPref(tx: Tx, organizationId: string, userId: string | null, kind: NotificationKind, channel: NotificationChannel, set: { enabled?: boolean; threshold?: Record<string, unknown> }) {
  const existing = await tx.query.notificationPreferences.findFirst({
    where: and(eq(notificationPreferences.organizationId, organizationId), userId ? eq(notificationPreferences.userId, userId) : isNull(notificationPreferences.userId), eq(notificationPreferences.kind, kind), eq(notificationPreferences.channel, channel)),
  });
  if (existing) await tx.update(notificationPreferences).set(set).where(eq(notificationPreferences.id, existing.id));
  else await tx.insert(notificationPreferences).values({ organizationId, userId, kind, channel, enabled: set.enabled ?? channel !== "EMAIL", threshold: set.threshold ?? {} });
}

/** A member's own IN_APP and EMAIL switches (every kind; missing entries are off). */
export async function saveMemberPreferences(tx: Tx, actor: Actor, on: Set<string>) {
  if (!actor.userId) throw new Error("Preferences belong to a member");
  for (const kind of NOTIFICATION_KINDS) for (const channel of ["IN_APP", "EMAIL"] as const) await upsertPref(tx, actor.organizationId, actor.userId, kind, channel, { enabled: on.has(`${kind}:${channel}`) });
  await audit(tx, actor, "notifications.preferences", "user", actor.userId, { enabled: [...on].sort() });
}

/** Organisation thresholds and per-kind webhook switches (admins). */
export async function saveOrgNotificationSettings(tx: Tx, actor: Actor, input: { thresholds: Thresholds; webhookKinds: Set<NotificationKind> }) {
  const t = parseThresholds(input.thresholds as unknown as Partial<Record<NotificationKind, Record<string, unknown>>>);
  for (const kind of ["TRAFFIC_DROP", "QUERY_ENTERED_TOP", "CONVERSION_ANOMALY"] as const) await upsertPref(tx, actor.organizationId, null, kind, "IN_APP", { threshold: t[kind] as unknown as Record<string, unknown> });
  for (const kind of NOTIFICATION_KINDS) await upsertPref(tx, actor.organizationId, null, kind, "WEBHOOK", { enabled: input.webhookKinds.has(kind) });
  await audit(tx, actor, "notifications.org_settings", "organization", actor.organizationId, { thresholds: t, webhookKinds: [...input.webhookKinds].sort() });
  return t;
}

// ─── Webhooks ────────────────────────────────────────────────────────────

export const webhookAad = (id: string) => `notification_webhook:${id}`;

/** Register an outgoing webhook (https only, public address, secret encrypted at rest). */
export async function addWebhook(tx: Tx, actor: Actor, input: { url: string; secret: string; kinds: NotificationKind[] }) {
  const url = assertSafeUrl(input.url);
  if (url.protocol !== "https:") throw new Error("Webhook URLs must use https://");
  if (input.secret.length < 16) throw new Error("The signing secret must be at least 16 characters.");
  const id = randomUUID();
  const [row] = await tx
    .insert(notificationWebhooks)
    .values({ id, organizationId: actor.organizationId, url: url.toString(), secretCiphertext: encryptSecret(input.secret, webhookAad(id)), kinds: input.kinds, createdBy: actor.userId ?? null })
    .returning({ id: notificationWebhooks.id });
  await audit(tx, actor, "notifications.webhook_add", "notification_webhook", row.id, { host: url.host, kinds: input.kinds });
  return row;
}

export async function setWebhookActive(tx: Tx, actor: Actor, id: string, active: boolean) {
  const [row] = await tx.update(notificationWebhooks).set({ active }).where(and(eq(notificationWebhooks.organizationId, actor.organizationId), eq(notificationWebhooks.id, id))).returning({ id: notificationWebhooks.id });
  if (!row) throw new Error("Webhook not found");
  await audit(tx, actor, active ? "notifications.webhook_enable" : "notifications.webhook_disable", "notification_webhook", id);
}

export async function removeWebhook(tx: Tx, actor: Actor, id: string) {
  const [row] = await tx.delete(notificationWebhooks).where(and(eq(notificationWebhooks.organizationId, actor.organizationId), eq(notificationWebhooks.id, id))).returning({ id: notificationWebhooks.id });
  if (!row) throw new Error("Webhook not found");
  await audit(tx, actor, "notifications.webhook_remove", "notification_webhook", id);
}

export async function listWebhooks(tx: Tx, organizationId: string) {
  return tx
    .select({ id: notificationWebhooks.id, url: notificationWebhooks.url, kinds: notificationWebhooks.kinds, active: notificationWebhooks.active, lastDeliveryAt: notificationWebhooks.lastDeliveryAt, lastStatus: notificationWebhooks.lastStatus, lastError: notificationWebhooks.lastError, createdAt: notificationWebhooks.createdAt })
    .from(notificationWebhooks)
    .where(eq(notificationWebhooks.organizationId, organizationId))
    .orderBy(notificationWebhooks.createdAt);
}

// ─── Evaluation ──────────────────────────────────────────────────────────

/** Monday of the ISO week of a day (YYYY-MM-DD), so weekly signals are notified once per week. */
const weekOf = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  return isoDay(addDays(d, -((d.getUTCDay() + 6) % 7)));
};

/** Every condition that currently holds, as signals (deduplication happens when they are applied). */
export async function evaluateSignals(tx: Tx, organizationId: string, thresholds: Thresholds = DEFAULT_THRESHOLDS, now = new Date()): Promise<Signal[]> {
  const out: Signal[] = [];

  const crit = await tx.execute<{ audit_id: string; product: string; n: number }>(sql`
    select a.id as audit_id, p.name as product, count(i.id)::int as n
    from (select distinct on (product_id) id, product_id from seo_audits where organization_id = ${organizationId} and status = 'SUCCEEDED' order by product_id, created_at desc) a
    join products p on p.id = a.product_id
    join seo_issues i on i.audit_id = a.id and i.severity = 'CRITICAL' and i.status = 'OPEN'
    group by a.id, p.name`);
  for (const r of crit.rows)
    out.push({ kind: "CRITICAL_SEO_ISSUE", severity: "CRITICAL", item: { fp: `seo:${r.audit_id}`, key: "Open critical issues in the latest audit of {product}: {n}", vars: { n: num(r.n), product: r.product }, href: `/discovery/audits/${r.audit_id}` } });

  const prods = await tx.execute<{ id: string; name: string; slug: string }>(sql`select id, name, slug from products where organization_id = ${organizationId} order by name`);
  const search = await searchDataState(tx, { organizationId });
  // Only when search data is connected: no search data never means "no drop".
  if (search.hasData) {
    for (const p of prods.rows) {
      const scope = { organizationId, productId: p.id, provider: search.integrations.some((i) => i.provider === "GOOGLE_SEARCH_CONSOLE") ? ("GOOGLE_SEARCH_CONSOLE" as const) : ("BING_WEBMASTER" as const) };
      const st = await searchDataState(tx, scope);
      if (!st.hasData || !st.lastDay) continue;
      const end = st.lastDay;
      const start = isoDay(addDays(new Date(`${end}T00:00:00Z`), -6));
      const totals = await searchTotals(tx, scope, { start, end });
      const drop = trafficDrop(totals.now.clicks, totals.prev.clicks, thresholds.TRAFFIC_DROP);
      if (drop !== null)
        out.push({
          kind: "TRAFFIC_DROP",
          severity: "HIGH",
          item: { fp: `drop:${p.id}:${weekOf(end)}`, key: "{product}: organic clicks down {pct}% week over week ({now} vs {prev})", vars: { product: p.name, pct: Math.round(drop * 100), now: totals.now.clicks, prev: totals.prev.clicks }, href: `/queries/search?product=${encodeURIComponent(p.slug)}` },
        });
      const prevStart = isoDay(addDays(new Date(`${start}T00:00:00Z`), -7));
      const q = await tx.execute<{ query: string; i_now: number; p_now: number | null; p_prev: number | null }>(sql`
        select query,
          coalesce(sum(impressions) filter (where day >= ${start}::date), 0)::float as i_now,
          (sum(position * impressions) filter (where day >= ${start}::date and position is not null) / nullif(sum(impressions) filter (where day >= ${start}::date and position is not null), 0))::float as p_now,
          (sum(position * impressions) filter (where day < ${start}::date and position is not null) / nullif(sum(impressions) filter (where day < ${start}::date and position is not null), 0))::float as p_prev
        from search_daily
        where organization_id = ${organizationId} and product_id = ${p.id} and provider = ${scope.provider}
          and query is not null and page is null and country is null and device is null
          and day between ${prevStart}::date and ${end}::date
        group by query having coalesce(sum(impressions) filter (where day >= ${start}::date), 0) >= ${thresholds.QUERY_ENTERED_TOP.minImpressions}
        order by 2 desc limit 2000`);
      for (const r of q.rows) {
        const band = enteredBand(r.p_now === null ? null : Number(r.p_now), r.p_prev === null ? null : Number(r.p_prev), thresholds.QUERY_ENTERED_TOP.range);
        if (!band) continue;
        out.push({
          kind: "QUERY_ENTERED_TOP",
          severity: "INFO",
          item: {
            fp: `top:${p.id}:${r.query}:${band}`,
            key: band === "TOP_3" ? "{query} ({product}) entered positions 1 to 3 (average {position})" : "{query} ({product}) entered positions 4 to 10 (average {position})",
            vars: { query: r.query, product: p.name, position: Math.round(Number(r.p_now) * 10) / 10 },
            href: `/queries/search?product=${encodeURIComponent(p.slug)}`,
          },
        });
      }
    }
  }

  const integ = await tx.execute<{ id: string; provider: string; status: string; last_success_at: string | null }>(sql`
    select id, provider::text as provider, status::text as status, last_success_at::text from integrations where organization_id = ${organizationId} and status in ('ERROR', 'EXPIRED')`);
  for (const r of integ.rows)
    out.push({ kind: "INTEGRATION_DISCONNECTED", severity: "HIGH", item: { fp: `integ:${r.id}:${r.status}:${r.last_success_at ?? "never"}`, key: "{provider} is {status}: reconnect it", vars: { provider: r.provider, status: r.status }, href: "/settings/integrations" } });

  const crawls = await tx.execute<{ id: string; product: string }>(sql`
    select a.id, p.name as product from seo_audits a join products p on p.id = a.product_id
    where a.organization_id = ${organizationId} and a.status = 'FAILED' and a.created_at >= ${addDays(now, -7).toISOString()}`);
  for (const r of crawls.rows) out.push({ kind: "CRAWL_FAILED", severity: "MEDIUM", item: { fp: `crawl:${r.id}`, key: "The crawl of {product} failed", vars: { product: r.product }, href: `/discovery/audits/${r.id}` } });

  const drafts = await tx.execute<{ id: string; title: string; v: number }>(sql`select id, title, current_version as v from content_assets where organization_id = ${organizationId} and status = 'HUMAN_APPROVAL'`);
  for (const r of drafts.rows) out.push({ kind: "CONTENT_AWAITING_APPROVAL", severity: "LOW", item: { fp: `approval:${r.id}:${r.v}`, key: "{title} is awaiting approval", vars: { title: r.title }, href: `/content/${r.id}` } });

  const a = await availability(tx, organizationId, null);
  if (a.events) {
    const types = sql.join(["SIGNUP_COMPLETED", "TRIAL_STARTED", "SUBSCRIPTION_STARTED"].flatMap((s) => eventTypesFor(s as never)).map((t) => sql`${t}`), sql`, `);
    const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const series = await tx.execute<{ day: string; n: number }>(sql`
      select to_char(d, 'YYYY-MM-DD') as day, (select count(*) from conversion_events e where e.organization_id = ${organizationId} and e.type::text in (${types}) and e.occurred_at >= d and e.occurred_at < d + interval '1 day')::int as n
      from generate_series(${addDays(today, -29).toISOString()}::timestamptz, ${addDays(today, -1).toISOString()}::timestamptz, interval '1 day') d order by d`);
    const values = series.rows.map((r) => num(r.n));
    const day = series.rows[series.rows.length - 1]?.day;
    const anomaly = day ? conversionAnomaly(values.slice(0, -1), values[values.length - 1], thresholds.CONVERSION_ANOMALY) : null;
    if (anomaly && day)
      out.push({ kind: "CONVERSION_ANOMALY", severity: anomaly.direction === "DOWN" ? "HIGH" : "MEDIUM", item: { fp: `conv:${day}`, key: "Conversions on {day}: {value} vs a 28-day average of {mean} (z = {z})", vars: { day, value: anomaly.value, mean: anomaly.mean, z: anomaly.z }, href: "/conversions" } });
  }

  const opps = await tx.execute<{ id: string; title: string; priority: number }>(sql`
    select id, title, priority_score as priority from opportunities where organization_id = ${organizationId} and status = 'OPEN' and potential = 'HIGH' order by priority_score desc limit 50`);
  for (const r of opps.rows) out.push({ kind: "HIGH_PRIORITY_OPPORTUNITY", severity: "MEDIUM", item: { fp: `opp:${r.id}`, key: "{title} (priority {priority})", vars: { title: r.title, priority: Math.round(num(r.priority) * 10) / 10 }, href: `/opportunities/${r.id}` } });
  return out;
}

/** Fingerprints already notified (organisation digests of the last DEDUPE_DAYS days). */
export async function notifiedFingerprints(tx: Tx, organizationId: string, now = new Date()): Promise<Set<string>> {
  const r = await tx.execute<{ fp: string }>(sql`
    select distinct jsonb_array_elements_text(params->'signals') as fp from notifications
    where organization_id = ${organizationId} and user_id is null and created_at >= ${addDays(now, -DEDUPE_DAYS).toISOString()}`);
  return new Set(r.rows.map((x) => x.fp));
}

export type Delivery = { channel: "EMAIL"; notificationId: string; userId: string } | { channel: "WEBHOOK"; notificationId: string; webhookId: string };

async function upsertDigest(tx: Tx, organizationId: string, userId: string | null, kind: NotificationKind, severity: Severity, items: Signal["item"][], day: string, now: Date) {
  const key = digestKey(kind, day);
  const existing = await tx.query.notifications.findFirst({ where: and(eq(notifications.organizationId, organizationId), userId ? eq(notifications.userId, userId) : isNull(notifications.userId), eq(notifications.dedupeKey, key)) });
  const params = mergeDigest(existing ? (existing.params as DigestParams) : null, items);
  if (existing) {
    if (params.n === (existing.params as DigestParams).n) return { id: existing.id, created: false };
    await tx
      .update(notifications)
      .set({ params, severity: maxSeverity(existing.severity, severity), link: digestLink(kind, params), readAt: null, updatedAt: now })
      .where(eq(notifications.id, existing.id));
    return { id: existing.id, created: false };
  }
  const [row] = await tx.insert(notifications).values({ organizationId, userId, kind, severity, titleKey: KIND_TITLES[kind], params, link: digestLink(kind, params), dedupeKey: key, createdAt: now, updatedAt: now }).returning({ id: notifications.id });
  return { id: row.id, created: true };
}

/**
 * Apply signals: drop those notified before, then merge the rest into one
 * digest per kind per day for the organisation (ledger and webhook record)
 * and for each member whose in-app channel is on. Email and webhook
 * deliveries are returned for the first digest of a kind each day only
 * (rate limit: at most one email and one webhook call per kind per day).
 */
export async function applySignals(tx: Tx, organizationId: string, signals: Signal[], now = new Date(), opts: { emailConfigured?: boolean } = {}) {
  // One evaluation at a time per organisation (concurrent workers would race on the digests).
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`notifications:${organizationId}`}))`);
  const fresh = freshSignals(signals, await notifiedFingerprints(tx, organizationId, now));
  const deliveries: Delivery[] = [];
  if (!fresh.length) return { fresh: 0, digests: 0, deliveries };
  const prefs = await loadPreferences(tx, organizationId);
  const members = await tx.select({ userId: memberships.userId }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.organizationId, organizationId));
  const hooks = await tx.select({ id: notificationWebhooks.id, kinds: notificationWebhooks.kinds }).from(notificationWebhooks).where(and(eq(notificationWebhooks.organizationId, organizationId), eq(notificationWebhooks.active, true)));
  const day = isoDay(now);
  let digests = 0;
  for (const kind of NOTIFICATION_KINDS) {
    const group = fresh.filter((s) => s.kind === kind);
    if (!group.length) continue;
    const severity = group.map((s) => s.severity).reduce(maxSeverity);
    const items = group.map((s) => s.item);
    const org = await upsertDigest(tx, organizationId, null, kind, severity, items, day, now);
    digests++;
    if (org.created && channelEnabled(prefs, null, kind, "WEBHOOK"))
      for (const h of hooks) if (!h.kinds.length || h.kinds.includes(kind)) deliveries.push({ channel: "WEBHOOK", notificationId: org.id, webhookId: h.id });
    for (const m of members) {
      if (!channelEnabled(prefs, m.userId, kind, "IN_APP")) continue;
      const mine = await upsertDigest(tx, organizationId, m.userId, kind, severity, items, day, now);
      if (mine.created && opts.emailConfigured && channelEnabled(prefs, m.userId, kind, "EMAIL")) deliveries.push({ channel: "EMAIL", notificationId: mine.id, userId: m.userId });
    }
  }
  return { fresh: fresh.length, digests, deliveries };
}

/** Evaluate and apply for one organisation (the caller enqueues the returned deliveries after commit). */
export async function evaluateNotifications(run: Run, organizationId: string, opts: { now?: Date; emailConfigured?: boolean } = {}) {
  const now = opts.now ?? new Date();
  return run(async (tx) => {
    const thresholds = thresholdsFrom(await loadPreferences(tx, organizationId));
    const signals = await evaluateSignals(tx, organizationId, thresholds, now);
    const res = await applySignals(tx, organizationId, signals, now, { emailConfigured: opts.emailConfigured });
    return { signals: signals.length, ...res };
  });
}

// ─── Inbox ───────────────────────────────────────────────────────────────

export async function inbox(tx: Tx, organizationId: string, userId: string, opts: { unreadOnly?: boolean; limit?: number } = {}) {
  return tx
    .select()
    .from(notifications)
    .where(and(eq(notifications.organizationId, organizationId), eq(notifications.userId, userId), opts.unreadOnly ? isNull(notifications.readAt) : undefined))
    .orderBy(desc(notifications.updatedAt))
    .limit(opts.limit ?? 100);
}

export async function unreadCount(tx: Tx, organizationId: string, userId: string): Promise<number> {
  const r = await tx.execute<{ n: number }>(sql`select count(*)::int as n from notifications where organization_id = ${organizationId} and user_id = ${userId} and read_at is null`);
  return num(r.rows[0]?.n);
}

/** Mark one of the member's own notifications read; returns its link. */
export async function markRead(tx: Tx, actor: Actor, id: string): Promise<string | null> {
  if (!actor.userId) throw new Error("Notifications belong to a member");
  const [row] = await tx
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.organizationId, actor.organizationId), eq(notifications.userId, actor.userId), eq(notifications.id, id)))
    .returning({ link: notifications.link });
  if (!row) throw new Error("Notification not found");
  return row.link;
}

export async function markAllRead(tx: Tx, actor: Actor): Promise<number> {
  if (!actor.userId) throw new Error("Notifications belong to a member");
  const rows = await tx
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.organizationId, actor.organizationId), eq(notifications.userId, actor.userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return rows.length;
}
