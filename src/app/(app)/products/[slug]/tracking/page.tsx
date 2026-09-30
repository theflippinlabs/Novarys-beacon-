import { cookies } from "next/headers";
import { and, desc, eq } from "drizzle-orm";
import { createApiKeyAction, revokeApiKeyAction } from "@/app/actions/products";
import { Badge, Button, Field, Flash, HiddenBack, PageHeader, Panel, StatusBadge, Table, Td, Th } from "@/components/ui";
import { ProductTabs } from "@/components/shell/product-tabs";
import { apiKeys, conversionEvents } from "@/db/schema";
import { env } from "@/lib/env";
import { pageData, productOr404, type SP } from "@/lib/page";

export const metadata = { title: "Tracking" };

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
  const base = env().BEACON_BASE_URL;
  const back = `/products/${slug}/tracking`;
  const pk = data.keys.find((k) => k.kind === "PUBLISHABLE" && !k.revokedAt);
  return (
    <>
      <PageHeader eyebrow={`Tracking · ${data.p.name}`} title="Conversion tracking & keys" description="First-party, privacy-respecting measurement. Browser (publishable) keys can only send PAGE_VIEW and CTA_CLICK from allowed origins; lifecycle and revenue events require a secret server key." />
      <ProductTabs slug={slug} active="tracking" />
      <Flash searchParams={sp} />
      {newKey && (
        <div className="mb-6 border border-gold px-4 py-3">
          <div className="eyebrow text-gold">New key — shown once</div>
          <code className="num mt-1 block break-all text-sm text-platinum">{newKey}</code>
        </div>
      )}
      <div className="grid gap-6 xl:grid-cols-[1fr_24rem]">
        <Panel title="API keys" pad={false}>
          {data.keys.length ? (
            <Table>
              <thead>
                <tr>
                  <Th>Name</Th>
                  <Th>Type</Th>
                  <Th>Prefix</Th>
                  <Th>Origins</Th>
                  <Th>Last used</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data.keys.map((k) => (
                  <tr key={k.id}>
                    <Td className="text-platinum">{k.name}</Td>
                    <Td>
                      <Badge tone={k.kind === "SECRET" ? "gold" : "neutral"}>{k.kind}</Badge>
                    </Td>
                    <Td className="num text-xs">{k.kind === "PUBLISHABLE" ? "bpk" : "bsk"}_{k.prefix}_…</Td>
                    <Td className="text-xs">{k.allowedOrigins.join(", ") || (k.kind === "SECRET" ? "server-side" : "product domain")}</Td>
                    <Td className="num text-xs">{k.lastUsedAt?.toISOString().slice(0, 16).replace("T", " ") ?? "never"}</Td>
                    <Td>
                      {k.revokedAt ? (
                        <StatusBadge status="REJECTED" />
                      ) : (
                        can("apikey:manage") && (
                          <form action={revokeApiKeyAction}>
                            <HiddenBack path={back} />
                            <input type="hidden" name="id" value={k.id} />
                            <Button variant="danger">Revoke</Button>
                          </form>
                        )
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          ) : (
            <p className="p-4 text-sm text-muted">No keys yet.</p>
          )}
        </Panel>
        {can("apikey:manage") && (
          <Panel title="Create key">
            <form action={createApiKeyAction} className="flex flex-col gap-3">
              <HiddenBack path={back} />
              <input type="hidden" name="productSlug" value={slug} />
              <Field label="Name">
                <input name="name" required defaultValue="Website tracker" />
              </Field>
              <Field label="Type">
                <select name="kind">
                  <option value="PUBLISHABLE">Publishable (browser)</option>
                  <option value="SECRET">Secret (server)</option>
                </select>
              </Field>
              <Field label="Extra allowed origins" hint="Comma separated hosts. The product domain is always allowed for publishable keys.">
                <input name="allowedOrigins" placeholder="app.example.com" />
              </Field>
              <div>
                <Button variant="gold">Create key</Button>
              </div>
            </form>
          </Panel>
        )}
      </div>

      <Panel title="Install" eyebrow="Snippets" className="mt-6">
        <div className="eyebrow mb-2">Browser — page views & CTA clicks (add data-beacon-cta to CTA links)</div>
        <pre className="overflow-x-auto border border-line bg-obsidian p-3 text-[12px] text-chrome">{`<script async src="${base}/beacon.js" data-key="${pk ? `bpk_${pk.prefix}_…` : "YOUR_PUBLISHABLE_KEY"}" data-product="${slug}"></script>
<a href="/signup" data-beacon-cta="TRY_FREE">Try free</a>`}</pre>
        <div className="eyebrow mb-2 mt-5">Server — lifecycle events (signup → subscription)</div>
        <pre className="overflow-x-auto border border-line bg-obsidian p-3 text-[12px] text-chrome">{`curl -X POST ${base}/api/v1/events \\
  -H "authorization: Bearer $BEACON_SECRET_KEY" -H "content-type: application/json" \\
  -d '{"type":"SIGNUP","identityRef":"user_123","visitorId":"<from beacon cookie bcn_vid>","consent":{"analytics":true,"marketing":false,"crossProduct":false}}'`}</pre>
        <div className="eyebrow mb-2 mt-5">Server — revenue (or connect Stripe webhooks in Settings → Integrations)</div>
        <pre className="overflow-x-auto border border-line bg-obsidian p-3 text-[12px] text-chrome">{`curl -X POST ${base}/api/v1/revenue -H "authorization: Bearer $BEACON_SECRET_KEY" -H "content-type: application/json" \\
  -d '{"externalId":"inv_001","type":"NEW","amountCents":4900,"mrrDeltaCents":4900,"currency":"EUR","identityRef":"user_123",
       "subscription":{"externalId":"sub_001","plan":"Pro","status":"ACTIVE","mrrCents":4900}}'`}</pre>
      </Panel>

      <Panel title="Latest events" eyebrow="Live" className="mt-6" pad={false}>
        {data.events.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Time</Th>
                <Th>Type</Th>
                <Th>Path</Th>
                <Th>Channel</Th>
                <Th>CTA</Th>
              </tr>
            </thead>
            <tbody>
              {data.events.map((e) => (
                <tr key={e.id}>
                  <Td className="num text-xs">{e.occurredAt.toISOString().slice(0, 19).replace("T", " ")}</Td>
                  <Td>
                    <Badge>{e.type}</Badge>
                  </Td>
                  <Td className="num text-xs">{e.pagePath ?? "—"}</Td>
                  <Td className="text-xs">{e.channel ?? "—"}</Td>
                  <Td className="text-xs">{e.ctaId ?? "—"}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="p-4 text-sm text-muted">No events received yet.</p>
        )}
      </Panel>
    </>
  );
}
