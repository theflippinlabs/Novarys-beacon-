import { cookies } from "next/headers";
import { and, desc, eq } from "drizzle-orm";
import { createApiKeyAction, revokeApiKeyAction } from "@/app/actions/products";
import { Badge, Button, Field, Flash, HiddenBack, PageHeader, Panel, StatusBadge, Table, Td, Th } from "@/components/ui";
import { ProductTabs } from "@/components/shell/product-tabs";
import { apiKeys, conversionEvents } from "@/db/schema";
import { env } from "@/lib/env";
import { pageData, productOr404, type SP } from "@/lib/page";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Tracking") };
}

export default async function TrackingPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SP> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const newKey = (await cookies()).get("beacon_new_key")?.value ?? null;
  const { data, can } = await pageData(async (tx, ctx) => {
    const p = await productOr404(tx, ctx.org.id, slug);
    const keys = await tx.select().from(apiKeys).where(and(eq(apiKeys.organizationId, ctx.org.id), eq(apiKeys.productId, p.id))).orderBy(desc(apiKeys.createdAt));
    const events = await tx.select().from(conversionEvents).where(eq(conversionEvents.productId, p.id)).orderBy(desc(conversionEvents.occurredAt)).limit(15);
    return { p, keys, events };
  });
  const { t, locale } = await getI18n();
  const label = (v: string) => (locale === "fr" ? enumLabel(t, v) : v);
  const base = env().BEACON_BASE_URL;
  const back = `/products/${slug}/tracking`;
  const pk = data.keys.find((k) => k.kind === "PUBLISHABLE" && !k.revokedAt);
  return (
    <>
      <PageHeader eyebrow={t("Tracking · {name}", { name: data.p.name })} title={t("Conversion tracking & keys")} description={t("First-party, privacy-respecting measurement. Browser (publishable) keys can only send PAGE_VIEW and CTA_CLICK from allowed origins; lifecycle and revenue events require a secret server key.")} />
      <ProductTabs slug={slug} active="tracking" />
      <Flash searchParams={sp} />
      {newKey && (
        <div className="mb-6 border border-gold px-4 py-3">
          <div className="eyebrow text-gold">{t("New key — shown once")}</div>
          <code className="num mt-1 block break-all text-sm text-platinum">{newKey}</code>
        </div>
      )}
      <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
        <Panel title={t("API keys")} pad={false}>
          {data.keys.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>{t("Name")}</Th>
                  <Th>{t("Type")}</Th>
                  <Th>{t("Prefix")}</Th>
                  <Th>{t("Origins")}</Th>
                  <Th>{t("Last used")}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data.keys.map((k) => (
                  <tr key={k.id}>
                    <Td className="text-platinum">{k.name}</Td>
                    <Td>
                      <Badge tone={k.kind === "SECRET" ? "gold" : "neutral"}>{label(k.kind)}</Badge>
                    </Td>
                    <Td className="num text-xs">{k.kind === "PUBLISHABLE" ? "bpk" : "bsk"}_{k.prefix}_…</Td>
                    <Td className="text-xs">{k.allowedOrigins.join(", ") || (k.kind === "SECRET" ? t("server-side") : t("product domain"))}</Td>
                    <Td className="num text-xs">{k.lastUsedAt?.toISOString().slice(0, 16).replace("T", " ") ?? t("never")}</Td>
                    <Td>
                      {k.revokedAt ? (
                        <StatusBadge status="REJECTED" />
                      ) : (
                        can("apikey:manage") && (
                          <form action={revokeApiKeyAction}>
                            <HiddenBack path={back} />
                            <input type="hidden" name="id" value={k.id} />
                            <Button variant="danger">{t("Revoke")}</Button>
                          </form>
                        )
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="p-4 text-sm text-muted">{t("No keys yet.")}</p>
          )}
        </Panel>
        {can("apikey:manage") && (
          <Panel title={t("Create key")}>
            <form action={createApiKeyAction} className="flex flex-col gap-3">
              <HiddenBack path={back} />
              <input type="hidden" name="productSlug" value={slug} />
              <Field label={t("Name")}>
                <input name="name" required defaultValue={t("Website tracker")} />
              </Field>
              <Field label={t("Type")}>
                <select name="kind">
                  <option value="PUBLISHABLE">{t("Publishable (browser)")}</option>
                  <option value="SECRET">{t("Secret (server)")}</option>
                </select>
              </Field>
              <Field label={t("Extra allowed origins")} hint={t("Comma separated hosts. The product domain is always allowed for publishable keys.")}>
                <input name="allowedOrigins" placeholder="app.example.com" />
              </Field>
              <div>
                <Button variant="gold">{t("Create key")}</Button>
              </div>
            </form>
          </Panel>
        )}
      </div>

      <Panel title={t("Install")} eyebrow={t("Snippets")} className="mt-6">
        <div className="eyebrow mb-2">{t("Browser — page views & CTA clicks (add data-beacon-cta to CTA links)")}</div>
        <pre className="overflow-x-auto border border-line bg-obsidian p-3 text-[12px] text-chrome">{`<script async src="${base}/beacon.js" data-key="${pk ? `bpk_${pk.prefix}_…` : "YOUR_PUBLISHABLE_KEY"}" data-product="${slug}"></script>
<a href="/signup" data-beacon-cta="TRY_FREE">Try free</a>`}</pre>
        <div className="eyebrow mb-2 mt-5">{t("Server — lifecycle events (signup → subscription)")}</div>
        <pre className="overflow-x-auto border border-line bg-obsidian p-3 text-[12px] text-chrome">{`curl -X POST ${base}/api/v1/events \\
  -H "authorization: Bearer $BEACON_SECRET_KEY" -H "content-type: application/json" \\
  -d '{"type":"SIGNUP","identityRef":"user_123","visitorId":"<from beacon cookie bcn_vid>","consent":{"analytics":true,"marketing":false,"crossProduct":false}}'`}</pre>
        <div className="eyebrow mb-2 mt-5">{t("Server — revenue (or connect Stripe webhooks in Settings → Integrations)")}</div>
        <pre className="overflow-x-auto border border-line bg-obsidian p-3 text-[12px] text-chrome">{`curl -X POST ${base}/api/v1/revenue -H "authorization: Bearer $BEACON_SECRET_KEY" -H "content-type: application/json" \\
  -d '{"externalId":"inv_001","type":"NEW","amountCents":4900,"mrrDeltaCents":4900,"currency":"EUR","identityRef":"user_123",
       "subscription":{"externalId":"sub_001","plan":"Pro","status":"ACTIVE","mrrCents":4900}}'`}</pre>
      </Panel>

      <Panel title={t("Latest events")} eyebrow={t("Live")} className="mt-6" pad={false}>
        {data.events.length ? (
          <Table>
            <thead>
              <tr>
                <Th>{t("Time")}</Th>
                <Th>{t("Type")}</Th>
                <Th>{t("Path")}</Th>
                <Th>{t("Channel")}</Th>
                <Th>CTA</Th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={e.id}>
                  <Td className="num text-xs">{e.occurredAt.toISOString().slice(0, 19).replace("T", " ")}</Td>
                  <Td>
                    <Badge>{label(e.type)}</Badge>
                  </Td>
                  <Td className="num text-xs">{e.pagePath ?? "—"}</Td>
                  <Td className="text-xs">{e.channel ? (e.channel === "PAID" && locale === "fr" ? t("PAID ADS") : label(e.channel)) : "—"}</Td>
                  <Td className="text-xs">{e.ctaId ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="p-4 text-sm text-muted">{t("No events received yet.")}</p>
        )}
      </Panel>
    </>
  );
}
