import Link from "next/link";
import { notFound } from "next/navigation";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  approveContentAction,
  generateContentAction,
  publishContentAction,
  rejectContentAction,
  repurposeContentAction,
  saveVersionAction,
} from "@/app/actions/content";
import {
  Badge,
  Button,
  Field,
  Flash,
  HiddenBack,
  KV,
  PageHeader,
  Panel,
  StatusBadge,
  Table,
  Td,
  Th,
  cx,
} from "@/components/ui";
import {
  aiRuns,
  contentAssets,
  contentVersions,
  jobs,
  pages,
  products,
  queries,
  type ClaimCheck,
} from "@/db/schema";
import { renderMarkdown } from "@/core/content/markdown";
import { env } from "@/lib/env";
import { listMedia } from "@/services/media";
import { derivativesOf } from "@/services/content";
import { ContentImages } from "@/components/media/content-images";
import { PIPELINE } from "@/core/content/workflow";
import { claimSeverity, severityCounts } from "@/core/content/fact-check";
import { REPURPOSE_LABELS, REPURPOSE_TYPES } from "@/core/content/types";
import { canonicalUrl } from "@/core/discovery/urls";
import { serializeJsonLd } from "@/core/seo/schema-org";
import { pageData, type SP } from "@/lib/page";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Content") };
}

const SEVERITY_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;
const severityTone = (s: string) =>
  s === "HIGH" ? "crit" : s === "MEDIUM" ? "warn" : "ok";
const statusTone = (s: ClaimCheck["status"]) =>
  s === "SUPPORTED"
    ? "ok"
    : s === "NEEDS_REVIEW" || s === "OUTDATED_PRICING"
      ? "warn"
      : "crit";

