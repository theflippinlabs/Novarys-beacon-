import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, sql } from "drizzle-orm";
import { approveContentAction, generateContentAction, publishContentAction, rejectContentAction, saveVersionAction } from "@/app/actions/content";
import { Badge, Button, Field, Flash, HiddenBack, KV, PageHeader, Panel, StatusBadge, Table, Td, Th, cx } from "@/components/ui";
import { aiRuns, contentAssets, contentVersions, jobs, pages, products, queries } from "@/db/schema";
import { renderMarkdown } from "@/core/content/markdown";
import { PIPELINE } from "@/core/content/workflow";
import { canonicalUrl } from "@/core/discovery/urls";
import { serializeJsonLd } from "@/core/seo/schema-org";
import { pageData, type SP } from "@/lib/page";
import { db } from "@/db";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Content") };
}

export default async function ContentDetail({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { t } = await getI18n();
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { data, can } = await pageData(async (tx, ctx) => {
    const asset = await tx.query.contentAssets.findFirst({ where: and(eq(contentAssets.id, id), eq(contentAssets.organizationId, ctx.org.id)) });
    if (!asset) notFound();
    const versions = await tx.select().from(contentVersions).where(eq(contentVersions.assetId, id)).orderBy(desc(contentVersions.version));
    const product = asset.productId ? await tx.query.products.findFirst({ where: eq(products.id, asset.productId) }) : null;
    const page = asset.pageId ? await tx.query.pages.findFirst({ where: eq(pages.id, asset.pageId) }) : null;
    const target = asset.targetQueryId ? await tx.query.queries.findFirst({ where: eq(queries.id, asset.targetQueryId) }) : null;
    const run = versions[0]?.aiRunId ? await tx.query.aiRuns.findFirst({ where: eq(aiRuns.id, versions[0].aiRunId) }) : null;
    const perf = page
      ? (
          await tx.execute<{ views: number; cta: number; signups: number }>(sql`
        select count(*) filter (where type = 'PAGE_VIEW')::int as views, count(*) filter (where type = 'CTA_CLICK')::int as cta, count(*) filter (where type = 'SIGNUP')::int as signups
        from conversion_events where product_id = ${asset.productId} and page_path = ${page.path} and occurred_at >= now() - interval '28 days'`)
        ).rows[0]
      : null;
    const pending = await db().select().from(jobs).where(and(eq(jobs.organizationId, ctx.org.id), eq(jobs.type, "content.generate"), sql`${jobs.payload}->>'assetId' = ${id}`, sql`${jobs.status} in ('QUEUED','RUNNING')`)).limit(1);
    return { asset, versions, product, page, target, run, perf, pending: pending[0] ?? null };
  });
  const { asset, versions, product, page } = data;
  const v = versions[0];
  const back = `/content/${id}`;
  const stageIdx = PIPELINE.indexOf(asset.status as (typeof PIPELINE)[number]);
  const url = page && product ? canonicalUrl(product.domain, page.path) : null;

  return (
    <>
      <PageHeader
        eyebrow={t("Content · {type} · {product}", { type: enumLabel(t, asset.type), product: product?.name ?? "" })}
        title={asset.title}
        description={
          <>
            {page && <span className="num">{url ?? page.path}</span>} {data.target && <span className="ml-2">{t("· target query “{query}”", { query: data.target.query })}</span>}
          </>
        }
        actions={<Link href="/content" className="eyebrow hover:text-chrome">{t("← Studio")}</Link>}
      />
      <Flash searchParams={sp} />
      <ol className="mb-6 flex flex-wrap gap-1">
        {PIPELINE.map((s, i) => (
          <li key={s} className={cx("border px-2 py-1 font-mono text-[10px] uppercase tracking-wider", asset.status === s ? "border-blue-bright text-platinum" : i < stageIdx ? "border-line-strong text-chrome" : "border-line text-muted")}>
            {enumLabel(t, s)}
          </li>
        ))}
        {asset.status === "REJECTED" && <li className="border border-crit/50 px-2 py-1 font-mono text-[10px] uppercase text-crit">{t("Rejected: {reason}", { reason: asset.rejectionReason ?? "" })}</li>}
      </ol>
      {data.pending && (
        <div className="mb-6 border border-gold-dim px-4 py-3 text-sm text-chrome">
          <StatusBadge status={data.pending.status} /> {t("Draft generation is in the queue. Refresh in a moment.")}
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_26rem]">
        <div className="flex flex-col gap-6">
          <Panel title={v ? t("Version {n}", { n: v.version }) : t("No draft yet")} eyebrow={t("Preview")}>
            {v ? (
              <article className="prose-beacon" dangerouslySetInnerHTML={{ __html: renderMarkdown(v.body) }} />
            ) : (
              <p className="text-sm text-muted">{t("Generate a draft to start. Drafts are composed only from knowledge-graph facts.")}</p>
            )}
          </Panel>
          {v && can("content:write") && (
            <Panel title={t("Edit")} eyebrow={t("Creates a new version and re-runs checks")}>
              <form action={saveVersionAction} className="flex flex-col gap-3">
                <HiddenBack path={back} />
                <input type="hidden" name="assetId" value={asset.id} />
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label={t("Meta title")}>
                    <input name="metaTitle" defaultValue={v.metaTitle ?? ""} maxLength={120} />
                  </Field>
                  <Field label={t("Meta description")}>
                    <input name="metaDescription" defaultValue={v.metaDescription ?? ""} maxLength={300} />
                  </Field>
                </div>
                <Field label={t("Body (Markdown)")}>
                  <textarea name="body" defaultValue={v.body} className="min-h-[28rem] font-mono text-[12.5px] leading-relaxed" />
                </Field>
                <div>
                  <Button>{t("Save new version")}</Button>
                </div>
              </form>
            </Panel>
          )}
        </div>

        <div className="flex flex-col gap-6">
          <Panel title={t("Decision")} eyebrow={t("Workflow")}>
            <div className="flex flex-col gap-3">
              {can("content:write") && (
                <form action={generateContentAction} className="flex flex-wrap items-center gap-2">
                  <HiddenBack path={back} />
                  <input type="hidden" name="assetId" value={asset.id} />
                  <Button variant={v ? "ghost" : "gold"}>{v ? t("Regenerate") : t("Generate draft")}</Button>
                  <label className="flex items-center gap-1.5 text-xs text-chrome">
                    <input type="checkbox" name="useLlm" /> {t("LLM polish")}
                  </label>
                </form>
              )}
              {can("content:approve") && asset.status === "HUMAN_APPROVAL" && (
                <form action={approveContentAction}>
                  <HiddenBack path={back} />
                  <input type="hidden" name="assetId" value={asset.id} />
                  <Button variant="gold">{t("Approve")}</Button>
                </form>
              )}
              {can("content:approve") && asset.status === "APPROVED" && (
                <form action={publishContentAction}>
                  <HiddenBack path={back} />
                  <input type="hidden" name="assetId" value={asset.id} />
                  <Button variant="gold">{t("Publish")}</Button>
                </form>
              )}
              {can("content:approve") && !["REJECTED", "IDEA"].includes(asset.status) && (
                <form action={rejectContentAction} className="flex gap-2">
                  <HiddenBack path={back} />
                  <input type="hidden" name="assetId" value={asset.id} />
                  <input name="reason" placeholder={t("Reason")} required minLength={3} aria-label={t("Rejection reason")} />
                  <Button variant="danger">{t("Reject")}</Button>
                </form>
              )}
              {asset.status === "FACT_CHECK" && <p className="text-xs text-warn">{t("◐ Blocked at fact check — fix or remove unsupported claims (or add the missing facts to the knowledge graph), then save a new version.")}</p>}
              {asset.status === "SEO_CHECK" && <p className="text-xs text-warn">{t("◐ Blocked at SEO/GEO check — see failing rules below.")}</p>}
              {asset.status === "PUBLISHED" && <p className="text-xs text-ok">{t("✓ Published {date}.", { date: asset.publishedAt?.toISOString().slice(0, 10) ?? "" })}</p>}
            </div>
          </Panel>

          {v?.factCheck && (
            <Panel title={v.factCheck.passed ? t("✓ All claims supported") : t("{n} claim(s) need attention", { n: v.factCheck.claims.filter((c) => c.status !== "SUPPORTED").length })} eyebrow={t("Fact check")} pad={false}>
              <Table>
                <tbody>
                  {[...v.factCheck.claims]
                    .sort((a, b) => (a.status === "SUPPORTED" ? 1 : 0) - (b.status === "SUPPORTED" ? 1 : 0))
                    .slice(0, 60)
                    .map((c, i) => (
                      <tr key={i}>
                        <Td className="w-28">
                          <Badge tone={c.status === "SUPPORTED" ? "ok" : c.status === "NEEDS_REVIEW" ? "warn" : "crit"}>{enumLabel(t, c.status)}</Badge>
                        </Td>
                        <Td className="text-xs">
                          {c.claim}
                          {c.sourceUrl && <div className="num mt-0.5 truncate text-[10px] text-muted">{t(c.sourceUrl)}</div>}
                        </Td>
                      </tr>
                    ))}
                </tbody>
              </Table>
            </Panel>
          )}

          {v?.seoCheck && (
            <Panel title={v.seoCheck.passed ? t("✓ SEO/GEO checks pass") : t("SEO/GEO checks")} eyebrow={t("On-page")} pad={false}>
              <Table>
                <tbody>
                  {v.seoCheck.checks.map((c) => (
                    <tr key={c.rule}>
                      <Td className={c.ok ? "text-ok" : "text-crit"}>{c.ok ? "✓" : "✕"}</Td>
                      <Td className="num text-xs">{c.rule}</Td>
                      <Td className="text-xs">{t(c.message)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </Panel>
          )}

          <Panel title={t("Provenance")} eyebrow={t("AI / engine output")}>
            <KV
              items={[
                [t("Generated by"), data.run ? `${data.run.provider}:${data.run.model}` : v ? t("Human edit") : null],
                [t("Prompt / rules version"), data.run?.promptVersion ?? null],
                [t("Timestamp"), v?.createdAt.toISOString().slice(0, 19).replace("T", " ") ?? null],
                [t("Fact references"), v ? String(v.factRefs.length) : null],
              ]}
            />
          </Panel>

          {page && asset.status === "PUBLISHED" && data.perf && (
            <Panel title={t("Performance · 28 days")} eyebrow={t("Measurement")}>
              <KV items={[[t("Views"), data.perf.views], [t("CTA clicks"), data.perf.cta], [t("Signups"), data.perf.signups]]} />
            </Panel>
          )}

          {v && v.structuredData.length > 0 && (
            <Panel title={t("{n} JSON-LD block(s)", { n: v.structuredData.length })} eyebrow={t("Structured data")}>
              <pre className="max-h-72 overflow-auto text-[10.5px] text-chrome">{v.structuredData.map((d) => serializeJsonLd(d)).join("\n\n")}</pre>
            </Panel>
          )}

          <Panel title={t("Versions")} eyebrow={t("History")} pad={false}>
            <Table>
              <thead>
                <tr>
                  <Th>v</Th>
                  <Th>{t("Created")}</Th>
                  <Th>{t("Fact")}</Th>
                  <Th>SEO</Th>
                </tr>
              </thead>
              <tbody>
                {versions.map((x) => (
                  <tr key={x.id}>
                    <Td className="num">{x.version}</Td>
                    <Td className="num text-xs">{x.createdAt.toISOString().slice(0, 16).replace("T", " ")}</Td>
                    <Td>{x.factCheck ? (x.factCheck.passed ? "✓" : "✕") : "—"}</Td>
                    <Td>{x.seoCheck ? (x.seoCheck.passed ? "✓" : "✕") : "—"}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </Panel>
        </div>
      </div>
    </>
  );
}
