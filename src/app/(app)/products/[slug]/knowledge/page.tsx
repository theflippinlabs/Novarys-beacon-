import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";
import { eq } from "drizzle-orm";
import { addChangelogAction, addComparisonFactAction, addFaqAction, addProofAction, deleteKnowledgeAction, markProductVerifiedAction, removeComparisonFactAction, setSourceAction, setVerificationAction } from "@/app/actions/products";
import { answerFaqAction, checkSourcesAction, refreshProvenanceAction, setStaleAfterDaysAction, suggestFaqsAction } from "@/app/actions/knowledge";
import { Badge, Button, Field, Flash, HiddenBack, KV, PageHeader, Panel, Table, Td, Th } from "@/components/ui";
import { ProductTabs } from "@/components/shell/product-tabs";
import { memberships, users } from "@/db/schema";
import { computeCompleteness, SECTION_WEIGHTS, SECTION_LABELS, type SectionKey } from "@/core/knowledge/completeness";
import { computeConfidence, DEFAULT_STALE_AFTER_DAYS, FAILING_AFTER_CHECKS, isFailingSource, type Verification } from "@/core/knowledge/confidence";
import { loadProductGraph } from "@/core/knowledge/load";
import { CLAIM_FIELDS, CLAIM_LABELS, claimValue } from "@/core/knowledge/provenance";
import { claimVerification, currentClaim, FACET_LABELS, type FacetKind, type Source } from "@/core/knowledge/types";
import type { FactKind } from "@/services/provenance";
import { enumLabel, type T } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";
import { pageData, productOr404, type SP } from "@/lib/page";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Knowledge graph") };
}

