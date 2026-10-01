import { and, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db";
import { integrations, products } from "@/db/schema";
import { buildProvider } from "@/ai/registry";
import { DAILY_SYNC_DAYS, statusForResult } from "@/core/integrations/health";
import { isSearchProvider, isVisibilityProvider, VISIBILITY_ADAPTERS } from "@/integrations/registry";
import { isAuthFailure, sanitizeProviderMessage, type ConnectionTest } from "@/integrations/types";
import { audit, type Actor } from "@/lib/audit";
import { enqueue } from "@/jobs/queue";
import { loadSecret, saveIntegration } from "./visibility";

type Run = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
type Integration = typeof integrations.$inferSelect;

/** Error text safe to store and show: no query strings, keys or tokens; bounded length. */
export const safeErrorText = (message: string) => sanitizeProviderMessage(message).slice(0, 500);

/** Run a provider's connection test. Network I/O: never call inside a DB transaction. */
export async function testConnectionFor(provider: string, config: Record<string, string>, secret: Record<string, string>): Promise<ConnectionTest> {
  if (isVisibilityProvider(provider)) return VISIBILITY_ADAPTERS[provider]().testConnection(config, secret);
  if (provider === "ANTHROPIC" || provider === "OPENAI" || provider === "PERPLEXITY") {
    if (!secret.apiKey) return { ok: false, message: "No API key stored." };
    try {
      const p = buildProvider(provider.toLowerCase() as "anthropic" | "openai" | "perplexity", { apiKey: secret.apiKey, model: config.model });
      await p.answer("Reply with the single word: ok");
      return { ok: true, message: `${p.label} (${p.model}) responded.`, scopes: ["api-key"] };
    } catch (e) {
      const status = (e as { status?: number }).status;
      return { ok: false, message: (e as Error).message, httpStatus: typeof status === "number" ? status : undefined };
    }
  }
  return secret.webhookSecret ? { ok: true, message: "Webhook secret stored; deliveries are verified on receipt.", scopes: ["webhook-signature"] } : { ok: false, message: "No webhook secret stored." };
}

export type RecordedResult = { status: "CONNECTED" | "ERROR" | "EXPIRED"; previousSuccessAt: Date | null; integration: Integration };

/**
 * Persist the outcome of a connection test or sync: status (401/403 mean
 * EXPIRED), last success / failure times, sanitised error, granted scopes.
 */
export async function recordConnectionResult(tx: Tx, integ: Integration, r: { ok: boolean; message: string; httpStatus?: number; authFailure?: boolean; scopes?: string[] }, opts: { synced?: boolean } = {}): Promise<RecordedResult> {
  const status = statusForResult(r);
  const now = new Date();
  const set: Partial<typeof integrations.$inferInsert> = r.ok
    ? { status, lastError: null, consecutiveFailures: 0, lastSuccessAt: now, ...(opts.synced ? { lastSyncAt: now } : {}), ...(r.scopes ? { scopes: r.scopes } : {}) }
    : { status, lastError: safeErrorText(r.message), lastFailureAt: now };
  const [row] = await tx
    .update(integrations)
    .set(r.ok ? set : { ...set, consecutiveFailures: sql`${integrations.consecutiveFailures} + 1` })
    .where(and(eq(integrations.id, integ.id), eq(integrations.organizationId, integ.organizationId)))
    .returning();
  return { status, previousSuccessAt: integ.lastSuccessAt, integration: row ?? integ };
}

/**
 * After a success, import history when needed: the first successful
 * connection triggers the full backfill; a reconnect after a gap longer than
 * the daily window re-imports the missing days.
 */
export async function enqueueBackfillIfNeeded(integ: Integration, previousSuccessAt: Date | null, now = new Date()) {
  if (!isSearchProvider(integ.provider) || !integ.productId) return null;
  const day = now.toISOString().slice(0, 10);
  if (!previousSuccessAt || !integ.config._backfillDone) {
    return enqueue("search.backfill", { integrationId: integ.id, runId: `${integ.id}:${day}` }, { organizationId: integ.organizationId, idempotencyKey: `backfill:${integ.id}:${day}` });
  }
  const gapDays = (now.getTime() - previousSuccessAt.getTime()) / 86_400_000;
  if (gapDays > DAILY_SYNC_DAYS) {
    const since = new Date(previousSuccessAt.getTime() - 7 * 86_400_000).toISOString().slice(0, 10);
    return enqueue("search.backfill", { integrationId: integ.id, since, runId: `${integ.id}:${day}:gap` }, { organizationId: integ.organizationId, idempotencyKey: `backfill:${integ.id}:${day}:gap` });
  }
  return null;
}

/**
 * Test an integration and record the result. Three steps: read (transaction),
 * provider call (no transaction open), write (transaction). Used by "Save",
 * "Test" and "Reconnect".
 */
export async function checkIntegration(run: Run, actor: Actor, integrationId: string): Promise<ConnectionTest & { status: RecordedResult["status"] }> {
  const { integ, secret } = await run(async (tx) => {
    const integ = await tx.query.integrations.findFirst({ where: and(eq(integrations.id, integrationId), eq(integrations.organizationId, actor.organizationId)) });
    if (!integ) throw new Error("Integration not found");
    return { integ, secret: await loadSecret(tx, integ.id) };
  });
  let result: ConnectionTest;
  try {
    result = await testConnectionFor(integ.provider, integ.config, secret);
  } catch (e) {
    result = { ok: false, message: (e as Error).message, httpStatus: isAuthFailure(e) ? 401 : undefined };
  }
  const rec = await run(async (tx) => {
    const r = await recordConnectionResult(tx, integ, result);
    await audit(tx, actor, "integration.test", "integration", integ.id, { ok: result.ok, status: r.status });
    return r;
  });
  if (result.ok) await enqueueBackfillIfNeeded(rec.integration, rec.previousSuccessAt);
  return { ...result, message: result.ok ? result.message : safeErrorText(result.message), status: rec.status };
}

/** Search Console properties listed after "Connect with Google" (stored in the internal `_sites` config key). */
export function parseSites(raw: string | undefined): { siteUrl: string; permissionLevel: string }[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((s): s is { siteUrl: string; permissionLevel: string } => typeof s?.siteUrl === "string" && typeof s?.permissionLevel === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Store the result of a Google OAuth authorisation for one product: the
 * refresh token (encrypted like every secret), granted scopes and the list of
 * properties. The property is kept when still accessible, picked
 * automatically when there is exactly one, otherwise the user chooses it.
 */
export async function connectGoogleOAuth(
  run: Run,
  actor: Actor,
  input: { productId: string; refreshToken: string | null; scopes: string[]; sites: { siteUrl: string; permissionLevel: string }[] },
): Promise<{ integrationId: string; needsSite: boolean; test: (ConnectionTest & { status: RecordedResult["status"] }) | null }> {
  const { integrationId, siteUrl } = await run(async (tx) => {
    const product = await tx.query.products.findFirst({ where: and(eq(products.id, input.productId), eq(products.organizationId, actor.organizationId)) });
    if (!product) throw new Error("Product not found");
    const existing = await tx.query.integrations.findFirst({ where: and(eq(integrations.organizationId, actor.organizationId), eq(integrations.provider, "GOOGLE_SEARCH_CONSOLE"), eq(integrations.productId, product.id)) });
    const oldSecret = existing ? await loadSecret(tx, existing.id) : {};
    const refreshToken = input.refreshToken ?? oldSecret.refreshToken ?? null;
    if (!refreshToken) throw new Error("Google did not return a refresh token. Remove Beacon's access in your Google account settings, then connect again.");
    const keep = existing?.config.siteUrl && input.sites.some((s) => s.siteUrl === existing.config.siteUrl) ? existing.config.siteUrl : null;
    const siteUrl = keep ?? (input.sites.length === 1 ? input.sites[0].siteUrl : null);
    const config: Record<string, string> = {};
    if (siteUrl) config.siteUrl = siteUrl;
    if (existing?.config.urlPrefix) config.urlPrefix = existing.config.urlPrefix;
    const integ = await saveIntegration(tx, actor, { provider: "GOOGLE_SEARCH_CONSOLE", productId: product.id, config, secret: { refreshToken } });
    await tx
      .update(integrations)
      .set({ scopes: input.scopes, config: sql`${integrations.config} || ${JSON.stringify({ _authMode: "oauth", _sites: JSON.stringify(input.sites.slice(0, 200)) })}::jsonb` })
      .where(eq(integrations.id, integ.id));
    await audit(tx, actor, "integration.oauth_connect", "integration", integ.id, { provider: "GOOGLE_SEARCH_CONSOLE", sites: input.sites.length, scopes: input.scopes });
    return { integrationId: integ.id, siteUrl };
  });
  if (!siteUrl) return { integrationId, needsSite: true, test: null };
  return { integrationId, needsSite: false, test: await checkIntegration(run, actor, integrationId) };
}
