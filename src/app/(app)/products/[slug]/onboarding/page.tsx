import Link from "next/link";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { saveOnboardingStepAction, setVerificationAction } from "@/app/actions/products";
import { acceptProposalAction, advanceOnboardingAction, extractWebsiteAction, generateUniverseAction, initialCrawlAction, onboardingAddDomainAction, onboardingVerifyDomainAction, rejectProposalAction } from "@/app/actions/onboarding";
import { bulkQueryAction } from "@/app/actions/discovery";
import { regenerateOpportunitiesAction } from "@/app/actions/growth";
import { recomputeScoreAction } from "@/app/actions/knowledge";
import { ImageUrlField } from "@/components/media/image-url-field";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { Badge, Button, EmptyState, Field, Flash, HiddenBack, LinkButton, Meter, PageHeader, Panel, PotentialBadge, StatusBadge, cx } from "@/components/ui";
import { ContentGaps } from "@/app/(app)/queries/content-gaps";
import { integrations, opportunities, queries, queryClusters, seoAudits } from "@/db/schema";
import { facetLines } from "@/core/knowledge/parse";
import { CLAIM_FIELDS, CLAIM_LABELS } from "@/core/knowledge/provenance";
import { currentClaim, facetsOf, FACET_LABELS } from "@/core/knowledge/types";
import { loadProductGraph } from "@/core/knowledge/load";
import { computeCompleteness } from "@/core/knowledge/completeness";
import { hostCoveredBy, VERIFICATION_FILE_PATH, VERIFICATION_TXT_PREFIX } from "@/core/seo/domains";
import { INFO_PARTS, ONBOARDING_FLOW, onboardingHref, parsePosition, partState, previousPosition, progress, resumeAt, stepIndex, stepState, STEP_SECTION, type StepState } from "@/core/onboarding/steps";
import { stepsOf } from "@/services/onboarding";
import { listProposals } from "@/services/extraction";
import { listDomains } from "@/services/domains";
import { contentGapsForProduct } from "@/services/content-gaps";
import { storedScoreWithDiff } from "@/services/score";
import { domainVerificationBypassed } from "@/services/seo";
import type { FactKind } from "@/services/provenance";
import { pageData, productOr404, sp1, type SP } from "@/lib/page";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Onboarding") };
}

const TEXTAREA = "min-h-40 font-mono text-[13px] leading-relaxed";

const ORIGIN_LABEL: Record<string, string> = {
  title: "Page title",
  meta_description: "Meta description",
  og_description: "Open Graph description",
  h1: "Main heading (H1)",
  heading: "Section heading",
  json_ld: "Structured data (JSON-LD)",
  link: "Link on the page",
};

type VerifyFact = { kind: FactKind; id: string; type: string; text: string; sourceId: string | null; verification: string };