function formatMoney(cents: number, currency: string, intl: string) {
  return new Intl.NumberFormat(intl, { style: "currency", currency, maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
}

const BADGE: Record<Verification, { label: string; tone: "ok" | "muted" | "warn" | "crit" }> = {
  VERIFIED: { label: "Verified", tone: "ok" },
  UNVERIFIED: { label: "Unverified", tone: "muted" },
  NEEDS_REVIEW: { label: "Needs review", tone: "warn" },
  OUTDATED: { label: "Outdated", tone: "warn" },
  CONFLICTING: { label: "Conflicting", tone: "crit" },
  REJECTED: { label: "Rejected", tone: "crit" },
};

function ClaimBadge({ status, t }: { status: Verification; t: T }) {
  const b = BADGE[status];
  return <Badge tone={b.tone}>{t(b.label)}</Badge>;
}

/** One fact with its provenance, rendered as a table row (md and up) and a card (below md). */
type Row = {
  key: string;
  kind: FactKind;
  id: string;
  title: string;
  body?: ReactNode;
  badges?: ReactNode;
  verification: Verification;
  sourceId: string | null;
  verifiedAt: Date | null;
  verifiedBy: string | null;
  confidence: number;
  deletable?: boolean;
  /** Extra controls (e.g. the answer form of a suggested FAQ). */
  extra?: ReactNode;
};

type RowCtx = { t: T; back: string; sources: Source[]; names: Map<string, string>; canWrite: boolean; canVerify: boolean; intl: string };

function Provenance({ r, ctx }: { r: Row; ctx: RowCtx }) {
  const { t } = ctx;
  const src = r.sourceId ? ctx.sources.find((s) => s.id === r.sourceId) : undefined;
  return (
    <div className="flex flex-col gap-1 text-[11px] text-muted">
      <div className="flex flex-wrap items-center gap-1.5">
        <ClaimBadge status={r.verification} t={t} />
        <span className="num" title={t("Confidence = status × source × age (see the formula above)")}>
          {t("Confidence {pct}%", { pct: Math.round(r.confidence * 100) })}
        </span>
      </div>
      {r.verifiedAt && (
        <span>
          {t("Verified {date} by {name}", { date: r.verifiedAt.toISOString().slice(0, 10), name: (r.verifiedBy && ctx.names.get(r.verifiedBy)) || t("unknown reviewer") })}
        </span>
      )}
      {r.verification === "VERIFIED" && !r.verifiedAt && <span>{t("Verified (date not recorded: legacy data)")}</span>}
      {src ? (
        <a href={src.url} target="_blank" rel="noreferrer noopener" className="truncate text-chrome underline-offset-4 hover:underline">
          {t("Source: {title}", { title: src.title })}
          {isFailingSource(src) ? ` (${t("failing")})` : ""}
        </a>
      ) : (
        <span className="text-warn">{t("No source")}</span>
      )}
      {r.verification === "CONFLICTING" && <span className="text-crit">{t("Another source states a different value: reject the wrong claim to resolve the conflict.")}</span>}
    </div>
  );
}

function SourceOptions({ sources, t }: { sources: Source[]; t: T }) {
  return (
    <>
      <option value="">{t("No source")}</option>
      {sources.map((s) => (
        <option key={s.id} value={s.id}>
          {s.title}
        </option>
      ))}
    </>
  );
}

function Controls({ r, ctx }: { r: Row; ctx: RowCtx }) {
  const { t } = ctx;
  return (
    <div className="flex flex-col gap-1.5">
      {ctx.canVerify && (
        <form action={setVerificationAction} className="flex flex-wrap items-center gap-1.5">
          <HiddenBack path={ctx.back} />
          <input type="hidden" name="kind" value={r.kind} />
          <input type="hidden" name="id" value={r.id} />
          <select name="sourceId" defaultValue={r.sourceId ?? ""} className="!w-40 !py-0.5 !text-[11px]" aria-label={t("Source checked")}>
            <SourceOptions sources={ctx.sources} t={t} />
          </select>
          {r.verification !== "VERIFIED" && (
            <button name="verification" value="VERIFIED" className="eyebrow text-ok hover:underline" title={t("Mark as verified by a human (requires a source)")}>
              {t("verify")}
            </button>
          )}
          {r.verification !== "REJECTED" && (
            <button name="verification" value="REJECTED" className="eyebrow text-crit hover:underline" title={t("Reject (never used in generated content)")}>
              {t("reject")}
            </button>
          )}
        </form>
      )}
      {ctx.canWrite && !ctx.canVerify && (
        <form action={setSourceAction} className="flex items-center gap-1">
          <HiddenBack path={ctx.back} />
          <input type="hidden" name="kind" value={r.kind} />
          <input type="hidden" name="id" value={r.id} />
          <select name="sourceId" defaultValue={r.sourceId ?? ""} className="!w-40 !py-0.5 !text-[11px]" aria-label={t("Source")}>
            <SourceOptions sources={ctx.sources} t={t} />
          </select>
          <button className="eyebrow hover:text-chrome">{t("link")}</button>
        </form>
      )}
      {ctx.canWrite && r.deletable !== false && (
        <form action={deleteKnowledgeAction}>
          <HiddenBack path={ctx.back} />
          <input type="hidden" name="kind" value={r.kind} />
          <input type="hidden" name="id" value={r.id} />
          <button className="eyebrow hover:text-crit" title={t("Delete")}>
            {t("delete")}
          </button>
        </form>
      )}
    </div>
  );
}

function FactRows({ rows, ctx, empty }: { rows: Row[]; ctx: RowCtx; empty: string }) {
  const { t } = ctx;
  if (!rows.length) return <p className="p-4 text-sm text-muted">{empty}</p>;
  return (
    <>
      <div className="hidden md:block">
        <Table>
          <thead>
            <tr>
              <Th>{t("Fact")}</Th>
              <Th>{t("Details")}</Th>
              <Th>{t("Status & provenance")}</Th>
              {(ctx.canWrite || ctx.canVerify) && <Th>{t("Actions")}</Th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} id={`fact-${r.id}`}>
                <Td className="max-w-[14rem] text-platinum">
                  {r.title} {r.badges}
                </Td>
                <Td className="max-w-xl text-xs">
                  {r.body}
                  {r.extra}
                </Td>
                <Td className="min-w-[12rem]">
                  <Provenance r={r} ctx={ctx} />
                </Td>
                {(ctx.canWrite || ctx.canVerify) && (
                  <Td>
                    <Controls r={r} ctx={ctx} />
                  </Td>
                )}
              </tr>
            ))}
          </tbody>
        </Table>
      </div>
      <ul className="flex flex-col divide-y divide-line md:hidden">
        {rows.map((r) => (
          <li key={r.key} className="flex flex-col gap-2 p-4">
            <div className="text-sm text-platinum">
              {r.title} {r.badges}
            </div>
            {r.body && <div className="text-xs text-chrome">{r.body}</div>}
            {r.extra}
            <Provenance r={r} ctx={ctx} />
            {(ctx.canWrite || ctx.canVerify) && <Controls r={r} ctx={ctx} />}
          </li>
        ))}
      </ul>
    </>
  );
}

