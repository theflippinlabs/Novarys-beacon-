import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { disableIntegrationAction, saveIntegrationAction, syncIntegrationNowAction, testIntegrationAction } from "@/app/actions/settings";
import { Badge, Button, Field, Flash, HiddenBack, PageHeader, Panel, StatusBadge, Table, Td, Th } from "@/components/ui";
import { SettingsTabs } from "@/components/shell/settings-tabs";
import { integrations, products, providerCredentials } from "@/db/schema";
import { INTEGRATION_CATALOG } from "@/integrations/registry";
import { env } from "@/lib/env";
import { pageData, type SP } from "@/lib/page";
import { getI18n, getT } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Integrations") };
}

export default async function IntegrationsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { t } = await getI18n();
  const { data, can } = await pageData(async (tx, ctx) => {
    const list = await tx.select().from(integrations).where(eq(integrations.organizationId, ctx.org.id));
    const creds = await tx.select({ integrationId: providerCredentials.integrationId, rotatedAt: providerCredentials.rotatedAt, createdAt: providerCredentials.createdAt }).from(providerCredentials).where(eq(providerCredentials.organizationId, ctx.org.id));
    const prods = await tx.select().from(products).where(eq(products.organizationId, ctx.org.id)).orderBy(products.name);
    return { list, creds: new Map(creds.map((c) => [c.integrationId, c])), prods };
  });
  const back = "/settings/integrations";
  const pname = (id: string | null) => (id ? data.prods.find((p) => p.id === id)?.name ?? "—" : t("Organisation"));
  const base = env().BEACON_BASE_URL;
  return (
    <>
      <PageHeader
        eyebrow={t("13 / Settings")}
        title={t("Integrations")}
        description={t("Provider adapters are swappable; Beacon core never depends on one vendor. Credentials are encrypted with AES-256-GCM, never returned to the browser and never logged. Only official APIs are used — no scraping.")}
      />
      <SettingsTabs active="integrations" />
      <Flash searchParams={sp} />
      <Panel title={t("Connected")} eyebrow={t("Health")} pad={false}>
        {data.list.length ? (
          <Table>
            <thead>
              <tr>
                <Th>{t("Provider")}</Th>
                <Th>{t("Scope")}</Th>
                <Th>{t("Config")}</Th>
                <Th>{t("Secret")}</Th>
                <Th>{t("Status")}</Th>
                <Th>{t("Last sync")}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {data.list.map((i) => (
                <tr key={i.id}>
                  <Td className="text-platinum">{i.provider.replace(/_/g, " ")}</Td>
                  <Td className="text-xs">{pname(i.productId)}</Td>
                  <Td className="num text-[11px]">
                    {Object.entries(i.config)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(" · ") || "—"}
                    {i.provider === "STRIPE" && <div className="text-muted">{t("Webhook URL: {url}", { url: `${base}/api/webhooks/stripe/${i.id}` })}</div>}
                  </Td>
                  <Td className="text-xs">{data.creds.has(i.id) ? <Badge tone="ok">{t("encrypted")}</Badge> : <Badge tone="muted">{t("none")}</Badge>}</Td>
                  <Td>
                    <StatusBadge status={i.status} />
                    {i.lastError && <div className="mt-1 max-w-xs text-[10px] text-crit">{i.lastError}</div>}
                    {i.consecutiveFailures > 0 && <div className="num text-[10px] text-muted">{t("{n} consecutive failure(s)", { n: i.consecutiveFailures })}</div>}
                  </Td>
                  <Td className="num text-xs">{i.lastSyncAt?.toISOString().slice(0, 16).replace("T", " ") ?? "—"}</Td>
                  <Td>
                    <div className="flex flex-wrap gap-2">
                      {can("integration:manage") && (
                        <form action={testIntegrationAction}>
                          <HiddenBack path={back} />
                          <input type="hidden" name="id" value={i.id} />
                          <Button>{t("Test")}</Button>
                        </form>
                      )}
                      {can("job:run") && ["GOOGLE_SEARCH_CONSOLE", "GOOGLE_ANALYTICS", "BING_WEBMASTER"].includes(i.provider) && (
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
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="p-4 text-sm text-muted">{t("Nothing connected yet. Beacon works with first-party events alone; connect providers to add measured search, analytics and revenue data.")}</p>
        )}
      </Panel>

      {can("integration:manage") && (
        <div className="mt-6 grid gap-6 lg:grid-cols-2 2xl:grid-cols-3">
          {INTEGRATION_CATALOG.map((c) => (
            <Panel key={c.provider} title={c.provider.replace(/_/g, " ")} eyebrow={t(c.kind)}>
              <p className="mb-4 text-xs text-chrome">{t(c.description)}</p>
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
                {c.provider === "GOOGLE_SEARCH_CONSOLE" && (
                  <>
                    <Field label={t("Property")}>
                      <input name="siteUrl" placeholder="sc-domain:example.com" required />
                    </Field>
                    <Field label={t("Service account JSON")} hint={t("Add the service account email as a user on the property.")}>
                      <textarea name="serviceAccountJson" className="min-h-24 font-mono text-[11px]" autoComplete="off" />
                    </Field>
                  </>
                )}
                {c.provider === "GOOGLE_ANALYTICS" && (
                  <>
                    <Field label={t("GA4 property ID")}>
                      <input name="propertyId" placeholder="123456789" required />
                    </Field>
                    <Field label={t("Service account JSON")}>
                      <textarea name="serviceAccountJson" className="min-h-24 font-mono text-[11px]" autoComplete="off" />
                    </Field>
                  </>
                )}
                {c.provider === "BING_WEBMASTER" && (
                  <>
                    <Field label={t("Verified site URL")}>
                      <input name="siteUrl" placeholder="https://example.com/" required />
                    </Field>
                    <Field label={t("API key")}>
                      <input name="apiKey" type="password" autoComplete="off" />
                    </Field>
                  </>
                )}
                {c.provider === "STRIPE" && (
                  <>
                    <Field label={t("Webhook signing secret")} hint={t("From the Stripe endpoint (whsec_…). Events: invoice.paid, customer.subscription.updated/deleted, charge.refunded.")}>
                      <input name="webhookSecret" type="password" autoComplete="off" />
                    </Field>
                    <Field label={t("Default product slug")} hint={t("Used when an event carries no metadata.beacon_product.")}>
                      <input name="defaultProduct" placeholder={data.prods[0]?.slug ?? t("product-slug")} />
                    </Field>
                  </>
                )}
                {(c.provider === "ANTHROPIC" || c.provider === "OPENAI" || c.provider === "PERPLEXITY") && (
                  <>
                    <Field label={t("API key")}>
                      <input name="apiKey" type="password" autoComplete="off" />
                    </Field>
                    <Field label={t("Model (optional)")} hint={t("Default: {model}", { model: c.provider === "ANTHROPIC" ? "claude-opus-5-5" : c.provider === "PERPLEXITY" ? "sonar" : "gpt-5" })}>
                      <input name="model" />
                    </Field>
                  </>
                )}
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
