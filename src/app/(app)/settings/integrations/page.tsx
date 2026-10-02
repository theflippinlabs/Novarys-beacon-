import { and, asc, count, eq, inArray } from "drizzle-orm";
import { Pager } from "@/components/shell/pager";
import { decodeCursor, PAGE_SIZE, pageOf } from "@/core/util/cursor";
import { afterCursor, msKey, tsCursor } from "@/lib/paginate";
import type { Metadata } from "next";
import { disableIntegrationAction, saveIntegrationAction, selectGoogleSiteAction, syncIntegrationNowAction, testIntegrationAction } from "@/app/actions/settings";
import { Badge, Button, Field, Flash, HiddenBack, PageHeader, Panel, StatusBadge } from "@/components/ui";
import { SettingsTabs } from "@/components/shell/settings-tabs";
import { SecretFileField } from "@/components/settings/secret-file-field";
import { integrations, products, providerCredentials } from "@/db/schema";
import { isStaleSync } from "@/core/integrations/health";
import { googleOAuthClient } from "@/integrations/google-oauth";
import { catalogEntry, INTEGRATION_CATALOG, isSearchProvider } from "@/integrations/registry";
import { sanitizeProviderMessage } from "@/integrations/types";
import { parseSites } from "@/services/integration-health";
import { inboxSummary } from "@/services/stripe";
import { reprocessWebhookInboxAction } from "@/app/actions/settings";
import type { T } from "@/i18n/core";
import { env } from "@/lib/env";
import { pageData, sp1, type SP } from "@/lib/page";
import { getI18n, getT } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Integrations") };
}