export default async function KnowledgePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SP> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { t, intl, locale } = await getI18n();
  /** Enum label: translated in French, raw value in English (unchanged output). */
  const lbl = (v: string) => (locale === "fr" ? enumLabel(t, v) : v);
  const { data, can, ctx: auth } = await pageData(async (tx, ctx) => {
    const p = await productOr404(tx, ctx.org.id, slug);
    const g = (await loadProductGraph(tx, ctx.org.id, p.id))!;
    const members = await tx.select({ id: users.id, name: users.name }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.organizationId, ctx.org.id));
    return { g, members };
  });
  const g = data.g;
  const p = g.product;
  const back = `/products/${p.slug}/knowledge`;
  const editable = can("product:write");
  const canVerify = can("fact:verify");
  const staleDays = auth.org.settings.knowledge?.staleAfterDays ?? DEFAULT_STALE_AFTER_DAYS;
  const now = new Date();
  const completeness = computeCompleteness(g);
  const kinds: FacetKind[] = ["AUDIENCE", "INDUSTRY", "PROBLEM", "FEATURE", "USE_CASE", "INTEGRATION", "DIFFERENTIATOR"];
  const rowCtx: RowCtx = { t, back, sources: g.sources, names: new Map(data.members.map((m) => [m.id, m.name])), canWrite: editable, canVerify, intl };
  const conf = (x: { verification: Verification; sourceId: string | null; verifiedAt: Date | null; confidence: number | null }) => {
    if (x.confidence !== null) return x.confidence;
    const s = x.sourceId ? g.sources.find((y) => y.id === x.sourceId) : undefined;
    return computeConfidence({ verification: x.verification, source: s ? { kind: s.kind, failing: isFailingSource(s) } : null, verifiedAt: x.verifiedAt, now, staleAfterDays: staleDays });
  };
  const prov = (x: { id: string; verification: Verification; sourceId: string | null; verifiedAt: Date | null; verifiedBy: string | null; confidence: number | null }) => ({
    id: x.id,
    verification: x.verification,
    sourceId: x.sourceId,
    verifiedAt: x.verifiedAt,
    verifiedBy: x.verifiedBy,
    confidence: conf(x),
  });

  // Scalar claims: one row per filled field (the claim backing its current value).
  const fieldText = (v: string | null, field: (typeof CLAIM_FIELDS)[number]) => {
    if (v === null) return null;
    if (field === "api_available" || field === "free_trial") return v === "true" ? t("Yes") : t("No");
    if (field === "status") return lbl(v);
    return v;
  };
  const claimRows: Row[] = [];
  const legacy = !g.claims?.length;
  for (const field of CLAIM_FIELDS) {
    const value = claimValue(p, field);
    if (value === null) continue;
    const c = currentClaim(g, field);
    if (c)
      claimRows.push({ key: c.id, kind: "claim", ...prov(c), title: t(CLAIM_LABELS[field]), body: <span className="whitespace-pre-line">{fieldText(value, field)}</span>, deletable: false });
    else if (legacy)
      claimRows.push({
        key: `legacy-${field}`,
        kind: "claim",
        id: `legacy-${field}`,
        title: t(CLAIM_LABELS[field]),
        body: <span className="whitespace-pre-line">{fieldText(value, field)}</span>,
        verification: claimVerification(g, field),
        sourceId: null,
        verifiedAt: p.lastVerifiedAt,
        verifiedBy: null,
        confidence: computeConfidence({ verification: claimVerification(g, field), source: null, verifiedAt: p.lastVerifiedAt, now, staleAfterDays: staleDays }),
        deletable: false,
      });
  }
  const changelogRows: Row[] = g.changelog.map((c) => ({
    key: c.id,
    kind: "changelog",
    ...prov(c),
    title: c.title,
    badges: c.version ? <Badge>{c.version}</Badge> : undefined,
    body: (
      <>
        <span className="num text-muted">{c.releasedOn}</span> {c.body}
      </>
    ),
  }));
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  const failing = g.sources.filter(isFailingSource);

  return (
    <>
      <PageHeader eyebrow={t("Knowledge graph · {name}", { name: p.name })} title={t("Facts, sources & verification")} description={t("Only verified facts carry full confidence in generated content and structured data. Rejected facts are never used. Unknown fields are listed explicitly.")} />
      <ProductTabs slug={p.slug} active="knowledge" />
      <Flash searchParams={sp} />

      <Panel title={t("{pct}% complete", { pct: Math.round(completeness.score * 100) })} eyebrow={t("Entity completeness")}>
        <p className="text-sm text-chrome">{completeness.sections.map((s) => t("{section}: {value}", { section: t(s.label), value: pct(s.pct) })).join(", ")}</p>
        <p className="mt-2 text-xs text-muted">
          {t("Overall = weighted average of the sections ({weights}). Verified facts count fully, unverified facts count half, outdated and conflicting facts count zero.", {
            weights: (Object.keys(SECTION_WEIGHTS) as SectionKey[]).map((k) => `${t(SECTION_LABELS[k])} ${SECTION_WEIGHTS[k]}`).join(", "),
          })}
        </p>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {completeness.sections.map((s) => (
            <div key={s.key} className="border border-line p-3">
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm text-platinum">{t(s.label)}</span>
                <span className="num text-sm text-platinum">{pct(s.pct)}</span>
              </div>
              <div className="num text-[11px] text-muted">
                {t("{earned} of {max} points · weight {weight}", { earned: (Math.round(s.earned * 10) / 10).toString(), max: s.max, weight: s.weight })}
                {" · "}
                {s.verifiedRatio === null ? t("no facts yet") : t("{pct}% of facts verified", { pct: Math.round(s.verifiedRatio * 100) })}
              </div>
              <ul className="mt-2 flex flex-col gap-1">
                {s.items.map((m) => (
                  <li key={m.key} className="text-xs">
                    <span className={m.status === "complete" ? "text-ok" : m.status === "missing" ? "text-crit" : "text-warn"}>{m.status === "complete" ? "✓" : m.status === "missing" ? "✕" : "◐"}</span>{" "}
                    <span className="text-chrome">{t(m.label)}</span>{" "}
                    {m.verified === true ? <Badge tone="ok">{t("Verified")}</Badge> : m.verified === false && m.facts > 0 ? <span className="text-muted">{t("{n}/{total} verified", { n: m.verifiedFacts, total: m.facts })}</span> : null}
                    {m.status !== "complete" && <div className="text-[11px] text-muted">{t(m.hint)}</div>}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </Panel>

      <Panel
        title={t("Core identity")}
        eyebrow={t("Per-field claims")}
        className="mt-6"
        pad={false}
        actions={
          <Link className="eyebrow hover:text-chrome" href={`/products/${p.slug}/onboarding?step=1`}>
            {t("Edit in onboarding →")}
          </Link>
        }
      >
        <div className="border-b border-line p-4">
          <KV
            items={[
              [t("Conversion URLs"), p.conversionUrls.map((c) => c.label).join(", ") || null],
              [t("Last verified"), p.lastVerifiedAt?.toISOString().slice(0, 10) ?? t("Never (descriptions carry reduced confidence)")],
            ]}
          />
          {canVerify && claimRows.length > 0 && (
            <form action={markProductVerifiedAction} className="mt-4 flex flex-wrap items-end gap-3">
              <HiddenBack path={back} />
              <input type="hidden" name="productId" value={p.id} />
              <Field label={t("Source checked")} hint={t("Used for core facts that have no source yet.")}>
                <select name="sourceId" defaultValue="">
                  <SourceOptions sources={g.sources} t={t} />
                </select>
              </Field>
              <Button>{t("I verified the core descriptions")}</Button>
            </form>
          )}
          {legacy && claimRows.length > 0 && <p className="mt-3 text-xs text-muted">{t("These fields predate per-field verification. Saving the product or verifying the core descriptions creates one claim per field.")}</p>}
        </div>
        <FactRows rows={legacy ? claimRows.map((r) => ({ ...r })) : claimRows} ctx={legacy ? { ...rowCtx, canVerify: false, canWrite: false } : rowCtx} empty={t("No core facts recorded yet.")} />
      </Panel>

      <Panel title={t("Canonical sources")} eyebrow={t("Proof / sources")} className="mt-6" actions={<Link className="eyebrow hover:text-chrome" href={`/products/${p.slug}/onboarding?step=11`}>{t("Edit →")}</Link>}>
        {g.sources.length ? (
          <ul className="grid gap-2 md:grid-cols-2">
            {g.sources.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 text-sm">
                <Badge>{lbl(s.kind)}</Badge>
                <a href={s.url} target="_blank" rel="noreferrer noopener" className="min-w-0 truncate text-chrome underline-offset-4 hover:underline">
                  {s.title}
                </a>
                {s.lastCheckedAt ? (
                  isFailingSource(s) ? (
                    <Badge tone="crit">{t("Failing ({status})", { status: s.httpStatus ?? t("unreachable") })}</Badge>
                  ) : s.consecutiveFailures > 0 ? (
                    <Badge tone="warn">{t("Check failed once ({status})", { status: s.httpStatus ?? t("unreachable") })}</Badge>
                  ) : (
                    <Badge tone="ok">{t("Reachable ({status})", { status: s.httpStatus ?? "" })}</Badge>
                  )
                ) : (
                  <Badge tone="muted">{t("Not checked yet")}</Badge>
                )}
                {s.lastCheckedAt && <span className="num text-[11px] text-muted">{t("checked {date}", { date: s.lastCheckedAt.toISOString().slice(0, 10) })}</span>}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">{t("No sources. Every public claim should trace back to a canonical URL.")}</p>
        )}
        <div className="mt-4 flex flex-col gap-3 border-t border-line pt-4 text-xs text-muted">
          <p>
            {t("Sources are checked weekly. A source failing {n} checks in a row, or a fact verified more than {days} days ago, marks the facts it supports as outdated. Two sources that disagree mark the claims as conflicting.", { n: FAILING_AFTER_CHECKS, days: staleDays })}
            {failing.length > 0 && ` ${t("{n} source(s) currently failing.", { n: failing.length })}`}
          </p>
          <p>{t("Confidence = status (verified 1, needs review 0.5, unverified 0.4, outdated 0.2, conflicting 0.1) × source (none 0.5, pricing, docs, changelog or legal page 1, website or repository 0.9, case study or press 0.8, other 0.7, halved when failing) × age (verified facts: 1 for 30 days, then down to 0.5 at the outdated threshold).")}</p>
          <div className="flex flex-wrap items-end gap-3">
            {can("job:run") && (
              <form action={checkSourcesAction}>
                <HiddenBack path={back} />
                <Button>{t("Check sources now")}</Button>
              </form>
            )}
            {editable && (
              <form action={refreshProvenanceAction}>
                <HiddenBack path={back} />
                <input type="hidden" name="productId" value={p.id} />
                <Button>{t("Recompute provenance")}</Button>
              </form>
            )}
            {can("settings:manage") && (
              <form action={setStaleAfterDaysAction} className="flex items-end gap-2">
                <HiddenBack path={back} />
                <Field label={t("Outdated after (days)")}>
                  <input type="number" name="days" min={7} max={3650} defaultValue={staleDays} className="!w-24" />
                </Field>
                <Button>{t("Save")}</Button>
              </form>
            )}
          </div>
        </div>
      </Panel>

      {kinds.map((kind) => {
        const list = g.facets.filter((f) => f.kind === kind);
        return (
          <Panel key={kind} title={t(FACET_LABELS[kind].plural)} eyebrow={t("{n} item(s)", { n: list.length })} className="mt-6" pad={false}>
            <FactRows
              rows={list.map((f) => ({ key: f.id, kind: "facet" as const, ...prov(f), title: f.name, body: f.description ?? <span className="text-muted">{t("No description")}</span> }))}
              ctx={rowCtx}
              empty={t("Unknown: none recorded.")}
            />
          </Panel>
        );
      })}

      <Panel title={t("Pricing")} eyebrow={t("Plans")} className="mt-6" pad={false}>
        <FactRows
          rows={g.pricing.map((x) => ({
            key: x.id,
            kind: "pricing" as const,
            ...prov(x),
            title: x.planName,
            body: (
              <span className="num">
                {x.priceCents === null ? <span className="text-muted">{t("not public")}</span> : x.currency ? formatMoney(x.priceCents, x.currency, intl) : `${(x.priceCents / 100).toFixed(2)} (${t("currency unknown")})`}
                {" / "}
                {x.interval ? lbl(x.interval).toLocaleLowerCase(intl) : <span className="text-warn">{t("billing interval unknown")}</span>}
                {x.trialDays ? ` · ${t("{n} days", { n: x.trialDays })}` : ""}
                {x.description ? <span className="block text-muted">{x.description}</span> : null}
              </span>
            ),
          }))}
          ctx={rowCtx}
          empty={t("Pricing unknown.")}
        />
      </Panel>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Panel
          title={t("FAQ")}
          eyebrow={t("{n} entries", { n: g.faqs.length })}
          pad={false}
          actions={
            editable && (
              <form action={suggestFaqsAction}>
                <HiddenBack path={back} />
                <input type="hidden" name="productId" value={p.id} />
                <Button>{t("Suggest FAQ questions")}</Button>
              </form>
            )
          }
        >
          <p className="border-b border-line px-4 py-2 text-[11px] text-muted">{t("Suggestions come from high-importance problem and informational queries and active AI prompts. Beacon proposes the question only: a human writes the answer, links a source and verifies it.")}</p>
          <FactRows
            rows={g.faqs.map((f) => ({
              key: f.id,
              kind: "faq" as const,
              ...prov(f),
              title: f.question,
              badges: f.suggestedFrom && f.verification !== "VERIFIED" ? <Badge tone="gold">{t("Suggestion")}</Badge> : undefined,
              body: f.answer.trim() ? f.answer : <span className="text-warn">{t("Answer needed")}</span>,
              extra:
                editable && (!f.answer.trim() || f.suggestedFrom) ? (
                  <details className="mt-2" open={!f.answer.trim()}>
                    <summary className="eyebrow cursor-pointer">{f.answer.trim() ? t("Edit answer") : t("Write the answer")}</summary>
                    <form action={answerFaqAction} className="mt-2 flex flex-col gap-2">
                      <HiddenBack path={back} />
                      <input type="hidden" name="id" value={f.id} />
                      <input name="question" defaultValue={f.question} required minLength={5} maxLength={300} aria-label={t("Question")} />
                      <textarea name="answer" defaultValue={f.answer} required minLength={10} className="min-h-16" aria-label={t("Factual answer")} />
                      <div>
                        <Button>{t("Save answer")}</Button>
                      </div>
                    </form>
                  </details>
                ) : undefined,
            }))}
            ctx={rowCtx}
            empty={t("No FAQ entries yet.")}
          />
          {editable && (
            <form action={addFaqAction} className="flex flex-col gap-3 border-t border-line p-4">
              <HiddenBack path={back} />
              <input type="hidden" name="productId" value={p.id} />
              <Field label={t("Question")}>
                <input name="question" required minLength={5} maxLength={300} />
              </Field>
              <Field label={t("Factual answer")}>
                <textarea name="answer" required minLength={10} className="min-h-20" />
              </Field>
              <Field label={t("Source")}>
                <select name="sourceId" defaultValue="">
                  <SourceOptions sources={g.sources} t={t} />
                </select>
              </Field>
              <div>
                <Button>{t("Add FAQ")}</Button>
              </div>
            </form>
          )}
        </Panel>

        <Panel title={t("Proof")} eyebrow={t("Testimonials · case studies · metrics")} pad={false}>
          <FactRows
            rows={g.proofs.map((pr) => ({
              key: pr.id,
              kind: "proof" as const,
              ...prov(pr),
              title: pr.title,
              badges: (
                <>
                  <Badge>{lbl(pr.kind)}</Badge> {pr.publishable ? <Badge tone="ok">{t("publishable")}</Badge> : <Badge tone="muted">{t("internal only")}</Badge>}
                </>
              ),
              body: (
                <>
                  {pr.content}
                  {pr.attribution && <span className="block text-muted">{t("Attribution: {name}", { name: pr.attribution })}</span>}
                </>
              ),
            }))}
            ctx={rowCtx}
            empty={t("No proof recorded. Beacon never invents customers, testimonials or metrics.")}
          />
          {editable && (
            <form action={addProofAction} className="grid gap-3 border-t border-line p-4 sm:grid-cols-2">
              <HiddenBack path={back} />
              <input type="hidden" name="productId" value={p.id} />
              <Field label={t("Kind")}>
                <select name="kind">
                  {["CASE_STUDY", "TESTIMONIAL", "METRIC", "AWARD", "REVIEW", "CERTIFICATION"].map((k) => (
                    <option key={k} value={k}>
                      {lbl(k)}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("Title")}>
                <input name="title" required maxLength={200} />
              </Field>
              <Field label={t("Content||proof text")} className="sm:col-span-2">
                <textarea name="content" required className="min-h-20" />
              </Field>
              <Field label={t("Attribution")}>
                <input name="attribution" maxLength={200} />
              </Field>
              <Field label={t("Source")}>
                <select name="sourceId" defaultValue="">
                  <SourceOptions sources={g.sources} t={t} />
                </select>
              </Field>
              <label className="flex items-center gap-2 text-xs text-chrome sm:col-span-2">
                <input type="checkbox" name="publishable" /> {t("We have explicit permission to publish this.")}
              </label>
              <div>
                <Button>{t("Add proof")}</Button>
              </div>
            </form>
          )}
        </Panel>
      </div>

      <Panel title={t("Competitors & factual comparisons")} eyebrow={t("Every comparison point needs a source URL")} className="mt-6">
        {g.competitors.length === 0 && <p className="text-sm text-muted">{t("No competitors linked. Add them in onboarding step 9.")}</p>}
        <div className="flex flex-col gap-6">
          {g.competitors.map((c) => (
            <div key={c.competitorId}>
              <div className="mb-2 flex items-center gap-2">
                <span className="text-sm font-medium text-platinum">{c.competitor.name}</span>
                <span className="num text-xs text-muted">{c.competitor.domain}</span>
                <Badge tone={c.comparisonFacts.filter((f) => f.sourceUrl).length >= 3 ? "ok" : "warn"}>{t("{n} / 3 facts", { n: c.comparisonFacts.length })}</Badge>
              </div>
              {c.comparisonFacts.length > 0 && (
                <Table>
                  <thead>
                    <tr>
                      <Th>{t("Dimension")}</Th>
                      <Th>{p.name}</Th>
                      <Th>{c.competitor.name}</Th>
                      <Th>{t("Source")}</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {c.comparisonFacts.map((f, i) => (
                      <tr key={i}>
                        <Td>{f.dimension}</Td>
                        <Td>{f.product}</Td>
                        <Td>{f.competitor}</Td>
                        <Td className="max-w-[16rem] truncate text-xs">
                          <a className="underline-offset-4 hover:underline" href={f.sourceUrl} target="_blank" rel="noreferrer noopener">
                            {f.sourceUrl}
                          </a>{" "}
                          {f.verifiedAt ? <Badge tone="ok">{t("verified")}</Badge> : null}
                        </Td>
                        <Td>
                          {editable && (
                            <form action={removeComparisonFactAction}>
                              <HiddenBack path={back} />
                              <input type="hidden" name="productId" value={p.id} />
                              <input type="hidden" name="competitorId" value={c.competitorId} />
                              <input type="hidden" name="index" value={i} />
                              <button className="eyebrow hover:text-crit">✕</button>
                            </form>
                          )}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              )}
              {editable && (
                <form action={addComparisonFactAction} className="mt-3 grid gap-2 md:grid-cols-[1fr_1fr_1fr_1.4fr_auto_auto]">
                  <HiddenBack path={back} />
                  <input type="hidden" name="productId" value={p.id} />
                  <input type="hidden" name="competitorId" value={c.competitorId} />
                  <input name="dimension" placeholder={t("Dimension (e.g. Starting price)")} required aria-label={t("Dimension")} />
                  <input name="product" placeholder={p.name} required aria-label={t("Product value")} />
                  <input name="competitor" placeholder={c.competitor.name} required aria-label={t("Competitor value")} />
                  <input name="sourceUrl" type="url" placeholder="https://source" required aria-label={t("Source URL")} />
                  {canVerify ? (
                    <label className="flex items-center gap-1 text-xs text-chrome">
                      <input type="checkbox" name="verified" /> {t("verified")}
                    </label>
                  ) : (
                    <span />
                  )}
                  <Button>{t("Add")}</Button>
                </form>
              )}
            </div>
          ))}
        </div>
      </Panel>

      <Panel title={t("Changelog")} eyebrow={t("Releases")} className="mt-6">
        <FactRows rows={changelogRows} ctx={rowCtx} empty={t("No releases recorded.")} />
        {editable && (
          <form action={addChangelogAction} className="mt-4 grid gap-3 md:grid-cols-4">
            <HiddenBack path={back} />
            <input type="hidden" name="productId" value={p.id} />
            <Field label={t("Released on")}>
              <input type="date" name="releasedOn" required />
            </Field>
            <Field label={t("Version")}>
              <input name="version" maxLength={40} />
            </Field>
            <Field label={t("Title")} className="md:col-span-2">
              <input name="title" required maxLength={200} />
            </Field>
            <Field label={t("Notes")} className="md:col-span-3">
              <textarea name="body" className="min-h-16" />
            </Field>
            <Field label={t("Source")}>
              <select name="sourceId" defaultValue="">
                <option value="">{t("No source")}</option>
                {g.sources.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </Field>
            <div>
              <Button>{t("Add release")}</Button>
            </div>
          </form>
        )}
      </Panel>
    </>
  );
}