export default async function OnboardingPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SP> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { data, can } = await pageData(async (tx, ctx) => {
    const p = await productOr404(tx, ctx.org.id, slug);
    const g = (await loadProductGraph(tx, ctx.org.id, p.id))!;
    const steps = stepsOf(p);
    const pos = parsePosition(sp1(sp, "step"), sp1(sp, "part")) ?? resumeAt(steps);
    const integ = await tx.select().from(integrations).where(and(eq(integrations.organizationId, ctx.org.id), eq(integrations.productId, p.id)));
    const orgInteg = await tx.select().from(integrations).where(and(eq(integrations.organizationId, ctx.org.id), sql`${integrations.productId} is null`));
    const host = p.domain ? p.domain.replace(/^https?:\/\//, "").split("/")[0] : null;
    const domains = host ? await listDomains(tx, ctx.org.id) : [];
    const domain = host ? (domains.find((d) => d.domain === host) ?? domains.find((d) => d.verifiedAt && hostCoveredBy(host, [d.domain])) ?? null) : null;
    const extra: {
      proposals?: Awaited<ReturnType<typeof listProposals>>;
      accepted?: number;
      audit?: typeof seoAudits.$inferSelect | null;
      clusters?: { id: string; name: string; candidates: { id: string; query: string }[]; active: number }[];
      queryCounts?: { candidate: number; active: number };
      gaps?: Awaited<ReturnType<typeof contentGapsForProduct>>;
      opps?: (typeof opportunities.$inferSelect)[];
      score?: Awaited<ReturnType<typeof storedScoreWithDiff>>;
    } = {};
    if (pos.step === "website") {
      const all = await listProposals(tx, ctx.org.id, p.id);
      extra.proposals = all.filter((x) => x.status === "PROPOSED");
      extra.accepted = all.filter((x) => x.status === "ACCEPTED").length;
    }
    if (pos.step === "crawl") {
      extra.audit = (await tx.select().from(seoAudits).where(and(eq(seoAudits.organizationId, ctx.org.id), eq(seoAudits.productId, p.id))).orderBy(desc(seoAudits.createdAt)).limit(1))[0] ?? null;
    }
    if (pos.step === "queries") {
      const qs = await tx
        .select({ id: queries.id, query: queries.query, status: queries.status, clusterId: queries.clusterId, importance: queries.importance })
        .from(queries)
        .where(and(eq(queries.organizationId, ctx.org.id), eq(queries.productId, p.id), inArray(queries.status, ["CANDIDATE", "ACTIVE"])))
        .orderBy(desc(queries.importance), queries.normalized);
      const cl = await tx.select({ id: queryClusters.id, name: queryClusters.name }).from(queryClusters).where(and(eq(queryClusters.organizationId, ctx.org.id), eq(queryClusters.productId, p.id)));
      const byCluster = new Map<string, { id: string; name: string; candidates: { id: string; query: string }[]; active: number }>();
      for (const q of qs) {
        const key = q.clusterId ?? "none";
        const c = byCluster.get(key) ?? { id: key, name: cl.find((x) => x.id === q.clusterId)?.name ?? "Unclustered", candidates: [], active: 0 };
        if (q.status === "CANDIDATE") c.candidates.push({ id: q.id, query: q.query });
        else c.active++;
        byCluster.set(key, c);
      }
      extra.clusters = [...byCluster.values()].sort((a, b) => b.candidates.length + b.active - (a.candidates.length + a.active)).slice(0, 12);
      extra.queryCounts = { candidate: qs.filter((q) => q.status === "CANDIDATE").length, active: qs.filter((q) => q.status === "ACTIVE").length };
    }
    if (pos.step === "gaps") extra.gaps = (await contentGapsForProduct(tx, ctx.org.id, p.id)).sort((a, b) => b.score - a.score).slice(0, 5);
    if (pos.step === "opportunities")
      extra.opps = await tx.select().from(opportunities).where(and(eq(opportunities.organizationId, ctx.org.id), eq(opportunities.productId, p.id), eq(opportunities.status, "OPEN"))).orderBy(desc(opportunities.priorityScore)).limit(5);
    if (pos.step === "score") extra.score = await storedScoreWithDiff(tx, ctx.org.id, p.id);
    return { g, steps, pos, integ, orgInteg, domain, host, completeness: computeCompleteness(g), ...extra };
  });
  const { t, locale } = await getI18n();
  const { g, steps, pos, integ, orgInteg, domain, host, completeness } = data;
  const p = g.product;
  const here = onboardingHref(p.slug, pos);
  const lines = (kind: Parameters<typeof facetsOf>[1]) => facetLines(facetsOf(g, kind));
  const integration = (provider: string) => integ.find((i) => i.provider === provider) ?? orgInteg.find((i) => i.provider === provider);
  const gsc = integration("GOOGLE_SEARCH_CONSOLE");
  const bing = integration("BING_WEBMASTER");
  const ga = integration("GOOGLE_ANALYTICS");
  const prog = progress(steps);
  const idx = stepIndex(pos.step);
  const flow = ONBOARDING_FLOW[idx];
  const part = pos.step === "info" ? INFO_PARTS.find((x) => x.key === pos.part)! : null;
  const section = part ? part.section : STEP_SECTION[pos.step];
  const prev = previousPosition(pos.step, pos.part);
  const canWrite = can("product:write");
  const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : t("n/a"));
  const stateLabel = (s: StepState) => (s.status === "done" ? t("Done") : s.status === "skipped" ? t("Skipped") : t("Pending"));
  const stateIcon = (s: StepState) => (s.status === "done" ? "✓" : s.status === "skipped" ? "↷" : "○");
  const stateClass = (s: StepState) => (s.status === "done" ? "text-ok" : s.status === "skipped" ? "text-warn" : "text-muted");

  /** Continue / skip buttons of a step without a knowledge form. */
  const advance = (opts: { next?: string; skip?: boolean } = {}) =>
    canWrite && (
      <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
        <form action={advanceOnboardingAction}>
          <HiddenBack path={here} />
          <input type="hidden" name="productId" value={p.id} />
          <input type="hidden" name="flow" value={pos.step} />
          <Button variant="gold" name="intent" value="next">
            {opts.next ?? t("Continue →")}
          </Button>
        </form>
        {opts.skip !== false && pos.step !== "score" && (
          <form action={advanceOnboardingAction}>
            <HiddenBack path={here} />
            <input type="hidden" name="productId" value={p.id} />
            <input type="hidden" name="flow" value={pos.step} />
            <Button name="intent" value="skip">
              {t("Skip this step")}
            </Button>
          </form>
        )}
        {prev && (
          <Link href={onboardingHref(p.slug, prev)} className="eyebrow ml-auto inline-flex min-h-10 items-center hover:text-chrome md:min-h-0">
            {t("← Back")}
          </Link>
        )}
      </div>
    );

  // VERIFY KNOWLEDGE: every fact not yet verified (or rejected), with its source.
  const sourceUrl = (id: string | null) => (id ? (g.sources.find((s) => s.id === id)?.url ?? null) : null);
  const open = (v: string) => v !== "VERIFIED" && v !== "REJECTED";
  const verifyFacts: VerifyFact[] = [
    ...CLAIM_FIELDS.map((f) => ({ f, c: currentClaim(g, f) }))
      .filter((x) => x.c && open(x.c.verification))
      .map(({ f, c }) => ({ kind: "claim" as const, id: c!.id, type: CLAIM_LABELS[f], text: c!.value, sourceId: c!.sourceId, verification: c!.verification })),
    ...g.facets.filter((x) => open(x.verification)).map((x) => ({ kind: "facet" as const, id: x.id, type: FACET_LABELS[x.kind].singular, text: x.description ? `${x.name}: ${x.description}` : x.name, sourceId: x.sourceId, verification: x.verification })),
    ...g.pricing.filter((x) => open(x.verification)).map((x) => ({ kind: "pricing" as const, id: x.id, type: "Pricing plan", text: x.planName, sourceId: x.sourceId, verification: x.verification })),
    ...g.faqs.filter((x) => open(x.verification) && x.answer.trim()).map((x) => ({ kind: "faq" as const, id: x.id, type: "FAQ", text: x.question, sourceId: x.sourceId, verification: x.verification })),
    ...g.proofs.filter((x) => open(x.verification)).map((x) => ({ kind: "proof" as const, id: x.id, type: "Proof", text: x.title, sourceId: x.sourceId, verification: x.verification })),
    ...g.changelog.filter((x) => open(x.verification)).map((x) => ({ kind: "changelog" as const, id: x.id, type: "Changelog", text: x.title, sourceId: x.sourceId, verification: x.verification })),
  ];

  const integrationStatus = (label: string, i: typeof gsc) => (
    <div className="flex flex-col gap-1 border border-line bg-obsidian/40 p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-platinum">{label}</span>
        {i && i.status !== "NOT_CONNECTED" && i.status !== "DISABLED" ? <StatusBadge status={i.status} /> : <Badge tone="muted">{t("Not connected")}</Badge>}
      </div>
      {i && i.status !== "NOT_CONNECTED" && (
        <div className="text-xs text-muted">
          {t("Last successful sync: {date}", { date: day(i.lastSuccessAt) })}
          {i.lastError && <div className="mt-1 break-words text-warn">{t(i.lastError)}</div>}
        </div>
      )}
    </div>
  );

  return (
    <>
      <PageHeader
        eyebrow={t("Onboarding · {name}", { name: p.name })}
        title={`${String(idx + 1).padStart(2, "0")} · ${t(flow.label)}${part ? ` · ${t(part.label)}` : ""}`}
        description={t("Describe the product once. Only enter facts you can stand behind; leave anything unknown blank. Beacon marks it unknown instead of guessing.")}
        actions={
          <Link href={`/products/${p.slug}`} className="eyebrow inline-flex min-h-10 items-center hover:text-chrome md:min-h-0">
            {t("Exit to product →")}
          </Link>
        }
      />
      <Flash searchParams={sp} />

      {/* Progress: visible on every screen size; skipped steps are shown as skipped, never done. */}
      <div className="mb-6" aria-label={t("Onboarding progress")}>
        <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2 text-xs text-chrome">
          <span>{t("Step {n} of {total}", { n: idx + 1, total: prog.total })}</span>
          <span className="num text-muted">{t("{done} done · {skipped} skipped · {pending} pending", { done: prog.done, skipped: prog.skipped, pending: prog.pending })}</span>
        </div>
        <ol className="grid grid-cols-11 gap-1">
          {ONBOARDING_FLOW.map((s, i) => {
            const st = stepState(steps, s.key);
            return (
              <li key={s.key}>
                <Link
                  href={onboardingHref(p.slug, { step: s.key, part: s.key === "info" ? (INFO_PARTS.find((x) => partState(steps, x.key).status === "pending")?.key ?? INFO_PARTS[0].key) : null })}
                  title={`${t(s.label)}: ${stateLabel(st)}`}
                  aria-label={`${i + 1}. ${t(s.label)}: ${stateLabel(st)}`}
                  aria-current={s.key === pos.step ? "step" : undefined}
                  className="flex h-10 items-center md:h-6"
                >
                  <span
                    className={cx(
                      "block h-2.5 w-full border",
                      st.status === "done" ? "border-ok/60 bg-ok/70" : st.status === "skipped" ? "border-warn/60 bg-[repeating-linear-gradient(45deg,rgb(217_161_59/0.55)_0_3px,transparent_3px_6px)]" : "border-line-strong bg-line",
                      s.key === pos.step && "outline outline-1 outline-offset-2 outline-blue-bright",
                    )}
                  />
                </Link>
              </li>
            );
          })}
        </ol>
      </div>

      <div className="grid gap-6 lg:grid-cols-[15rem_1fr]">
        <nav aria-label={t("Onboarding steps")} className="hidden lg:block">
          <ol className="flex flex-col gap-0.5">
            {ONBOARDING_FLOW.map((s, i) => {
              const st = stepState(steps, s.key);
              return (
                <li key={s.key}>
                  <Link
                    href={onboardingHref(p.slug, { step: s.key, part: s.key === "info" ? INFO_PARTS[0].key : null })}
                    className={cx("flex items-center gap-3 border-l-2 px-3 py-1.5 text-xs", s.key === pos.step ? "border-blue-bright text-platinum" : "border-transparent text-chrome hover:text-platinum")}
                  >
                    <span className="num text-[10px] text-muted">{String(i + 1).padStart(2, "0")}</span>
                    <span className="flex-1">{t(s.label)}</span>
                    <span className={cx("num text-[11px]", stateClass(st))} title={stateLabel(st)}>
                      {stateIcon(st)}
                    </span>
                  </Link>
                  {s.key === "info" && pos.step === "info" && (
                    <ol className="mb-1 ml-6 flex flex-col border-l border-line">
                      {INFO_PARTS.map((x) => {
                        const ps = partState(steps, x.key);
                        return (
                          <li key={x.key}>
                            <Link href={onboardingHref(p.slug, { step: "info", part: x.key })} className={cx("flex items-center gap-2 px-3 py-1 text-[11px]", x.key === pos.part ? "text-platinum" : "text-muted hover:text-chrome")}>
                              <span className="flex-1">{t(x.label)}</span>
                              <span className={stateClass(ps)}>{stateIcon(ps)}</span>
                            </Link>
                          </li>
                        );
                      })}
                    </ol>
                  )}
                </li>
              );
            })}
            <li className="mt-4 border-t border-line pt-4">
              <div className="eyebrow">{t("Knowledge completeness")}</div>
              <div className="num mt-1 text-2xl">{Math.round(completeness.score * 100)}%</div>
            </li>
          </ol>
        </nav>

        <div className="flex min-w-0 flex-col gap-6">
          {/* Sub-steps of PRODUCT INFORMATION on phones and tablets. */}
          {pos.step === "info" && (
            <div className="flex flex-wrap gap-1 lg:hidden">
              {INFO_PARTS.map((x, i) => {
                const ps = partState(steps, x.key);
                return (
                  <Link key={x.key} href={onboardingHref(p.slug, { step: "info", part: x.key })} className={cx("inline-flex min-h-10 items-center gap-1.5 border px-2.5 text-[11px]", x.key === pos.part ? "border-blue-bright text-platinum" : "border-line text-muted")}>
                    <span className="num">{i + 1}</span>
                    <span className={stateClass(ps)}>{stateIcon(ps)}</span>
                    <span className="sr-only">{t(x.label)}</span>
                  </Link>
                );
              })}
            </div>
          )}

          {section !== undefined ? (
            <Panel>
              <form action={saveOnboardingStepAction} className="flex flex-col gap-5">
                <HiddenBack path={here} />
                <input type="hidden" name="productId" value={p.id} />
                <input type="hidden" name="step" value={section} />
                <input type="hidden" name="flow" value={pos.step} />
                {pos.part && <input type="hidden" name="part" value={pos.part} />}

                {section === 1 && (
                  <>
                    <Field label={t("Product name")}>
                      <input name="name" defaultValue={p.name} required minLength={2} maxLength={80} />
                    </Field>
                    <div className="grid gap-5 sm:grid-cols-3">
                      <Field label={t("Lifecycle status")}>
                        <select name="status" defaultValue={p.status}>
                          {["UNKNOWN", "IN_DEVELOPMENT", "BETA", "LIVE", "DEPRECATED"].map((s) => (
                            <option key={s} value={s}>
                              {locale === "fr" ? enumLabel(t, s) : s}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field label={t("Release date")}>
                        <input name="releaseDate" type="date" defaultValue={p.releaseDate ?? ""} />
                      </Field>
                      <Field label={t("Logo")} hint={t("Choose an image from your phone or computer, or paste an https address. Saved with this step.")}>
                        <ImageUrlField name="logoUrl" defaultValue={p.logoUrl} productId={p.id} />
                      </Field>
                    </div>
                  </>
                )}

                {section === 2 && (
                  <>
                    <div className="grid gap-5 sm:grid-cols-2">
                      <Field label={t("Canonical domain")} hint={t("Used for canonical URLs, audits and tracking origin checks.")}>
                        <input name="domain" defaultValue={p.domain ?? ""} placeholder="example.com" />
                      </Field>
                      <Field label={t("Documentation URL")}>
                        <input name="documentationUrl" type="url" defaultValue={p.documentationUrl ?? ""} placeholder="https://…" />
                      </Field>
                      <Field label={t("Pricing page URL")}>
                        <input name="pricingUrl" type="url" defaultValue={p.pricingUrl ?? ""} placeholder="https://…" />
                      </Field>
                      <Field label={t("Languages (comma separated ISO codes)")}>
                        <input name="languages" defaultValue={p.languages.join(", ")} placeholder="en, fr" />
                      </Field>
                      <Field label={t("Supported countries (comma separated)")}>
                        <input name="supportedCountries" defaultValue={p.supportedCountries.join(", ")} placeholder="FR, BE, US" />
                      </Field>
                    </div>
                    <Field label={t("Social accounts (one per line): network | https://url")}>
                      <textarea name="social" className={TEXTAREA} defaultValue={p.socialAccounts.map((s) => `${s.network} | ${s.url}`).join("\n")} />
                    </Field>
                  </>
                )}

                {section === 3 && (
                  <div className="grid gap-5 sm:grid-cols-2">
                    <Field label={t("Category")} hint={t("Precise category, e.g. “TikTok LIVE moderation software”.")}>
                      <input name="category" defaultValue={p.category ?? ""} maxLength={120} />
                    </Field>
                    <Field label={t("Topics / keywords (comma separated)")}>
                      <input name="keywords" defaultValue={p.keywords.join(", ")} />
                    </Field>
                    <Field label={t("Public API available?")}>
                      <select name="apiAvailable" defaultValue={p.apiAvailable === null ? "" : String(p.apiAvailable)}>
                        <option value="">{t("Unknown")}</option>
                        <option value="true">{t("Yes")}</option>
                        <option value="false">{t("No")}</option>
                      </select>
                    </Field>
                    <Field label={t("Free trial?")}>
                      <select name="freeTrial" defaultValue={p.freeTrial === null ? "" : String(p.freeTrial)}>
                        <option value="">{t("Unknown")}</option>
                        <option value="true">{t("Yes")}</option>
                        <option value="false">{t("No")}</option>
                      </select>
                    </Field>
                  </div>
                )}

                {section === 4 && (
                  <>
                    <Field label={t("Short description (≤ 300 chars)")} hint={t("What it is and who it is for, in one precise sentence.")}>
                      <textarea name="shortDescription" maxLength={300} className="min-h-20" defaultValue={p.shortDescription ?? ""} />
                    </Field>
                    <Field label={t("Full description")}>
                      <textarea name="fullDescription" className="min-h-40" defaultValue={p.fullDescription ?? ""} />
                    </Field>
                    <Field label={t("How it works")} hint={t("Ordered steps (1. … 2. …) enable factual tutorials and HowTo structured data.")}>
                      <textarea name="howItWorks" className="min-h-32" defaultValue={p.howItWorks ?? ""} />
                    </Field>
                  </>
                )}

                {section === 5 && (
                  <>
                    <Field label={t("Target audiences (one per line): Name | description")}>
                      <textarea name="audiences" className={TEXTAREA} defaultValue={lines("AUDIENCE")} placeholder={t("TikTok agencies | Agencies managing a roster of LIVE creators")} />
                    </Field>
                    <Field label={t("Industries (one per line)")}>
                      <textarea name="industries" className={TEXTAREA} defaultValue={lines("INDUSTRY")} />
                    </Field>
                  </>
                )}

                {section === 6 && (
                  <Field label={t("Problems solved (one per line): Problem | explanation")}>
                    <textarea name="problems" className={TEXTAREA} defaultValue={lines("PROBLEM")} />
                  </Field>
                )}

                {section === 7 && (
                  <>
                    <Field label={t("Features (one per line): Feature | description (≥ 60 chars enables a dedicated page)")}>
                      <textarea name="features" className={TEXTAREA} defaultValue={lines("FEATURE")} />
                    </Field>
                    <Field label={t("Use cases (one per line): Use case | description")}>
                      <textarea name="useCases" className={TEXTAREA} defaultValue={lines("USE_CASE")} />
                    </Field>
                  </>
                )}

                {section === 8 && (
                  <>
                    <Field
                      label={t("Plans (one per line): Plan | price | currency | MONTH/YEAR/ONE_TIME/USAGE/CUSTOM | trial days | description")}
                      hint={t("Leave the price blank (or write \"Contact sales\") when it is not public: it is stored as unknown, never 0. Currency (e.g. EUR) and billing interval are never guessed: give them for every priced plan. Prices are only published in structured data once verified.")}
                    >
                      <textarea
                        name="pricing"
                        className={TEXTAREA}
                        defaultValue={g.pricing.map((x) => [x.planName, x.priceCents === null ? "" : (x.priceCents / 100).toString(), x.currency ?? "", x.interval ?? "", x.trialDays ?? "", x.description ?? ""].join(" | ")).join("\n")}
                      />
                    </Field>
                    {g.pricing.some((x) => x.priceCents !== null && (!x.currency || !x.interval)) && (
                      <p className="text-xs text-warn">
                        {t("Unknown currency or billing interval for: {plans}. Add them so prices can be published.", {
                          plans: g.pricing
                            .filter((x) => x.priceCents !== null && (!x.currency || !x.interval))
                            .map((x) => x.planName)
                            .join(", "),
                        })}
                      </p>
                    )}
                  </>
                )}

                {section === 9 && (
                  <Field label={t("Competitors (one per line): Name | domain")} hint={t("Add sourced comparison facts later in the knowledge editor. Comparison pages require ≥ 3 sourced facts.")}>
                    <textarea name="competitors" className={TEXTAREA} defaultValue={g.competitors.map((c) => [c.competitor.name, c.competitor.domain ?? ""].join(" | ")).join("\n")} />
                  </Field>
                )}

                {section === 10 && (
                  <Field label={t("Integrations (one per line): Integration | description")} hint={t("Only list integrations that exist today.")}>
                    <textarea name="integrations" className={TEXTAREA} defaultValue={lines("INTEGRATION")} />
                  </Field>
                )}

                {section === 11 && (
                  <>
                    <Field label={t("Canonical sources (one per line): Title | https://url | WEBSITE/DOCUMENTATION/PRICING/CHANGELOG/CASE_STUDY/PRESS/REPOSITORY/LEGAL/OTHER")} hint={t("Every public claim should trace back to one of these URLs.")}>
                      <textarea name="sources" className={TEXTAREA} defaultValue={g.sources.map((s) => [s.title, s.url, s.kind].join(" | ")).join("\n")} />
                    </Field>
                    <Field label={t("Factual differentiators (one per line): Differentiator | evidence")}>
                      <textarea name="differentiators" className={TEXTAREA} defaultValue={lines("DIFFERENTIATOR")} />
                    </Field>
                    <p className="text-xs text-muted">{t("Testimonials, case studies and metrics are added in the knowledge editor, where each item needs a source and explicit permission to publish.")}</p>
                  </>
                )}

                {section === 12 && (
                  <>
                    {integrationStatus(t("Google Analytics 4"), ga)}
                    <p className="text-sm text-chrome">{t("Beacon’s first-party tracker works without any third-party analytics. Optionally connect Google Analytics 4 to import sessions by channel, including AI-assistant referrals.")}</p>
                    <p className="text-xs text-muted">
                      {t("Prefer signing in with Google? Use Connect with Google in")}{" "}
                      <Link className="text-blue-bright underline underline-offset-4" href="/settings/integrations">
                        {t("Settings, Integrations")}
                      </Link>
                      .
                    </p>
                    <Field label={t("GA4 property ID")}>
                      <input name="gaPropertyId" defaultValue={ga?.config.propertyId ?? ""} placeholder="123456789" />
                    </Field>
                    <Field label={t("Service account JSON")} hint={t("Stored encrypted (AES-256-GCM). Grant the service account Viewer access on the property. Leave blank to keep the stored secret.")}>
                      <textarea name="gaServiceAccount" className={TEXTAREA} autoComplete="off" />
                    </Field>
                  </>
                )}

                {section === 13 && (
                  <>
                    <div className="grid gap-3 sm:grid-cols-2">
                      {integrationStatus(t("Google Search Console"), gsc)}
                      {integrationStatus(t("Bing Webmaster"), bing)}
                    </div>
                    <p className="text-sm text-chrome">{t("Connect Google Search Console for impressions, clicks, positions and query data. Bing Webmaster can be connected in Settings → Integrations.")}</p>
                    <p className="text-xs text-muted">
                      {t("Prefer signing in with Google? Use Connect with Google in")}{" "}
                      <Link className="text-blue-bright underline underline-offset-4" href="/settings/integrations">
                        {t("Settings, Integrations")}
                      </Link>
                      .
                    </p>
                    <Field label={t("Search Console property")}>
                      <input name="gscSiteUrl" defaultValue={gsc?.config.siteUrl ?? (p.domain ? `sc-domain:${p.domain}` : "")} placeholder="sc-domain:example.com" />
                    </Field>
                    <Field label={t("Service account JSON")} hint={t("Add the service account email as a user of the property. Stored encrypted; leave blank to keep the stored secret.")}>
                      <textarea name="gscServiceAccount" className={TEXTAREA} autoComplete="off" />
                    </Field>
                  </>
                )}

                {section === 14 && (
                  <>
                    <Field label={t("Conversion URLs (one per line): Label | https://url | TRY_FREE/START_NOW/VIEW_DEMO/COMPARE_PLANS/BOOK_DEMO/ASK/OTHER")}>
                      <textarea name="ctas" className={TEXTAREA} defaultValue={p.conversionUrls.map((c) => [c.label, c.url, c.kind].join(" | ")).join("\n")} />
                    </Field>
                    <p className="text-sm text-chrome">
                      {t("Create tracking keys on the product’s")}{" "}
                      <Link className="text-blue-bright underline underline-offset-4" href={`/products/${p.slug}/tracking`}>
                        {t("tracking page")}
                      </Link>
                      .
                    </p>
                  </>
                )}

                {canWrite && (
                  <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
                    <Button variant="gold" name="intent" value="next">
                      {t("Save & continue →")}
                    </Button>
                    <Button name="intent" value="save">
                      {t("Save")}
                    </Button>
                    {pos.step !== "product" && (
                      <Button name="intent" value="skip">
                        {t("Skip (leave unknown)")}
                      </Button>
                    )}
                    {prev && (
                      <Link href={onboardingHref(p.slug, prev)} className="eyebrow ml-auto inline-flex min-h-10 items-center hover:text-chrome md:min-h-0">
                        {t("← Back")}
                      </Link>
                    )}
                  </div>
                )}
              </form>
            </Panel>
          ) : null}

          {pos.step === "website" && (
            <>
              <Panel title={t("Domain ownership")} eyebrow={t("Verify before Beacon crawls")}>
                {!host ? (
                  <p className="text-sm text-muted">{t("Enter the canonical domain above and save to verify it.")}</p>
                ) : domain?.verifiedAt ? (
                  <p className="text-sm text-ok">✓ {t("{domain} is verified ({method}).", { domain: domain.domain, method: domain.method === "DNS_TXT" ? t("DNS TXT record") : t("verification file") })}</p>
                ) : domainVerificationBypassed(host) ? (
                  <p className="text-sm text-chrome">{t("Local development host: ownership verification is bypassed.")}</p>
                ) : !domain ? (
                  can("settings:manage") ? (
                    <form action={onboardingAddDomainAction} className="flex flex-col items-start gap-3">
                      <HiddenBack path={here} />
                      <input type="hidden" name="productId" value={p.id} />
                      <p className="text-sm text-chrome">{t("Beacon only crawls sites you prove you control. Start the verification of {domain}.", { domain: host })}</p>
                      <Button variant="gold">{t("Verify ownership of {domain}", { domain: host })}</Button>
                    </form>
                  ) : (
                    <p className="text-sm text-muted">{t("Ask an admin to verify {domain}.", { domain: host })}</p>
                  )
                ) : (
                  <div className="flex flex-col gap-3">
                    <ol className="flex list-decimal flex-col gap-3 pl-5 text-xs text-chrome">
                      <li>
                        {t("Either add this DNS TXT record to {domain}:", { domain: domain.domain })}
                        <code className="mt-1 block break-all border border-line bg-obsidian px-2 py-1 font-mono text-[11px] text-platinum">
                          {VERIFICATION_TXT_PREFIX}
                          {domain.token}
                        </code>
                      </li>
                      <li>
                        {t("Or publish a text file at {url} containing only the token:", { url: `https://${domain.domain}${VERIFICATION_FILE_PATH}` })}
                        <code className="mt-1 block break-all border border-line bg-obsidian px-2 py-1 font-mono text-[11px] text-platinum">{domain.token}</code>
                      </li>
                      <li>{t("Then choose Verify now. DNS changes can take a while to propagate.")}</li>
                    </ol>
                    {domain.lastError && <p className="break-words text-xs text-warn">{t("Last check failed: {error}", { error: domain.lastError })}</p>}
                    {can("settings:manage") ? (
                      <form action={onboardingVerifyDomainAction}>
                        <HiddenBack path={here} />
                        <input type="hidden" name="id" value={domain.id} />
                        <Button variant="gold">{t("Verify now")}</Button>
                      </form>
                    ) : (
                      <p className="text-sm text-muted">{t("Ask an admin to verify {domain}.", { domain: host })}</p>
                    )}
                  </div>
                )}
              </Panel>

              <Panel title={t("Extract from website")} eyebrow={t("Proposed facts, unverified")}>
                <p className="mb-3 text-sm text-chrome">{t("Beacon reads the homepage and up to {n} key pages (pricing, documentation, features, about) and proposes what it finds, each with the page it came from. Nothing is added until you accept it, and accepted facts stay unverified until an admin verifies them.", { n: 4 })}</p>
                {canWrite && host && (domain?.verifiedAt || domainVerificationBypassed(host)) ? (
                  <form action={extractWebsiteAction} className="mb-4">
                    <HiddenBack path={here} />
                    <input type="hidden" name="productId" value={p.id} />
                    <Button variant={data.proposals?.length ? "ghost" : "gold"}>{data.proposals?.length || data.accepted ? t("Extract again") : t("Extract from website")}</Button>
                  </form>
                ) : (
                  <p className="mb-4 text-xs text-muted">{t("Available once the domain is verified.")}</p>
                )}
                {data.proposals && data.proposals.length > 0 ? (
                  <ul className="flex flex-col gap-2">
                    {data.proposals.map((x) => (
                      <li key={x.id} className="flex flex-col gap-2 border border-line bg-obsidian/40 p-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge tone="muted">{x.kind === "CLAIM" ? t(CLAIM_LABELS[x.field as keyof typeof CLAIM_LABELS] ?? x.field) : x.kind === "FACET" ? t("Feature") : x.kind === "PRICING" ? t("Pricing plan") : x.kind === "SOCIAL" ? x.field : t("Logo")}</Badge>
                            <Badge tone="muted">{t(ORIGIN_LABEL[x.origin] ?? x.origin)}</Badge>
                            <StatusBadge status="UNVERIFIED" />
                          </div>
                          <div className="mt-1.5 break-words text-sm text-platinum">{x.value}</div>
                          {x.kind === "FACET" && typeof x.details.description === "string" && <div className="mt-1 break-words text-xs text-chrome">{x.details.description}</div>}
                          {x.kind === "PRICING" && (
                            <div className="mt-1 text-xs text-chrome">
                              {typeof x.details.priceCents === "number" ? `${(x.details.priceCents / 100).toString()} ${x.details.currency ?? t("currency unknown")}` : t("Price unknown")} · {t("billing interval unknown")}
                            </div>
                          )}
                          <a href={x.sourceUrl} target="_blank" rel="noreferrer noopener" className="mt-1 block break-all text-[11px] text-blue-bright underline underline-offset-2">
                            {t("Source: {url}", { url: x.sourceUrl })}
                          </a>
                        </div>
                        {canWrite && (
                          <div className="flex shrink-0 gap-2">
                            <form action={acceptProposalAction}>
                              <HiddenBack path={here} />
                              <input type="hidden" name="id" value={x.id} />
                              <Button variant="gold">{t("Accept")}</Button>
                            </form>
                            <form action={rejectProposalAction}>
                              <HiddenBack path={here} />
                              <input type="hidden" name="ids[]" value={x.id} />
                              <Button>{t("Dismiss")}</Button>
                            </form>
                          </div>
                        )}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-muted">{data.accepted ? t("{n} proposal(s) accepted. Nothing left to review.", { n: data.accepted }) : t("No proposals yet.")}</p>
                )}
              </Panel>
            </>
          )}

          {pos.step === "verify" && (
            <Panel title={t("Facts waiting for verification")} eyebrow={t("{n} unverified", { n: verifyFacts.length })}>
              {!can("fact:verify") && <p className="mb-4 border border-warn/40 px-3 py-2 text-sm text-warn">{t("Only owners and admins verify facts. Ask an admin to review this list; you can continue onboarding meanwhile.")}</p>}
              {verifyFacts.length === 0 ? (
                <EmptyState
                  variant="no_data_yet"
                  what={t("Nothing to verify right now.")}
                  why={t("Every fact in the knowledge graph is verified or rejected, or no fact was entered yet.")}
                  action={{ label: t("Open the knowledge graph"), href: `/products/${p.slug}/knowledge` }}
                />
              ) : (
                <ul className="flex flex-col gap-2">
                  {verifyFacts.slice(0, 40).map((f) => {
                    const src = sourceUrl(f.sourceId);
                    return (
                      <li key={`${f.kind}:${f.id}`} className="flex flex-col gap-2 border border-line bg-obsidian/40 p-3 md:flex-row md:items-start md:justify-between">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge tone="muted">{t(f.type)}</Badge>
                            <StatusBadge status={f.verification} />
                          </div>
                          <div className="mt-1.5 break-words text-sm text-platinum">{f.text}</div>
                          {src ? (
                            <a href={src} target="_blank" rel="noreferrer noopener" className="mt-1 block break-all text-[11px] text-blue-bright underline underline-offset-2">
                              {t("Source: {url}", { url: src })}
                            </a>
                          ) : (
                            <div className="mt-1 text-[11px] text-warn">{t("No source linked: choose the page you checked it against.")}</div>
                          )}
                        </div>
                        {can("fact:verify") && (
                          <form action={setVerificationAction} className="flex shrink-0 flex-wrap items-center gap-2">
                            <HiddenBack path={here} />
                            <input type="hidden" name="kind" value={f.kind} />
                            <input type="hidden" name="id" value={f.id} />
                            <select name="sourceId" defaultValue={f.sourceId ?? ""} className="min-h-10 md:!w-48" aria-label={t("Source checked")}>
                              <option value="">{t("Source…")}</option>
                              {g.sources.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.title}
                                </option>
                              ))}
                            </select>
                            <Button variant="gold" name="verification" value="VERIFIED">
                              {t("Verify")}
                            </Button>
                            <Button variant="danger" name="verification" value="REJECTED">
                              {t("Reject")}
                            </Button>
                          </form>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
              {verifyFacts.length > 40 && (
                <p className="mt-3 text-xs text-muted">
                  {t("{n} more in the", { n: verifyFacts.length - 40 })}{" "}
                  <Link className="text-blue-bright underline underline-offset-4" href={`/products/${p.slug}/knowledge`}>
                    {t("knowledge graph")}
                  </Link>
                  .
                </p>
              )}
              <div className="mt-4">{advance()}</div>
            </Panel>
          )}

          {pos.step === "crawl" && (
            <Panel title={t("Initial crawl")} eyebrow={t("Technical audit of the verified domain")}>
              {!host ? (
                <EmptyState variant="not_connected" what={t("No domain to crawl.")} why={t("The initial crawl audits the product’s own domain.")} action={{ label: t("Enter the domain"), href: onboardingHref(p.slug, { step: "website" }) }} />
              ) : !domain?.verifiedAt && !domainVerificationBypassed(host) ? (
                <EmptyState variant="not_connected" what={t("{domain} is not verified yet.", { domain: host })} why={t("Beacon only crawls sites you prove you control.")} action={{ label: t("Verify the domain"), href: onboardingHref(p.slug, { step: "website" }) }} />
              ) : !data.audit ? (
                <EmptyState
                  variant="not_generated"
                  what={t("No crawl yet.")}
                  why={t("The crawl checks indexability, sitemaps, structured data, links and headings of up to {n} pages.", { n: 50 })}
                  action={can("job:run") ? { label: t("Start initial crawl"), form: { action: initialCrawlAction, fields: { productId: p.id }, back: here } } : { label: t("Open Discovery"), href: `/discovery?product=${p.slug}` }}
                />
              ) : (
                <div className="flex flex-col gap-3 text-sm">
                  {(data.audit.status === "QUEUED" || data.audit.status === "RUNNING") && <AutoRefresh seconds={4} />}
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={data.audit.status} />
                    <span className="break-all text-chrome">{data.audit.startUrl}</span>
                  </div>
                  <dl className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
                    <div>
                      <dt className="eyebrow">{t("Pages crawled")}</dt>
                      <dd className="num mt-0.5 text-platinum">{data.audit.pagesCrawled}</dd>
                    </div>
                    <div>
                      <dt className="eyebrow">{t("Critical")}</dt>
                      <dd className="num mt-0.5 text-platinum">{data.audit.status === "SUCCEEDED" ? (data.audit.summary.CRITICAL ?? 0) : t("n/a")}</dd>
                    </div>
                    <div>
                      <dt className="eyebrow">{t("Started")}</dt>
                      <dd className="num mt-0.5 text-chrome">{day(data.audit.startedAt)}</dd>
                    </div>
                    <div>
                      <dt className="eyebrow">{t("Finished")}</dt>
                      <dd className="num mt-0.5 text-chrome">{day(data.audit.finishedAt)}</dd>
                    </div>
                  </dl>
                  {(data.audit.status === "QUEUED" || data.audit.status === "RUNNING") && <p className="text-xs text-muted">{t("This page refreshes by itself while the crawl runs.")}</p>}
                  {data.audit.error && <p className="break-words text-xs text-warn">{t(data.audit.error)}</p>}
                  <div className="flex flex-wrap gap-2">
                    <LinkButton href={`/discovery/audits/${data.audit.id}`}>{t("Open the audit →")}</LinkButton>
                    {can("job:run") && data.audit.status !== "QUEUED" && data.audit.status !== "RUNNING" && (
                      <form action={initialCrawlAction}>
                        <HiddenBack path={here} />
                        <input type="hidden" name="productId" value={p.id} />
                        <Button>{t("Crawl again")}</Button>
                      </form>
                    )}
                  </div>
                </div>
              )}
              <div className="mt-4">{advance()}</div>
            </Panel>
          )}

          {pos.step === "queries" && (
            <Panel title={t("Query universe")} eyebrow={t("{active} active · {candidate} candidates", { active: data.queryCounts?.active ?? 0, candidate: data.queryCounts?.candidate ?? 0 })}>
              {!data.clusters?.length ? (
                <EmptyState
                  variant="not_generated"
                  what={t("No queries yet.")}
                  why={t("Beacon derives candidate queries and topic clusters from the knowledge graph (category, audiences, problems, features, integrations, competitors). You activate the ones worth tracking.")}
                  action={can("query:write") ? { label: t("Generate query universe"), form: { action: generateUniverseAction, fields: { productId: p.id }, back: here } } : { label: t("Open queries"), href: `/queries?product=${p.slug}` }}
                />
              ) : (
                <div className="flex flex-col gap-3">
                  <p className="text-sm text-chrome">{t("Candidates are suggestions only. Untick what does not fit, then activate a cluster: active queries drive content gaps, opportunities and the launch baseline.")}</p>
                  <div className="grid gap-3 md:grid-cols-2">
                    {data.clusters.map((c) => (
                      <form key={c.id} action={bulkQueryAction} className="flex min-w-0 flex-col gap-2 border border-line bg-obsidian/40 p-3">
                        <HiddenBack path={here} />
                        <div className="flex items-start justify-between gap-2">
                          <span className="break-words text-sm text-platinum">{t(c.name)}</span>
                          <span className="num shrink-0 text-[11px] text-muted">{t("{active} active · {candidate} candidates", { active: c.active, candidate: c.candidates.length })}</span>
                        </div>
                        {c.candidates.length > 0 ? (
                          <>
                            <ul className="flex flex-col gap-1">
                              {c.candidates.slice(0, 8).map((q) => (
                                <li key={q.id}>
                                  <label className="flex min-h-9 items-center gap-2 text-xs text-chrome">
                                    <input type="checkbox" name="ids[]" value={q.id} defaultChecked />
                                    <span className="break-words">{q.query}</span>
                                  </label>
                                </li>
                              ))}
                            </ul>
                            {c.candidates.length > 8 && <p className="text-[11px] text-muted">{t("{n} more candidates in Queries.", { n: c.candidates.length - 8 })}</p>}
                            {can("query:write") && (
                              <div>
                                <Button variant="gold" name="op" value="ACTIVE">
                                  {t("Activate selected")}
                                </Button>
                              </div>
                            )}
                          </>
                        ) : (
                          <p className="text-xs text-ok">✓ {t("All queries of this cluster are active.")}</p>
                        )}
                      </form>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <LinkButton href={`/queries?product=${p.slug}&status=CANDIDATE`}>{t("Review every candidate →")}</LinkButton>
                    {can("query:write") && (
                      <form action={generateUniverseAction}>
                        <HiddenBack path={here} />
                        <input type="hidden" name="productId" value={p.id} />
                        <Button>{t("Generate again")}</Button>
                      </form>
                    )}
                  </div>
                </div>
              )}
              <div className="mt-4">{advance()}</div>
            </Panel>
          )}

          {pos.step === "gaps" && (
            <>
              {data.gaps && data.gaps.length > 0 ? (
                <ContentGaps gaps={data.gaps} productId={p.id} productName={p.name} back={here} canGrowth={can("growth:write")} canContent={can("content:write")} />
              ) : (
                <EmptyState
                  variant="no_data_yet"
                  what={t("No content gap found yet.")}
                  why={t("Gaps come from active queries without a covering page, measured search demand and sampled AI answers. Activate queries first, or connect search data for demand.")}
                  action={{ label: t("Activate queries"), href: onboardingHref(p.slug, { step: "queries" }) }}
                  secondary={{ label: t("Connect search data"), href: onboardingHref(p.slug, { step: "search" }) }}
                />
              )}
              <Panel>{advance()}</Panel>
            </>
          )}

          {pos.step === "opportunities" && (
            <Panel title={t("Top opportunities")} eyebrow={t("Opportunity engine")} pad={false}>
              {data.opps && data.opps.length > 0 ? (
                <ul>
                  {data.opps.map((o) => (
                    <li key={o.id} className="flex flex-col gap-2 border-b border-line/60 px-4 py-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <Link href={`/opportunities/${o.id}`} className="text-sm text-platinum hover:text-blue-bright">
                          {t(o.title)}
                        </Link>
                        <div className="text-xs text-muted">{t(o.problem)}</div>
                      </div>
                      <PotentialBadge potential={o.potential} />
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="p-4">
                  <EmptyState
                    variant="not_generated"
                    what={t("No opportunities yet.")}
                    why={t("Opportunities are computed from evidence: content gaps, crawl issues, search data and AI visibility samples. Generate them once queries are active and the crawl has finished.")}
                    action={can("job:run") ? { label: t("Generate opportunities"), form: { action: regenerateOpportunitiesAction, fields: { productId: p.id }, back: here } } : { label: t("Open opportunities"), href: `/opportunities?product=${p.slug}` }}
                  />
                </div>
              )}
              <div className="px-4 pb-4">{advance()}</div>
            </Panel>
          )}

          {pos.step === "score" && (
            <Panel title={t("Beacon Score")} eyebrow={t("Operational discoverability readiness")}>
              {!data.score ? (
                <EmptyState
                  variant="not_generated"
                  what={t("No score computed yet.")}
                  why={t("The score measures readiness from observable facts (knowledge, crawl, queries, measurement). Compute it now, or finish onboarding and Beacon computes it with the product analysis.")}
                  action={can("job:run") ? { label: t("Compute the score"), form: { action: recomputeScoreAction, fields: { productId: p.id }, back: here } } : { label: t("Open the product"), href: `/products/${p.slug}` }}
                />
              ) : (
                <ScoreReveal score={data.score} />
              )}
              <div className="mt-4">{advance({ next: t("Finish & analyse →"), skip: false })}</div>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

async function ScoreReveal({ score: stored }: { score: NonNullable<Awaited<ReturnType<typeof storedScoreWithDiff>>> }): Promise<ReactNode> {
  const t = await getT();
  const s = stored.score;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end gap-3">
        <div className="num text-6xl font-medium tracking-tighter text-platinum">{s.total}</div>
        <div className="pb-2 text-sm text-muted">/ 100</div>
      </div>
      <p className="text-xs text-muted">{t("Measured coverage: {pct}% of the 100 points (unmeasurable lines are excluded and the score is rescaled).", { pct: Math.round(s.coverage * 100) })}</p>
      {s.notMeasured.length > 0 && (
        <ul className="flex flex-col gap-1 border-l border-warn/40 pl-3">
          {s.notMeasured.map((n) => (
            <li key={`${n.component}:${n.label}`} className="text-[11px] text-warn">
              {t("{label}:", { label: t(n.label) })} {t(n.reason)}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-col gap-2">
        {s.components.map((c) => (
          <div key={c.key} className="flex flex-col gap-1">
            <span className="flex justify-between gap-2 text-xs text-chrome">
              <span>{t(c.label)}</span>
              <span className="num text-muted">{c.max ? `${Math.round((c.earned / c.max) * 100)}%` : t("Not measured")}</span>
            </span>
            <Meter value={c.earned} max={c.max || 1} label={t(c.label)} />
          </div>
        ))}
      </div>
      {s.pathTo.tasks.length > 0 && (
        <div className="border-t border-line pt-4">
          <div className="eyebrow text-gold">{t("Fastest path to {target}", { target: s.pathTo.target })}</div>
          <ol className="mt-2 flex flex-col gap-2">
            {s.pathTo.tasks.map((task, i) => (
              <li key={task.task} className="flex gap-3 text-xs">
                <span className="num text-muted">{i + 1}.</span>
                <span className="flex-1 text-chrome">{t(task.task)}</span>
                <span className="num text-ok">+{task.points}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </div>
  );
}