export default async function ContentDetail({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<SP>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const { t } = await getI18n();
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { data, can, ctx } = await pageData(async (tx, ctx) => {
    const asset = await tx.query.contentAssets.findFirst({
      where: and(
        eq(contentAssets.id, id),
        eq(contentAssets.organizationId, ctx.org.id),
      ),
    });
    if (!asset) notFound();
    const versions = await tx
      .select()
      .from(contentVersions)
      .where(eq(contentVersions.assetId, id))
      .orderBy(desc(contentVersions.version));
    const product = asset.productId
      ? await tx.query.products.findFirst({
          where: eq(products.id, asset.productId),
        })
      : null;
    const page = asset.pageId
      ? await tx.query.pages.findFirst({ where: eq(pages.id, asset.pageId) })
      : null;
    const target = asset.targetQueryId
      ? await tx.query.queries.findFirst({
          where: eq(queries.id, asset.targetQueryId),
        })
      : null;
    const run = versions[0]?.aiRunId
      ? await tx.query.aiRuns.findFirst({
          where: eq(aiRuns.id, versions[0].aiRunId),
        })
      : null;
    const perf = page
      ? (
          await tx.execute<{ views: number; cta: number; signups: number }>(sql`
        select count(*) filter (where type = 'PAGE_VIEW')::int as views, count(*) filter (where type = 'CTA_CLICK')::int as cta, count(*) filter (where type = 'SIGNUP')::int as signups
        from conversion_events where product_id = ${asset.productId} and page_path = ${page.path} and occurred_at >= now() - interval '28 days'`)
        ).rows[0]
      : null;
    // Jobs are tenant rows under RLS: read them through this organisation's transaction.
    const pending = await tx
      .select()
      .from(jobs)
      .where(
        and(
          eq(jobs.organizationId, ctx.org.id),
          eq(jobs.type, "content.generate"),
          sql`${jobs.payload}->>'assetId' = ${id}`,
          sql`${jobs.status} in ('QUEUED','RUNNING')`,
        ),
      )
      .limit(1);
    const images = await listMedia(tx, ctx.org.id, { contentAssetId: id });
    const derivatives = await derivativesOf(tx, asset);
    const source = asset.sourceAssetId
      ? await tx.query.contentAssets.findFirst({
          where: eq(contentAssets.id, asset.sourceAssetId),
        })
      : null;
    const sourceVersion = asset.sourceVersionId
      ? await tx.query.contentVersions.findFirst({
          where: eq(contentVersions.id, asset.sourceVersionId),
        })
      : null;
    return {
      asset,
      versions,
      product,
      page,
      target,
      run,
      perf,
      pending: pending[0] ?? null,
      images,
      derivatives,
      source,
      sourceVersion,
    };
  });
  const { asset, versions, product, page } = data;
  const v = versions[0];
  const live = versions.find((x) => x.id === asset.publishedVersionId) ?? null;
  const approved =
    versions.find((x) => x.id === asset.approvedVersionId) ?? null;
  const back = `/content/${id}`;
  const stageIdx = PIPELINE.indexOf(asset.status as (typeof PIPELINE)[number]);
  const url = page && product ? canonicalUrl(product.domain, page.path) : null;
  const claims = v?.factCheck
    ? [...v.factCheck.claims].sort(
        (a, b) =>
          SEVERITY_ORDER[claimSeverity(a)] - SEVERITY_ORDER[claimSeverity(b)],
      )
    : [];
  const counts = severityCounts(claims);
  const quality = v?.qualityCheck ?? null;
  const distinctApprover = Boolean(
    ctx.org.settings.content?.requireDistinctApprover,
  );
  const authoredByMe = Boolean(v?.createdBy && v.createdBy === ctx.user.id);
  const canRepurpose =
    asset.status === "APPROVED" ||
    asset.status === "PUBLISHED" ||
    Boolean(asset.publishedVersionId);

  return (
    <>
      <PageHeader
        eyebrow={t("Content · {type} · {product}", {
          type: enumLabel(t, asset.type),
          product: product?.name ?? "",
        })}
        title={asset.title}
        description={
          <>
            {page && <span className="num">{url ?? page.path}</span>}{" "}
            {data.target && (
              <span className="ml-2">
                {t("· target query “{query}”", { query: data.target.query })}
              </span>
            )}
          </>
        }
        actions={
          <Link href="/content" className="eyebrow hover:text-chrome">
            {t("← Studio")}
          </Link>
        }
      />
      <Flash searchParams={sp} />
      <ol className="mb-6 flex flex-wrap gap-1">
        {PIPELINE.map((s, i) => (
          <li
            key={s}
            className={cx(
              "border px-2 py-1 font-mono text-[10px] uppercase tracking-wider",
              asset.status === s
                ? "border-blue-bright text-platinum"
                : i < stageIdx
                  ? "border-line-strong text-chrome"
                  : "border-line text-muted",
            )}
          >
            {enumLabel(t, s)}
          </li>
        ))}
        {asset.status === "REJECTED" && (
          <li className="border border-crit/50 px-2 py-1 font-mono text-[10px] uppercase text-crit">
            {t("Rejected: {reason}", { reason: asset.rejectionReason ?? "" })}
          </li>
        )}
      </ol>
      {data.pending && (
        <div className="mb-6 border border-gold-dim px-4 py-3 text-sm text-chrome">
          <StatusBadge status={data.pending.status} />{" "}
          {t("Draft generation is in the queue. Refresh in a moment.")}
        </div>
      )}

      {/* Phones: one column with the decision panel first; desktop: preview left, decision and checks right. */}
      <div className="flex flex-col gap-6 xl:grid xl:grid-cols-[1fr_26rem] xl:items-start">
        <div className="contents xl:flex xl:flex-col xl:gap-6">
          <Panel
            title={v ? t("Version {n}", { n: v.version }) : t("No draft yet")}
            eyebrow={t("Preview")}
          >
            {v ? (
              <article
                className="prose-beacon"
                dangerouslySetInnerHTML={{
                  __html: renderMarkdown(v.body, {
                    imageOrigins: [env().BEACON_BASE_URL],
                  }),
                }}
              />
            ) : (
              <p className="text-sm text-muted">
                {t(
                  "Generate a draft to start. Drafts are composed only from verified knowledge-graph facts.",
                )}
              </p>
            )}
          </Panel>
          {v && can("content:write") && (
            <Panel
              title={t("Edit")}
              eyebrow={
                live
                  ? t(
                      "Creates a new draft version; the published version stays live",
                    )
                  : t("Creates a new version and re-runs checks")
              }
            >
              <form action={saveVersionAction} className="flex flex-col gap-3">
                <HiddenBack path={back} />
                <input type="hidden" name="assetId" value={asset.id} />
                <div className="grid gap-3 md:grid-cols-2">
                  <Field label={t("Meta title")}>
                    <input
                      name="metaTitle"
                      defaultValue={v.metaTitle ?? ""}
                      maxLength={120}
                    />
                  </Field>
                  <Field label={t("Meta description")}>
                    <input
                      name="metaDescription"
                      defaultValue={v.metaDescription ?? ""}
                      maxLength={300}
                    />
                  </Field>
                </div>
                <Field label={t("Body (Markdown)")}>
                  <textarea
                    id="draft-body"
                    name="body"
                    defaultValue={v.body}
                    className="min-h-[28rem] font-mono text-[12.5px] leading-relaxed"
                  />
                </Field>
                <div>
                  <Button>{t("Save new version")}</Button>
                </div>
              </form>
            </Panel>
          )}
          <ContentImages
            assetId={asset.id}
            images={data.images}
            canEdit={can("content:write")}
            editorId={v && can("content:write") ? "draft-body" : null}
            back={`${back}#images`}
          />
        </div>

        <div className="contents xl:flex xl:flex-col xl:gap-6">
          <Panel
            title={t("Decision")}
            eyebrow={t("Workflow")}
            className="order-first xl:order-none"
          >
            <div className="flex flex-col gap-3">
              {live && (
                <p className="text-xs text-ok">
                  {asset.status === "PUBLISHED"
                    ? t("✓ Version {n} is live (published {date}).", {
                        n: live.version,
                        date:
                          asset.publishedAt?.toISOString().slice(0, 10) ?? "",
                      })
                    : t(
                        "✓ Version {n} stays live. Version {m} needs approval and publication to replace it.",
                        { n: live.version, m: v?.version ?? live.version },
                      )}
                </p>
              )}
              {approved &&
                asset.status !== "APPROVED" &&
                asset.status !== "PUBLISHED" &&
                approved.id !== live?.id && (
                  <p className="text-xs text-muted">
                    {t(
                      "Version {n} was approved; edits since then need a new approval.",
                      { n: approved.version },
                    )}
                  </p>
                )}
              {data.source && (
                <p className="text-xs text-chrome">
                  {t("Repurposed from")}{" "}
                  <Link
                    href={`/content/${data.source.id}`}
                    className="underline hover:text-platinum"
                  >
                    {data.source.title}
                  </Link>{" "}
                  {data.sourceVersion && (
                    <span className="num">v{data.sourceVersion.version}</span>
                  )}
                </p>
              )}
              {asset.sourceStaleAt && (
                <p className="text-xs text-warn">
                  {t(
                    "◐ Stale: the source published a newer version. Regenerate or review this derivative.",
                  )}
                </p>
              )}
              {can("content:write") && (
                <form
                  action={generateContentAction}
                  className="flex flex-wrap items-center gap-2"
                >
                  <HiddenBack path={back} />
                  <input type="hidden" name="assetId" value={asset.id} />
                  <Button variant={v ? "ghost" : "gold"}>
                    {v ? t("Regenerate") : t("Generate draft")}
                  </Button>
                  <label className="flex items-center gap-1.5 text-xs text-chrome">
                    <input type="checkbox" name="useLlm" /> {t("LLM polish")}
                  </label>
                </form>
              )}
              {can("content:approve") && asset.status === "HUMAN_APPROVAL" && (
                <form
                  action={approveContentAction}
                  className="flex flex-col gap-2"
                >
                  <HiddenBack path={back} />
                  <input type="hidden" name="assetId" value={asset.id} />
                  {counts.HIGH > 0 && (
                    <p className="text-xs text-crit">
                      {t("✕ {n} high-severity claim(s) block approval.", {
                        n: counts.HIGH,
                      })}
                    </p>
                  )}
                  {quality && !quality.passed && (
                    <p className="text-xs text-crit">
                      {t("✕ The quality gate fails: see the quality checks.")}
                    </p>
                  )}
                  {distinctApprover && authoredByMe && (
                    <p className="text-xs text-warn">
                      {t(
                        "◐ Another member must approve: you wrote this version.",
                      )}
                    </p>
                  )}
                  {counts.MEDIUM > 0 && (
                    <label className="flex items-start gap-2 text-xs text-chrome">
                      <input
                        type="checkbox"
                        name="acknowledge"
                        className="mt-0.5"
                      />{" "}
                      {t(
                        "I have reviewed the {n} claim(s) that need acknowledgment.",
                        { n: counts.MEDIUM },
                      )}
                    </label>
                  )}
                  <div>
                    <Button variant="gold">{t("Approve")}</Button>
                  </div>
                </form>
              )}
              {can("content:approve") && asset.status === "APPROVED" && (
                <form action={publishContentAction}>
                  <HiddenBack path={back} />
                  <input type="hidden" name="assetId" value={asset.id} />
                  <Button variant="gold">
                    {live
                      ? t("Publish version {n}", {
                          n: approved?.version ?? v?.version ?? 0,
                        })
                      : t("Publish")}
                  </Button>
                </form>
              )}
              {can("content:approve") &&
                !["REJECTED", "IDEA", "PUBLISHED"].includes(asset.status) && (
                  <form action={rejectContentAction} className="flex gap-2">
                    <HiddenBack path={back} />
                    <input type="hidden" name="assetId" value={asset.id} />
                    <input
                      name="reason"
                      placeholder={t("Reason")}
                      required
                      minLength={3}
                      aria-label={t("Rejection reason")}
                    />
                    <Button variant="danger">{t("Reject")}</Button>
                  </form>
                )}
              {asset.status === "FACT_CHECK" && (
                <p className="text-xs text-warn">
                  {t(
                    "◐ Blocked at fact check: fix or remove unsupported claims (or add the missing facts to the knowledge graph), then save a new version.",
                  )}
                </p>
              )}
              {asset.status === "SEO_CHECK" && (
                <p className="text-xs text-warn">
                  {t("◐ Blocked at SEO/GEO check: see failing rules below.")}
                </p>
              )}
            </div>
          </Panel>

          {v?.factCheck && (
            <Panel
              title={
                counts.HIGH + counts.MEDIUM === 0
                  ? t("✓ All claims supported")
                  : t("{high} blocking, {medium} to acknowledge", {
                      high: counts.HIGH,
                      medium: counts.MEDIUM,
                    })
              }
              eyebrow={t("Fact check")}
              pad={false}
            >
              {claims.length === 0 ? (
                <p className="p-4 text-xs text-muted">
                  {t("No factual claims found.")}
                </p>
              ) : (
                <>
                  <ul className="divide-y divide-line md:hidden">
                    {claims.slice(0, 60).map((c, i) => (
                      <li key={i} className="flex flex-col gap-1.5 p-3">
                        <div className="flex flex-wrap gap-1">
                          <Badge tone={severityTone(claimSeverity(c))}>
                            {enumLabel(t, claimSeverity(c))}
                          </Badge>
                          <Badge tone={statusTone(c.status)}>
                            {enumLabel(t, c.status)}
                          </Badge>
                          {c.kind && (
                            <Badge tone="muted">{enumLabel(t, c.kind)}</Badge>
                          )}
                        </div>
                        <div className="text-xs text-platinum">{c.claim}</div>
                        {(c.reason ?? c.sourceUrl) && (
                          <div className="num break-all text-[10px] text-muted">
                            {t(c.reason ?? c.sourceUrl ?? "")}
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                  <div className="hidden md:block">
                    <Table>
                      <tbody>
                        {claims.slice(0, 60).map((c, i) => (
                          <tr key={i}>
                            <Td className="w-28">
                              <div className="flex flex-col items-start gap-1">
                                <Badge tone={severityTone(claimSeverity(c))}>
                                  {enumLabel(t, claimSeverity(c))}
                                </Badge>
                                <Badge tone={statusTone(c.status)}>
                                  {enumLabel(t, c.status)}
                                </Badge>
                              </div>
                            </Td>
                            <Td className="text-xs">
                              {c.kind && (
                                <span className="mr-1.5 font-mono text-[10px] uppercase text-muted">
                                  {enumLabel(t, c.kind)}
                                </span>
                              )}
                              {c.claim}
                              {(c.reason ?? c.sourceUrl) && (
                                <div className="num mt-0.5 truncate text-[10px] text-muted">
                                  {t(c.reason ?? c.sourceUrl ?? "")}
                                </div>
                              )}
                            </Td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                  </div>
                </>
              )}
            </Panel>
          )}

          {quality && (
            <Panel
              title={
                quality.passed
                  ? t("✓ Quality gate passes")
                  : t("Quality gate fails")
              }
              eyebrow={t("Quality")}
              pad={false}
            >
              <ul className="divide-y divide-line">
                {quality.checks.map((c) => (
                  <li
                    key={c.rule}
                    className="flex items-start gap-2 p-3 text-xs"
                  >
                    <span className={c.ok ? "text-ok" : "text-crit"}>
                      {c.ok ? "✓" : "✕"}
                    </span>
                    <span className="flex flex-col gap-0.5">
                      <span className="num text-[10px] uppercase text-muted">
                        {c.rule}
                      </span>
                      <span>{t(c.message)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          {v?.seoCheck && (
            <Panel
              title={
                v.seoCheck.passed
                  ? t("✓ SEO/GEO checks pass")
                  : t("SEO/GEO checks")
              }
              eyebrow={t("On-page")}
              pad={false}
            >
              <ul className="divide-y divide-line md:hidden">
                {v.seoCheck.checks.map((c) => (
                  <li
                    key={c.rule}
                    className="flex items-start gap-2 p-3 text-xs"
                  >
                    <span className={c.ok ? "text-ok" : "text-crit"}>
                      {c.ok ? "✓" : "✕"}
                    </span>
                    <span className="flex flex-col gap-0.5">
                      <span className="num text-[10px] uppercase text-muted">
                        {c.rule}
                      </span>
                      <span>{t(c.message)}</span>
                    </span>
                  </li>
                ))}
              </ul>
              <div className="hidden md:block">
                <Table>
                  <tbody>
                    {v.seoCheck.checks.map((c) => (
                      <tr key={c.rule}>
                        <Td className={c.ok ? "text-ok" : "text-crit"}>
                          {c.ok ? "✓" : "✕"}
                        </Td>
                        <Td className="num text-xs">{c.rule}</Td>
                        <Td className="text-xs">{t(c.message)}</Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </Panel>
          )}

          {(canRepurpose || data.derivatives.length > 0) && (
            <Panel title={t("Repurpose")} eyebrow={t("Derivatives")}>
              <div className="flex flex-col gap-3">
                {canRepurpose && can("content:write") && (
                  <form
                    action={repurposeContentAction}
                    className="flex flex-col gap-2"
                  >
                    <HiddenBack path={back} />
                    <input type="hidden" name="assetId" value={asset.id} />
                    <p className="text-xs text-muted">
                      {t(
                        "Derivatives use only the facts of the approved or published version, are fact checked again and each need their own approval.",
                      )}
                    </p>
                    <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                      {REPURPOSE_TYPES.map((ty) => (
                        <label
                          key={ty}
                          className="flex items-center gap-2 text-xs text-chrome"
                        >
                          <input type="checkbox" name="types[]" value={ty} />{" "}
                          {t(REPURPOSE_LABELS[ty])}
                        </label>
                      ))}
                    </div>
                    <div>
                      <Button>{t("Repurpose")}</Button>
                    </div>
                  </form>
                )}
                {data.derivatives.length > 0 && (
                  <ul className="divide-y divide-line border-t border-line">
                    {data.derivatives.map((d) => (
                      <li
                        key={d.id}
                        className="flex flex-wrap items-center gap-2 py-2 text-xs"
                      >
                        <Link
                          href={`/content/${d.id}`}
                          className="min-w-0 flex-1 truncate text-platinum hover:underline"
                        >
                          {d.title}
                        </Link>
                        <Badge tone="muted">{enumLabel(t, d.status)}</Badge>
                        {d.stale && <Badge tone="warn">{t("Stale")}</Badge>}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Panel>
          )}

          <Panel title={t("Provenance")} eyebrow={t("AI / engine output")}>
            <KV
              items={[
                [
                  t("Generated by"),
                  data.run
                    ? `${data.run.provider}:${data.run.model}`
                    : v
                      ? t("Human edit")
                      : null,
                ],
                [t("Prompt / rules version"), data.run?.promptVersion ?? null],
                [
                  t("Timestamp"),
                  v?.createdAt.toISOString().slice(0, 19).replace("T", " ") ??
                    null,
                ],
                [t("Fact references"), v ? String(v.factRefs.length) : null],
              ]}
            />
          </Panel>

          {page && live && data.perf && (
            <Panel
              title={t("Performance · 28 days")}
              eyebrow={t("Measurement")}
            >
              <KV
                items={[
                  [t("Views"), data.perf.views],
                  [t("CTA clicks"), data.perf.cta],
                  [t("Signups"), data.perf.signups],
                ]}
              />
            </Panel>
          )}

          {v && v.structuredData.length > 0 && (
            <Panel
              title={t("{n} JSON-LD block(s)", { n: v.structuredData.length })}
              eyebrow={t("Structured data")}
            >
              <pre className="max-h-72 overflow-auto text-[10.5px] text-chrome">
                {v.structuredData.map((d) => serializeJsonLd(d)).join("\n\n")}
              </pre>
            </Panel>
          )}

          <Panel title={t("Versions")} eyebrow={t("History")} pad={false}>
            <ul className="divide-y divide-line md:hidden">
              {versions.map((x) => (
                <li
                  key={x.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3 text-xs"
                >
                  <span className="num text-platinum">v{x.version}</span>
                  <span className="num text-muted">
                    {x.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                  </span>
                  {x.id === asset.publishedVersionId && (
                    <Badge tone="ok">{t("Live||version")}</Badge>
                  )}
                  {x.id === asset.approvedVersionId && (
                    <Badge tone="gold">{t("Approved||version")}</Badge>
                  )}
                  <span>
                    {t("Fact")}{" "}
                    {x.factCheck ? (x.factCheck.passed ? "✓" : "✕") : t("n/a")}{" "}
                    · SEO{" "}
                    {x.seoCheck ? (x.seoCheck.passed ? "✓" : "✕") : t("n/a")} ·{" "}
                    {t("Quality")}{" "}
                    {x.qualityCheck
                      ? x.qualityCheck.passed
                        ? "✓"
                        : "✕"
                      : t("n/a")}
                  </span>
                </li>
              ))}
            </ul>
            <div className="hidden md:block">
              <Table>
                <thead>
                  <tr>
                    <Th>v</Th>
                    <Th>{t("Created")}</Th>
                    <Th>{t("Fact")}</Th>
                    <Th>SEO</Th>
                    <Th>{t("Quality")}</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {versions.map((x) => (
                    <tr key={x.id}>
                      <Td className="num">{x.version}</Td>
                      <Td className="num text-xs">
                        {x.createdAt
                          .toISOString()
                          .slice(0, 16)
                          .replace("T", " ")}
                      </Td>
                      <Td>
                        {x.factCheck
                          ? x.factCheck.passed
                            ? "✓"
                            : "✕"
                          : t("n/a")}
                      </Td>
                      <Td>
                        {x.seoCheck
                          ? x.seoCheck.passed
                            ? "✓"
                            : "✕"
                          : t("n/a")}
                      </Td>
                      <Td>
                        {x.qualityCheck
                          ? x.qualityCheck.passed
                            ? "✓"
                            : "✕"
                          : t("n/a")}
                      </Td>
                      <Td>
                        {x.id === asset.publishedVersionId && (
                          <Badge tone="ok">{t("Live||version")}</Badge>
                        )}{" "}
                        {x.id === asset.approvedVersionId && (
                          <Badge tone="gold">{t("Approved||version")}</Badge>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </div>
          </Panel>
        </div>
      </div>
    </>
  );
}