const when = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : null);

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { t } = await getI18n();
  const cursor = decodeCursor(sp1(sp, "cursor"));
  const { data, can } = await pageData(async (tx, ctx) => {
    // Paginated (cursor, 50 per page) in connection order.
    const [{ total }] = await tx.select({ total: count() }).from(integrations).where(eq(integrations.organizationId, ctx.org.id));
    const page = pageOf(
      await tx
        .select()
        .from(integrations)
        .where(and(eq(integrations.organizationId, ctx.org.id), afterCursor(integrations.createdAt, integrations.id, cursor, "asc", "timestamp")))
        .orderBy(asc(msKey(integrations.createdAt)), asc(integrations.id))
        .limit(PAGE_SIZE + 1),
      PAGE_SIZE,
      (r) => tsCursor(r.createdAt, r.id),
    );
    const list = page.items;
    const creds = list.length
      ? await tx
          .select({ integrationId: providerCredentials.integrationId, rotatedAt: providerCredentials.rotatedAt, createdAt: providerCredentials.createdAt })
          .from(providerCredentials)
          .where(and(eq(providerCredentials.organizationId, ctx.org.id), inArray(providerCredentials.integrationId, list.map((i) => i.id))))
      : [];
    const prods = await tx.select().from(products).where(eq(products.organizationId, ctx.org.id)).orderBy(products.name);
    const inbox = await inboxSummary(tx, ctx.org.id);
    return { list, total, next: page.next, creds: new Map(creds.map((c) => [c.integrationId, c])), prods, inbox };
  });
  const back = "/settings/integrations";
  const pname = (id: string | null) => (id ? data.prods.find((p) => p.id === id)?.name ?? t("n/a") : t("Organisation"));
  const base = env().BEACON_BASE_URL;
  const oauthReady = googleOAuthClient() !== null;
  const now = new Date();
  return (
    <>
      <PageHeader
        eyebrow={t("13 / Settings")}
        title={t("Integrations")}
        description={t("Provider adapters are swappable; Beacon core never depends on one vendor. Credentials are encrypted with AES-256-GCM, never returned to the browser and never logged. Only official APIs are used, no scraping.")}
      />
      <SettingsTabs active="integrations" />
      <Flash searchParams={sp} />
      <Panel title={t("Connected")} eyebrow={t("Health")}>
        {data.list.length ? (
          <ul className="flex flex-col gap-4">
            {data.list.map((i) => {
              const entry = catalogEntry(i.provider);
              const oauth = i.config._authMode === "oauth";
              const sites = parseSites(i.config._sites);
              const visibleConfig = Object.entries(i.config).filter(([k]) => !k.startsWith("_"));
              const stale = isStaleSync(i, now);
              const needsReconnect = i.status === "EXPIRED" || i.status === "ERROR";
              return (
                <li key={i.id} id={`integration-${i.id}`} className="border border-line bg-obsidian/40 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-platinum">{entry?.label ?? i.provider.replace(/_/g, " ")}</div>
                      <div className="text-xs text-muted">
                        {pname(i.productId)}
                        {oauth ? ` · ${t("Connected with Google (OAuth)")}` : i.provider === "GOOGLE_SEARCH_CONSOLE" && i.config._authMode === "service_account" ? ` · ${t("Service account")}` : ""}
                      </div>
                    </div>
                    <StatusBadge status={i.status} />
                  </div>
                  <dl className="mt-3 grid grid-cols-1 gap-x-6 gap-y-2 text-xs sm:grid-cols-2 lg:grid-cols-3">
                    <div>
                      <dt className="eyebrow">{t("Last successful sync")}</dt>
                      <dd className="num text-chrome">{when(i.lastSuccessAt ?? (i.status === "CONNECTED" ? i.lastSyncAt : null)) ?? t("never")}</dd>
                    </div>
                    <div>
                      <dt className="eyebrow">{t("Last failed sync")}</dt>
                      <dd className="num text-chrome">{when(i.lastFailureAt) ?? t("never")}</dd>
                    </div>
                    <div>
                      <dt className="eyebrow">{t("Permissions")}</dt>
                      <dd className="break-words text-chrome">{i.scopes.length ? i.scopes.join(", ") : t("n/a")}</dd>
                    </div>
                    <div className="sm:col-span-2 lg:col-span-1">
                      <dt className="eyebrow">{t("Config")}</dt>
                      <dd className="num break-all text-[11px] text-chrome">{visibleConfig.map(([k, v]) => `${k}=${v}`).join(" · ") || t("n/a")}</dd>
                    </div>
                    <div>
                      <dt className="eyebrow">{t("Secret")}</dt>
                      <dd>{data.creds.has(i.id) ? <Badge tone="ok">{t("encrypted")}</Badge> : <Badge tone="muted">{t("none")}</Badge>}</dd>
                    </div>
                    {isSearchProvider(i.provider) && (
                      <div>
                        <dt className="eyebrow">{t("History import")}</dt>
                        <dd className="text-chrome">
                          {i.config._backfillDone
                            ? t("Done ({date})", { date: i.config._backfillDone.slice(0, 10) })
                            : i.config._backfillOldest
                              ? t("In progress (back to {date})", { date: i.config._backfillOldest })
                              : t("Starts after the first successful connection")}
                        </dd>
                      </div>
                    )}
                  </dl>
                  {i.lastError && i.status !== "CONNECTED" && <p className="mt-3 break-words text-xs text-crit">{t("Error reason: {reason}", { reason: sanitizeProviderMessage(i.lastError) })}</p>}
                  {i.consecutiveFailures > 0 && <p className="num mt-1 text-[11px] text-muted">{t("{n} consecutive failure(s)", { n: i.consecutiveFailures })}</p>}
                  {i.status === "EXPIRED" && <p className="mt-2 text-xs text-warn">{t("Access expired or was revoked. Reconnect to resume syncing; scheduled syncs are paused until then.")}</p>}
                  {stale && i.status === "CONNECTED" && <p className="mt-2 text-xs text-warn">{t("No successful sync for more than 36 hours.")}</p>}
                  {i.provider === "STRIPE" && <p className="mt-2 break-all text-[11px] text-muted">{t("Webhook URL: {url}", { url: `${base}/api/webhooks/stripe/${i.id}` })}</p>}
                  {i.provider === "STRIPE" && <StripeInbox t={t} summary={data.inbox.get(i.id)} lastError={i.lastError} integrationId={i.id} canManage={can("integration:manage")} back={back} />}

                  {can("integration:manage") && oauth && sites.length > 0 && (
                    <form action={selectGoogleSiteAction} className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-4">
                      <HiddenBack path={back} />
                      <input type="hidden" name="id" value={i.id} />
                      <Field label={i.config.siteUrl ? t("Change property") : t("Choose the Search Console property")}>
                        <select name="siteUrl" defaultValue={i.config.siteUrl ?? sites[0].siteUrl}>
                          {sites.map((s) => (
                            <option key={s.siteUrl} value={s.siteUrl}>
                              {s.siteUrl} ({s.permissionLevel})
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label={t("Page URL prefix for this product (optional)")}>
                        <input name="urlPrefix" defaultValue={i.config.urlPrefix ?? ""} placeholder="https://example.com/product/" />
                      </Field>
                      <Button variant="gold">{t("Use this property")}</Button>
                    </form>
                  )}

                  <div className="mt-4 flex flex-wrap gap-2">
                    {can("integration:manage") && oauth && needsReconnect && oauthReady && i.productId && (
                      <form method="get" action="/api/integrations/google/start">
                        <input type="hidden" name="productId" value={i.productId} />
                        <Button variant="gold">{t("Reconnect")}</Button>
                      </form>
                    )}
                    {can("integration:manage") && !(oauth && needsReconnect && oauthReady) && (
                      <form action={testIntegrationAction}>
                        <HiddenBack path={back} />
                        <input type="hidden" name="id" value={i.id} />
                        <Button variant={needsReconnect ? "gold" : "ghost"}>{needsReconnect ? t("Reconnect") : t("Test")}</Button>
                      </form>
                    )}
                    {can("job:run") && entry?.syncable && i.status !== "DISABLED" && (
                      <form action={syncIntegrationNowAction}>
                        <HiddenBack path={back} />
                        <input type="hidden" name="id" value={i.id} />
                        <Button>{t("Sync now")}</Button>
                      </form>
                    )}
                    {can("integration:manage") && i.status !== "DISABLED" && (
                      <form action={disableIntegrationAction}>
                        <HiddenBack path={back} />
                        <input type="hidden" name="id" value={i.id} />
                        <Button variant="danger">{t("Disable")}</Button>
                      </form>
                    )}
                  </div>
                  {needsReconnect && !oauth && <p className="mt-2 text-[11px] text-muted">{t("Reconnect tests the stored credentials again. To replace them, save the form below with new credentials.")}</p>}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted">{t("Nothing connected yet. Beacon works with first-party events alone; connect providers to add measured search, analytics and revenue data.")}</p>
        )}
        <Pager path="/settings/integrations" params={{}} shown={data.list.length} total={data.total} next={data.next} current={sp1(sp, "cursor")} />
      </Panel>

      {can("integration:manage") && (
        <div className="mt-6 grid gap-6 lg:grid-cols-2 2xl:grid-cols-3">
          {INTEGRATION_CATALOG.map((c) => (
            <Panel key={c.provider} title={c.label} eyebrow={t(c.kind)}>
              <p className="mb-4 text-xs text-chrome">{t(c.description)}</p>
              {c.oauth === "google" && (
                <div className="mb-4 border border-line p-3">
                  <div className="eyebrow mb-2 text-chrome">{t("Connect with Google (recommended)")}</div>
                  {oauthReady ? (
                    data.prods.length ? (
                      <form method="get" action="/api/integrations/google/start" className="flex flex-wrap items-end gap-3">
                        <Field label={t("Product")}>
                          <select name="productId" required>
                            {data.prods.map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                          </select>
                        </Field>
                        <Button variant="gold">{t("Connect Google Search Console")}</Button>
                      </form>
                    ) : (
                      <p className="text-xs text-muted">{t("Add a product first.")}</p>
                    )
                  ) : (
                    <>
                      <Badge tone="muted">{t("Not configured: add the Google OAuth client")}</Badge>
                      <p className="mt-2 text-[11px] text-muted">{t("Set GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET on the server (redirect URI: {url}). The service-account option below works without it.", { url: `${base.replace(/\/$/, "")}/api/integrations/google/callback` })}</p>
                    </>
                  )}
                  <div className="eyebrow mt-4 text-muted">{t("Or use a service account")}</div>
                </div>
              )}
              <form action={saveIntegrationAction} className="flex flex-col gap-3">
                <HiddenBack path={back} />
                <input type="hidden" name="provider" value={c.provider} />
                {c.scope === "product" && (
                  <Field label={t("Product")}>
                    <select name="productId" required>
                      {data.prods.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </select>
                  </Field>
                )}
                {c.configFields.map((f) => (
                  <Field key={f.key} label={t(f.label)} hint={f.hint ? t(f.hint) : undefined}>
                    <input name={f.key} placeholder={f.placeholder} required={f.required} />
                  </Field>
                ))}
                {c.secretFields.map((f) => (
                  <Field key={f.key} label={t(f.label)} hint={f.hint ? t(f.hint) : undefined}>
                    {f.multiline ? <SecretFileField name={f.key} /> : <input name={f.key} type="password" autoComplete="off" />}
                  </Field>
                ))}
                <p className="text-[11px] text-muted">{t("Saving runs a connection test; the integration is marked connected only when it passes.")}</p>
                <div>
                  <Button>{t("Save")}</Button>
                </div>
              </form>
            </Panel>
          ))}
        </div>
      )}
    </>
  );
}

/** Stripe webhook inbox: what was received, what could not be mapped, and a reprocess button once the mapping is fixed. */
function StripeInbox({ t, summary, lastError, integrationId, canManage, back }: { t: T; summary?: Record<string, { n: number; lastError: string | null }>; lastError: string | null; integrationId: string; canManage: boolean; back: string }) {
  const n = (k: string) => summary?.[k]?.n ?? 0;
  const pending = n("UNMAPPED") + n("FAILED") + n("RECEIVED");
  return (
    <div className="mt-3 border-t border-line pt-3 text-xs">
      <div className="eyebrow mb-1">{t("Webhook inbox")}</div>
      <p className="num text-chrome">{t("{processed} processed · {unmapped} unmapped · {failed} failed", { processed: n("PROCESSED"), unmapped: n("UNMAPPED"), failed: n("FAILED") })}</p>
      {pending > 0 && (summary?.UNMAPPED?.lastError ?? summary?.FAILED?.lastError ?? lastError) && <p className="mt-1 break-words text-warn">{summary?.UNMAPPED?.lastError ?? summary?.FAILED?.lastError ?? lastError}</p>}
      <p className="mt-1 text-[11px] text-muted">{t("Link revenue to people: set metadata.beacon_identity (your user id, the identityRef you send to Beacon) on the subscription or checkout session, or pass it as client_reference_id at checkout. Map products with metadata.beacon_product on the price, subscription or invoice, or a default product.")}</p>
      {canManage && pending > 0 && (
        <form action={reprocessWebhookInboxAction} className="mt-2">
          <HiddenBack path={back} />
          <input type="hidden" name="id" value={integrationId} />
          <Button variant="gold">{t("Reprocess {n} event(s)", { n: pending })}</Button>
        </form>
      )}
    </div>
  );
}

