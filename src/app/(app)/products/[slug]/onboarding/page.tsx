import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { saveOnboardingStepAction } from "@/app/actions/products";
import { Button, Field, Flash, HiddenBack, PageHeader, Panel, cx } from "@/components/ui";
import { integrations } from "@/db/schema";
import { facetLines } from "@/core/knowledge/parse";
import { facetsOf } from "@/core/knowledge/types";
import { loadProductGraph } from "@/core/knowledge/load";
import { computeCompleteness } from "@/core/knowledge/completeness";
import { ONBOARDING_STEPS } from "@/services/onboarding";
import { pageData, productOr404, sp1, type SP } from "@/lib/page";

export const metadata = { title: "Onboarding" };

const TEXTAREA = "min-h-40 font-mono text-[13px] leading-relaxed";

export default async function OnboardingPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SP> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const step = Math.min(ONBOARDING_STEPS.length, Math.max(1, Number(sp1(sp, "step") ?? 1) || 1));
  const { data } = await pageData(async (tx, ctx) => {
    const p = await productOr404(tx, ctx.org.id, slug);
    const g = (await loadProductGraph(tx, ctx.org.id, p.id))!;
    const integ = await tx.select().from(integrations).where(and(eq(integrations.organizationId, ctx.org.id), eq(integrations.productId, p.id)));
    return { g, integ, completeness: computeCompleteness(g) };
  });
  const { g, integ, completeness } = data;
  const p = g.product;
  const back = `/products/${p.slug}/onboarding?step=${step}`;
  const lines = (kind: Parameters<typeof facetsOf>[1]) => facetLines(facetsOf(g, kind));
  const gsc = integ.find((i) => i.provider === "GOOGLE_SEARCH_CONSOLE");
  const ga = integ.find((i) => i.provider === "GOOGLE_ANALYTICS");

  return (
    <>
      <PageHeader eyebrow={`Onboarding · ${p.name}`} title={`${String(step).padStart(2, "0")} — ${ONBOARDING_STEPS[step - 1]}`} description="Describe the product once. Only enter facts you can stand behind; leave anything unknown blank — Beacon marks it unknown instead of guessing." actions={<Link href={`/products/${p.slug}`} className="eyebrow hover:text-chrome">Exit to product →</Link>} />
      <Flash searchParams={sp} />
      <div className="grid gap-6 lg:grid-cols-[14rem_1fr]">
        <ol className="flex flex-row gap-1 overflow-x-auto lg:flex-col">
          {ONBOARDING_STEPS.map((s, i) => (
            <li key={s}>
              <Link
                href={`/products/${p.slug}/onboarding?step=${i + 1}`}
                className={cx("flex items-center gap-3 whitespace-nowrap border-l-2 px-3 py-1.5 text-xs", i + 1 === step ? "border-blue-bright text-platinum" : i + 1 < Math.max(p.onboardingStep, 1) ? "border-line-strong text-chrome" : "border-transparent text-muted")}
              >
                <span className="num text-[10px] text-muted">{String(i + 1).padStart(2, "0")}</span>
                {s}
              </Link>
            </li>
          ))}
          <li className="mt-4 hidden border-t border-line pt-4 lg:block">
            <div className="eyebrow">Knowledge completeness</div>
            <div className="num mt-1 text-2xl">{Math.round(completeness.score * 100)}%</div>
          </li>
        </ol>

        <Panel>
          <form action={saveOnboardingStepAction} className="flex flex-col gap-5">
            <HiddenBack path={back} />
            <input type="hidden" name="productId" value={p.id} />
            <input type="hidden" name="step" value={step} />

            {step === 1 && (
              <>
                <Field label="Product name">
                  <input name="name" defaultValue={p.name} required minLength={2} maxLength={80} />
                </Field>
                <div className="grid gap-5 sm:grid-cols-3">
                  <Field label="Lifecycle status">
                    <select name="status" defaultValue={p.status}>
                      {["UNKNOWN", "IN_DEVELOPMENT", "BETA", "LIVE", "DEPRECATED"].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </Field>
                  <Field label="Release date">
                    <input name="releaseDate" type="date" defaultValue={p.releaseDate ?? ""} />
                  </Field>
                  <Field label="Logo URL (https)">
                    <input name="logoUrl" type="url" defaultValue={p.logoUrl ?? ""} placeholder="https://…" />
                  </Field>
                </div>
              </>
            )}

            {step === 2 && (
              <>
                <div className="grid gap-5 sm:grid-cols-2">
                  <Field label="Canonical domain" hint="Used for canonical URLs, audits and tracking origin checks.">
                    <input name="domain" defaultValue={p.domain ?? ""} placeholder="example.com" />
                  </Field>
                  <Field label="Documentation URL">
                    <input name="documentationUrl" type="url" defaultValue={p.documentationUrl ?? ""} placeholder="https://…" />
                  </Field>
                  <Field label="Pricing page URL">
                    <input name="pricingUrl" type="url" defaultValue={p.pricingUrl ?? ""} placeholder="https://…" />
                  </Field>
                  <Field label="Languages (comma separated ISO codes)">
                    <input name="languages" defaultValue={p.languages.join(", ")} placeholder="en, fr" />
                  </Field>
                  <Field label="Supported countries (comma separated)">
                    <input name="supportedCountries" defaultValue={p.supportedCountries.join(", ")} placeholder="FR, BE, US" />
                  </Field>
                </div>
                <Field label="Social accounts — one per line: network | https://url">
                  <textarea name="social" className={TEXTAREA} defaultValue={p.socialAccounts.map((s) => `${s.network} | ${s.url}`).join("\n")} />
                </Field>
              </>
            )}

            {step === 3 && (
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Category" hint="Precise category, e.g. “TikTok LIVE moderation software”.">
                  <input name="category" defaultValue={p.category ?? ""} maxLength={120} />
                </Field>
                <Field label="Topics / keywords (comma separated)">
                  <input name="keywords" defaultValue={p.keywords.join(", ")} />
                </Field>
                <Field label="Public API available?">
                  <select name="apiAvailable" defaultValue={p.apiAvailable === null ? "" : String(p.apiAvailable)}>
                    <option value="">Unknown</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                </Field>
                <Field label="Free trial?">
                  <select name="freeTrial" defaultValue={p.freeTrial === null ? "" : String(p.freeTrial)}>
                    <option value="">Unknown</option>
                    <option value="true">Yes</option>
                    <option value="false">No</option>
                  </select>
                </Field>
              </div>
            )}

            {step === 4 && (
              <>
                <Field label="Short description (≤ 300 chars)" hint="What it is and who it is for, in one precise sentence.">
                  <textarea name="shortDescription" maxLength={300} className="min-h-20" defaultValue={p.shortDescription ?? ""} />
                </Field>
                <Field label="Full description">
                  <textarea name="fullDescription" className="min-h-40" defaultValue={p.fullDescription ?? ""} />
                </Field>
                <Field label="How it works" hint="Ordered steps (1. … 2. …) enable factual tutorials and HowTo structured data.">
                  <textarea name="howItWorks" className="min-h-32" defaultValue={p.howItWorks ?? ""} />
                </Field>
              </>
            )}

            {step === 5 && (
              <>
                <Field label="Target audiences — one per line: Name | description">
                  <textarea name="audiences" className={TEXTAREA} defaultValue={lines("AUDIENCE")} placeholder={"TikTok agencies | Agencies managing a roster of LIVE creators"} />
                </Field>
                <Field label="Industries — one per line">
                  <textarea name="industries" className={TEXTAREA} defaultValue={lines("INDUSTRY")} />
                </Field>
              </>
            )}

            {step === 6 && (
              <Field label="Problems solved — one per line: Problem | explanation">
                <textarea name="problems" className={TEXTAREA} defaultValue={lines("PROBLEM")} />
              </Field>
            )}

            {step === 7 && (
              <>
                <Field label="Features — one per line: Feature | description (≥ 60 chars enables a dedicated page)">
                  <textarea name="features" className={TEXTAREA} defaultValue={lines("FEATURE")} />
                </Field>
                <Field label="Use cases — one per line: Use case | description">
                  <textarea name="useCases" className={TEXTAREA} defaultValue={lines("USE_CASE")} />
                </Field>
              </>
            )}

            {step === 8 && (
              <Field label="Plans — one per line: Plan | price | currency | MONTH/YEAR/ONE_TIME/USAGE/CUSTOM | trial days | description" hint="Leave the price blank when it is not public. Prices are only published in structured data once verified.">
                <textarea
                  name="pricing"
                  className={TEXTAREA}
                  defaultValue={g.pricing.map((x) => [x.planName, x.priceCents === null ? "" : (x.priceCents / 100).toString(), x.currency, x.interval, x.trialDays ?? "", x.description ?? ""].join(" | ")).join("\n")}
                />
              </Field>
            )}

            {step === 9 && (
              <Field label="Competitors — one per line: Name | domain" hint="Add sourced comparison facts later in the knowledge editor. Comparison pages require ≥ 3 sourced facts.">
                <textarea name="competitors" className={TEXTAREA} defaultValue={g.competitors.map((c) => [c.competitor.name, c.competitor.domain ?? ""].join(" | ")).join("\n")} />
              </Field>
            )}

            {step === 10 && (
              <Field label="Integrations — one per line: Integration | description" hint="Only list integrations that exist today.">
                <textarea name="integrations" className={TEXTAREA} defaultValue={lines("INTEGRATION")} />
              </Field>
            )}

            {step === 11 && (
              <>
                <Field label="Canonical sources — one per line: Title | https://url | WEBSITE/DOCUMENTATION/PRICING/CHANGELOG/CASE_STUDY/PRESS/REPOSITORY/LEGAL/OTHER" hint="Every public claim should trace back to one of these URLs.">
                  <textarea name="sources" className={TEXTAREA} defaultValue={g.sources.map((s) => [s.title, s.url, s.kind].join(" | ")).join("\n")} />
                </Field>
                <Field label="Factual differentiators — one per line: Differentiator | evidence">
                  <textarea name="differentiators" className={TEXTAREA} defaultValue={lines("DIFFERENTIATOR")} />
                </Field>
                <p className="text-xs text-muted">Testimonials, case studies and metrics are added in the knowledge editor, where each item needs a source and explicit permission to publish.</p>
              </>
            )}

            {step === 12 && (
              <>
                <p className="text-sm text-chrome">
                  Beacon’s first-party tracker works without any third-party analytics (keys are created in the last step). Optionally connect Google Analytics 4 to import sessions by channel, including AI-assistant referrals.
                  {ga && <span className="ml-1 text-ok">✓ GA4 connected ({ga.config.propertyId}).</span>}
                </p>
                <Field label="GA4 property ID">
                  <input name="gaPropertyId" defaultValue={ga?.config.propertyId ?? ""} placeholder="123456789" />
                </Field>
                <Field label="Service account JSON" hint="Stored encrypted (AES-256-GCM). Grant the service account Viewer access on the property. Leave blank to keep the stored secret.">
                  <textarea name="gaServiceAccount" className={TEXTAREA} autoComplete="off" />
                </Field>
              </>
            )}

            {step === 13 && (
              <>
                <p className="text-sm text-chrome">
                  Connect Google Search Console for impressions, clicks, positions and query data. Bing Webmaster can be connected in Settings → Integrations.
                  {gsc && <span className="ml-1 text-ok">✓ Connected ({gsc.config.siteUrl}).</span>}
                </p>
                <Field label="Search Console property">
                  <input name="gscSiteUrl" defaultValue={gsc?.config.siteUrl ?? (p.domain ? `sc-domain:${p.domain}` : "")} placeholder="sc-domain:example.com" />
                </Field>
                <Field label="Service account JSON" hint="Add the service account email as a user of the property. Stored encrypted; leave blank to keep the stored secret.">
                  <textarea name="gscServiceAccount" className={TEXTAREA} autoComplete="off" />
                </Field>
              </>
            )}

            {step === 14 && (
              <>
                <Field label="Conversion URLs — one per line: Label | https://url | TRY_FREE/START_NOW/VIEW_DEMO/COMPARE_PLANS/BOOK_DEMO/ASK/OTHER">
                  <textarea name="ctas" className={TEXTAREA} defaultValue={p.conversionUrls.map((c) => [c.label, c.url, c.kind].join(" | ")).join("\n")} />
                </Field>
                <p className="text-sm text-chrome">
                  Finishing runs <span className="text-platinum">product analysis</span>: entity model → query map → content-gap analysis → suggested pages → GEO/AEO questions → distribution suggestions → opportunities → Beacon score. Create tracking keys on the product’s{" "}
                  <Link className="text-blue-bright underline underline-offset-4" href={`/products/${p.slug}/tracking`}>
                    tracking page
                  </Link>
                  .
                </p>
              </>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <Button variant="gold" name="intent" value="next">
                {step === ONBOARDING_STEPS.length ? "Finish & analyse →" : "Save & continue →"}
              </Button>
              <Button name="intent" value="save">
                Save
              </Button>
              {step < ONBOARDING_STEPS.length && (
                <Button name="intent" value="skip">
                  Skip (leave unknown)
                </Button>
              )}
              {step > 1 && (
                <Link href={`/products/${p.slug}/onboarding?step=${step - 1}`} className="eyebrow ml-auto hover:text-chrome">
                  ← Back
                </Link>
              )}
            </div>
          </form>
        </Panel>
      </div>
    </>
  );
}
