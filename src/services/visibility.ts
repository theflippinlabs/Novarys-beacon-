import { and, eq, gte, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { integrations, providerCredentials, visibilityMetrics } from "@/db/schema";
import { isSearchProvider, isVisibilityProvider, VISIBILITY_ADAPTERS, type SearchProvider } from "@/integrations/registry";
import { isAuthFailure, isRetryableProviderError, ProviderHttpError, sanitizeProviderMessage, type MetricRow } from "@/integrations/types";
import { backfillRanges, dailySyncRange } from "@/core/integrations/health";
import { NonRetryableError } from "@/jobs/queue";
import { clearSearchRows, resolvePagePrefix, searchTotalsAsMetrics, upsertSearchRows } from "./search-data";
import { enqueueBackfillIfNeeded, recordConnectionResult } from "./integration-health";
import { upsertAnalyticsDaily } from "./journey";
import { decryptSecret, encryptSecret } from "@/lib/security/crypto";
import { addDays, isoDay } from "@/core/util/text";
import { audit, type Actor } from "@/lib/audit";

export async function upsertMetrics(tx: Tx, organizationId: string, productId: string, provider: string, rows: MetricRow[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    await tx
      .insert(visibilityMetrics)
      .values(chunk.map((r) => ({ organizationId, productId, provider, metric: r.metric, day: r.day, dimension: (r.dimension ?? "").slice(0, 500), value: r.value, weight: r.weight ?? null })))
      .onConflictDoUpdate({
        target: [visibilityMetrics.productId, visibilityMetrics.provider, visibilityMetrics.metric, visibilityMetrics.day, visibilityMetrics.dimension],
        set: { value: sql`excluded.value`, weight: sql`excluded.weight` },
      });
  }
}

/** Config keys starting with "_" are internal state (backfill progress, OAuth site list): kept across saves, hidden in the UI. */
const internalConfig = (c: Record<string, string>) => Object.fromEntries(Object.entries(c).filter(([k]) => k.startsWith("_")));

/**
 * Store configuration and credentials (secrets encrypted with AES-256-GCM,
 * AAD bound to the integration id; plaintext is never persisted or logged).
 * Saving never marks an integration CONNECTED: only a successful connection
 * test or sync does (see services/integration-health.ts).
 */
export async function saveIntegration(
  tx: Tx,
  actor: Actor,
  input: { provider: (typeof integrations.$inferInsert)["provider"]; productId: string | null; config: Record<string, string>; secret: Record<string, string> | null },
) {
  const existing = await tx.query.integrations.findFirst({
    where: and(eq(integrations.organizationId, actor.organizationId), eq(integrations.provider, input.provider), input.productId ? eq(integrations.productId, input.productId) : sql`${integrations.productId} is null`),
  });
  const integ =
    existing ??
    (await tx.insert(integrations).values({ organizationId: actor.organizationId, productId: input.productId, provider: input.provider, config: input.config }).returning())[0];
  const prev = existing?.config ?? {};
  const mappingChanged = Boolean(existing) && ((prev.siteUrl ?? "") !== (input.config.siteUrl ?? "") || (prev.urlPrefix ?? "") !== (input.config.urlPrefix ?? ""));
  let internal = internalConfig(prev);
  if (mappingChanged) {
    // Another property or page mapping: previously imported rows no longer describe this product.
    internal = Object.fromEntries(Object.entries(internal).filter(([k]) => !k.startsWith("_backfill")));
    await clearSearchRows(tx, actor.organizationId, integ.id);
  }
  const userConfig = Object.fromEntries(Object.entries(input.config).filter(([k]) => !k.startsWith("_")));
  if (input.secret?.serviceAccountJson) internal._authMode = "service_account";
  if (input.secret?.refreshToken) internal._authMode = "oauth";
  await tx
    .update(integrations)
    .set({ config: { ...internal, ...userConfig }, ...(mappingChanged ? { lastSuccessAt: null } : {}) })
    .where(eq(integrations.id, integ.id));
  if (input.secret && Object.values(input.secret).some(Boolean)) {
    const ciphertext = encryptSecret(JSON.stringify(input.secret), integ.id);
    await tx
      .insert(providerCredentials)
      .values({ organizationId: actor.organizationId, integrationId: integ.id, ciphertext })
      .onConflictDoUpdate({ target: providerCredentials.integrationId, set: { ciphertext, rotatedAt: new Date() } });
  }
  await audit(tx, actor, "integration.save", "integration", integ.id, { provider: input.provider, productId: input.productId, configKeys: Object.keys(userConfig), rotated: Boolean(input.secret) });
  return integ;
}

export async function loadSecret(tx: Tx, integrationId: string): Promise<Record<string, string>> {
  const cred = await tx.query.providerCredentials.findFirst({ where: eq(providerCredentials.integrationId, integrationId) });
  if (!cred) return {};
  return JSON.parse(decryptSecret(cred.ciphertext, integrationId));
}

type Run = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

/** Turn a provider failure into a job error: auth failures (EXPIRED) and config errors are not retried. */
function jobError(e: unknown): Error {
  const message = sanitizeProviderMessage((e as Error).message ?? String(e));
  return isRetryableProviderError(e) ? new Error(message) : new NonRetryableError(message);
}

async function recordFailure(run: Run, integ: typeof integrations.$inferSelect, e: unknown) {
  await run((tx) => recordConnectionResult(tx, integ, { ok: false, message: (e as Error).message ?? String(e), authFailure: isAuthFailure(e), httpStatus: e instanceof ProviderHttpError ? e.status : undefined }));
}

/**
 * Pull data for one integration. Network calls happen outside DB
 * transactions. Search providers re-pull the last 5 days by default (upsert,
 * so corrections replace earlier values). DISABLED integrations are skipped.
 */
export async function syncIntegration(run: Run, integrationId: string, days?: number, opts: { delayMs?: number; now?: Date } = {}) {
  const { integ, secret, prefix } = await run(async (tx) => {
    const integ = await tx.query.integrations.findFirst({ where: eq(integrations.id, integrationId) });
    if (!integ) throw new NonRetryableError("Integration not found");
    return { integ, secret: await loadSecret(tx, integ.id), prefix: await resolvePagePrefix(tx, integ) };
  });
  if (integ.status === "DISABLED") return { skipped: true, reason: "disabled" };
  if (!isVisibilityProvider(integ.provider) || !integ.productId) return { skipped: true };
  const adapter = VISIBILITY_ADAPTERS[integ.provider]();
  const range = dailySyncRange(opts.now ?? new Date(), days);
  try {
    const search = adapter.fetchSearchRows && isSearchProvider(integ.provider) ? await adapter.fetchSearchRows(integ.config, secret, range, { pagePrefix: prefix, delayMs: opts.delayMs }) : null;
    // GA4: landing page / source / campaign and country / device reports (analytics_daily).
    const analytics = adapter.fetchAnalyticsDaily ? await adapter.fetchAnalyticsDaily(integ.config, secret, range) : null;
    const rows = search ? searchTotalsAsMetrics(search) : await adapter.fetchMetrics(integ.config, secret, range);
    const rec = await run(async (tx) => {
      await upsertMetrics(tx, integ.organizationId, integ.productId!, integ.provider, rows);
      if (search) await upsertSearchRows(tx, { organizationId: integ.organizationId, productId: integ.productId, integrationId: integ.id, provider: integ.provider as SearchProvider }, search);
      if (analytics) await upsertAnalyticsDaily(tx, { organizationId: integ.organizationId, productId: integ.productId!, integrationId: integ.id }, analytics);
      return recordConnectionResult(tx, integ, { ok: true, message: "synced" }, { synced: true });
    });
    await enqueueBackfillIfNeeded(rec.integration, rec.previousSuccessAt);
    return { rows: rows.length, searchRows: search?.length ?? 0, range };
  } catch (e) {
    await recordFailure(run, integ, e);
    throw jobError(e);
  }
}

/**
 * Import history in chunks, newest first (Search Console: 16 months in
 * calendar-month chunks; Bing: its whole history in one call). Each chunk is
 * fetched outside any transaction, then upserted in its own transaction, and
 * progress is kept so a retried job resumes where it stopped.
 */
export async function backfillSearch(run: Run, integrationId: string, opts: { since?: string | null; runId?: string; delayMs?: number; now?: Date } = {}) {
  const { integ, secret, prefix } = await run(async (tx) => {
    const integ = await tx.query.integrations.findFirst({ where: eq(integrations.id, integrationId) });
    if (!integ) throw new NonRetryableError("Integration not found");
    return { integ, secret: await loadSecret(tx, integ.id), prefix: await resolvePagePrefix(tx, integ) };
  });
  if (integ.status === "DISABLED" || integ.status === "EXPIRED") return { skipped: true, reason: integ.status.toLowerCase() };
  if (!isSearchProvider(integ.provider) || !integ.productId) return { skipped: true };
  const adapter = VISIBILITY_ADAPTERS[integ.provider]();
  if (!adapter.fetchSearchRows || !adapter.backfill) return { skipped: true };
  const runId = opts.runId ?? `${integ.id}:${(opts.now ?? new Date()).toISOString().slice(0, 10)}`;
  const resumeFrom = integ.config._backfillRun === runId ? integ.config._backfillOldest : undefined;
  const ranges = backfillRanges(dailySyncRange(opts.now ?? new Date()).end, adapter.backfill.months, { chunked: adapter.backfill.chunked, since: opts.since ?? null }).filter((r) => !resumeFrom || r.start < resumeFrom);
  const target = { organizationId: integ.organizationId, productId: integ.productId, integrationId: integ.id, provider: integ.provider as SearchProvider };
  let rows = 0;
  for (const range of ranges) {
    let search;
    try {
      search = await adapter.fetchSearchRows(integ.config, secret, range, { pagePrefix: prefix, delayMs: opts.delayMs });
    } catch (e) {
      await recordFailure(run, integ, e);
      throw jobError(e);
    }
    rows += search.length;
    await run(async (tx) => {
      await upsertSearchRows(tx, target, search);
      await upsertMetrics(tx, integ.organizationId, integ.productId!, integ.provider, searchTotalsAsMetrics(search));
      await tx
        .update(integrations)
        .set({ config: sql`${integrations.config} || ${JSON.stringify({ _backfillRun: runId, _backfillOldest: range.start })}::jsonb` })
        .where(eq(integrations.id, integ.id));
    });
    if (opts.delayMs !== 0) await new Promise((r) => setTimeout(r, opts.delayMs ?? 500));
  }
  await run((tx) =>
    tx
      .update(integrations)
      .set({ config: sql`${integrations.config} || ${JSON.stringify({ _backfillDone: new Date().toISOString() })}::jsonb` })
      .where(eq(integrations.id, integ.id)),
  );
  return { chunks: ranges.length, rows, ranges };
}

/** Daily totals for a metric across products (or one product), summed per day. */
export async function metricSeries(tx: Tx, organizationId: string, metric: string, since: string, opts: { productId?: string; provider?: string; dimension?: string } = {}) {
  const r = await tx.execute<{ day: string; value: number }>(sql`
    select day::text as day, sum(value)::float as value from visibility_metrics
    where organization_id = ${organizationId} and metric = ${metric} and day >= ${since}
    ${opts.productId ? sql`and product_id = ${opts.productId}` : sql``}
    ${opts.provider ? sql`and provider = ${opts.provider}` : sql``}
    ${opts.dimension !== undefined ? sql`and dimension = ${opts.dimension}` : sql``}
    group by day order by day`);
  return r.rows.map((x) => ({ day: x.day, value: Number(x.value) }));
}

export async function hasMetric(tx: Tx, organizationId: string, metric: string, productId?: string) {
  const r = await tx.select({ n: sql<number>`count(*)::int` }).from(visibilityMetrics).where(and(eq(visibilityMetrics.organizationId, organizationId), eq(visibilityMetrics.metric, metric), productId ? eq(visibilityMetrics.productId, productId) : undefined, gte(visibilityMetrics.day, isoDay(addDays(new Date(), -90)))));
  return Number(r[0]?.n ?? 0) > 0;
}
