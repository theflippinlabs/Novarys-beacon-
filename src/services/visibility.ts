import { and, eq, gte, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { integrations, providerCredentials, visibilityMetrics } from "@/db/schema";
import { isVisibilityProvider, VISIBILITY_ADAPTERS } from "@/integrations/registry";
import type { MetricRow } from "@/integrations/types";
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

/** Store credentials encrypted (AES-256-GCM, AAD bound to the integration id). Plaintext is never persisted or logged. */
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
  await tx.update(integrations).set({ config: input.config, status: "CONNECTED", lastError: null, consecutiveFailures: 0 }).where(eq(integrations.id, integ.id));
  if (input.secret && Object.values(input.secret).some(Boolean)) {
    const ciphertext = encryptSecret(JSON.stringify(input.secret), integ.id);
    await tx
      .insert(providerCredentials)
      .values({ organizationId: actor.organizationId, integrationId: integ.id, ciphertext })
      .onConflictDoUpdate({ target: providerCredentials.integrationId, set: { ciphertext, rotatedAt: new Date() } });
  }
  await audit(tx, actor, "integration.save", "integration", integ.id, { provider: input.provider, productId: input.productId, configKeys: Object.keys(input.config), rotated: Boolean(input.secret) });
  return integ;
}

export async function loadSecret(tx: Tx, integrationId: string): Promise<Record<string, string>> {
  const cred = await tx.query.providerCredentials.findFirst({ where: eq(providerCredentials.integrationId, integrationId) });
  if (!cred) return {};
  return JSON.parse(decryptSecret(cred.ciphertext, integrationId));
}

/** Pull metrics for one integration. Network calls happen outside DB transactions. */
export async function syncIntegration(run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>, integrationId: string, days = 28) {
  const { integ, secret } = await run(async (tx) => {
    const integ = await tx.query.integrations.findFirst({ where: eq(integrations.id, integrationId) });
    if (!integ) throw new Error("Integration not found");
    return { integ, secret: await loadSecret(tx, integ.id) };
  });
  if (!isVisibilityProvider(integ.provider) || !integ.productId) return { skipped: true };
  const adapter = VISIBILITY_ADAPTERS[integ.provider]();
  // Search Console data lags ~2–3 days.
  const end = isoDay(addDays(new Date(), -3));
  const start = isoDay(addDays(new Date(), -3 - days));
  try {
    const rows = await adapter.fetchMetrics(integ.config, secret, { start, end });
    await run(async (tx) => {
      await upsertMetrics(tx, integ.organizationId, integ.productId!, integ.provider, rows);
      await tx.update(integrations).set({ status: "CONNECTED", lastSyncAt: new Date(), lastError: null, consecutiveFailures: 0 }).where(eq(integrations.id, integ.id));
    });
    return { rows: rows.length };
  } catch (e) {
    await run((tx) =>
      tx
        .update(integrations)
        .set({ status: "ERROR", lastError: (e as Error).message.slice(0, 500), consecutiveFailures: sql`${integrations.consecutiveFailures} + 1` })
        .where(eq(integrations.id, integ.id)),
    );
    throw e;
  }
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
