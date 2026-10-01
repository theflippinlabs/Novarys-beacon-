import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { saveOnboardingStepAction } from "@/app/actions/products";
import { uploadProductPhotosAction } from "@/app/actions/media";
import { PhotoUpload } from "@/components/media/photo-upload";
import { buildMediaUrl, mediaIdFromUrl } from "@/core/media/image";
import { env } from "@/lib/env";
import { Button, Field, Flash, HiddenBack, PageHeader, Panel, cx } from "@/components/ui";
import { integrations } from "@/db/schema";
import { facetLines } from "@/core/knowledge/parse";
import { facetsOf } from "@/core/knowledge/types";
import { loadProductGraph } from "@/core/knowledge/load";
import { computeCompleteness } from "@/core/knowledge/completeness";
import { ONBOARDING_STEPS } from "@/services/onboarding";
import { pageData, productOr404, sp1, type SP } from "@/lib/page";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Onboarding") };
}

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
  const { t, locale } = await getI18n();
  const { g, integ, completeness } = data;
  const p = g.product;
  const back = `/products/${p.slug}/onboarding?step=${step}`;
  const lines = (kind: Parameters<typeof facetsOf>[1]) => facetLines(facetsOf(g, kind));
  const gsc = integ.find((i) => i.provider === "GOOGLE_SEARCH_CONSOLE");
  const ga = integ.find((i) => i.provider === "GOOGLE_ANALYTICS");
  const logoId = p.logoUrl ? mediaIdFromUrl(p.logoUrl, [env().BEACON_BASE_URL]) : null;
  const ownLogo = logoId ? buildMediaUrl(logoId) : null;

  return (
    <>
      <PageHeader eyebrow={t("Onboarding · {name}", { name: p.name })} title={`${String(step).padStart(2, "0")} · ${t(ONBOARDING_STEPS[step - 1])}`} description={t("Describe the product once. Only enter facts you can stand behind; leave anything unknown blank. Beacon marks it unknown instead of guessing.")} actions={<Link href={`/products/${p.slug}`} className="eyebrow hover:text-chrome">{t("Exit to product →")}</Link>} />
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
                {t(s)}
              </Link>
            </li>
          ))}
          <li className="mt-4 hidden border-t border-line pt-4 lg:block">
            <div className="eyebrow">{t("Knowledge completeness")}</div>
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
                  <Field label={t("Logo URL (https)")} hint={t("Or upload an image below.")}>
                    <input name="logoUrl" type="url" defaultValue={p.logoUrl ?? ""} placeholder="https://…" />
                  </Field>
                </div>
              </>
            )}

            {step === 2 && (
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

            {step === 3 && (
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

            {step === 4 && (
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

            {step === 5 && (
              <>
                <Field label={t("Target audiences (one per line): Name | description")}>
                  <textarea name="audiences" className={TEXTAREA} defaultValue={lines("AUDIENCE")} placeholder={t("TikTok agencies | Agencies managing a roster of LIVE creators")} />
                </Field>
                <Field label={t("Industries (one per line)")}>
                  <textarea name="industries" className={TEXTAREA} defaultValue={lines("INDUSTRY")} />
                </Field>
              </>
            )}

            {step === 6 && (
              <Field label={t("Problems solved (one per line): Problem | explanation")}>
                <textarea name="problems" className={TEXTAREA} defaultValue={lines("PROBLEM")} />
              </Field>
            )}

            {step === 7 && (
              <>
                <Field label={t("Features (one per line): Feature | description (≥ 60 chars enables a dedicated page)")}>
                  <textarea name="features" className={TEXTAREA} defaultValue={lines("FEATURE")} />
                </Field>
                <Field label={t("Use cases (one per line): Use case | description")}>
                  <textarea name="useCases" className={TEXTAREA} defaultValue={lines("USE_CASE")} />
                </Field>
              </>
            )}

            {step === 8 && (
              <Field label={t("Plans (one per line): Plan | price | currency | MONTH/YEAR/ONE_TIME/USAGE/CUSTOM | trial days | description")} hint={t("Leave the price blank when it is not public. Prices are only published in structured data once verified.")}>
                <textarea
                  name="pricing"
                  className={TEXTAREA}
                  defaultValue={g.pricing.map((x) => [x.planName, x.priceCents === null ? "" : (x.priceCents / 100).toString(), x.currency, x.interval, x.trialDays ?? "", x.description ?? ""].join(" | ")).join("\n")}
                />
              </Field>
            )}

            {step === 9 && (
              <Field label={t("Competitors (one per line): Name | domain")} hint={t("Add sourced comparison facts later in the knowledge editor. Comparison pages require ≥ 3 sourced facts.")}>
                <textarea name="competitors" className={TEXTAREA} defaultValue={g.competitors.map((c) => [c.competitor.name, c.competitor.domain ?? ""].join(" | ")).join("\n")} />
              </Field>
            )}

            {step === 10 && (
              <Field label={t("Integrations (one per line): Integration | description")} hint={t("Only list integrations that exist today.")}>
                <textarea name="integrations" className={TEXTAREA} defaultValue={lines("INTEGRATION")} />
              </Field>
            )}

            {step === 11 && (
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

            {step === 12 && (
              <>
                <p className="text-sm text-chrome">
                  {t("Beacon’s first-party tracker works without any third-party analytics (keys are created in the last step). Optionally connect Google Analytics 4 to import sessions by channel, including AI-assistant referrals.")}
                  {ga && <span className="ml-1 text-ok">{t("✓ GA4 connected ({id}).", { id: String(ga.config.propertyId) })}</span>}
                </p>
                <Field label={t("GA4 property ID")}>
                  <input name="gaPropertyId" defaultValue={ga?.config.propertyId ?? ""} placeholder="123456789" />
                </Field>
                <Field label={t("Service account JSON")} hint={t("Stored encrypted (AES-256-GCM). Grant the service account Viewer access on the property. Leave blank to keep the stored secret.")}>
                  <textarea name="gaServiceAccount" className={TEXTAREA} autoComplete="off" />
                </Field>
              </>
            )}

            {step === 13 && (
              <>
                <p className="text-sm text-chrome">
                  {t("Connect Google Search Console for impressions, clicks, positions and query data. Bing Webmaster can be connected in Settings → Integrations.")}
                  {gsc && <span className="ml-1 text-ok">{t("✓ Connected ({site}).", { site: String(gsc.config.siteUrl) })}</span>}
                </p>
                <Field label={t("Search Console property")}>
                  <input name="gscSiteUrl" defaultValue={gsc?.config.siteUrl ?? (p.domain ? `sc-domain:${p.domain}` : "")} placeholder="sc-domain:example.com" />
                </Field>
                <Field label={t("Service account JSON")} hint={t("Add the service account email as a user of the property. Stored encrypted; leave blank to keep the stored secret.")}>
                  <textarea name="gscServiceAccount" className={TEXTAREA} autoComplete="off" />
                </Field>
              </>
            )}

            {step === 14 && (
              <>
                <Field label={t("Conversion URLs (one per line): Label | https://url | TRY_FREE/START_NOW/VIEW_DEMO/COMPARE_PLANS/BOOK_DEMO/ASK/OTHER")}>
                  <textarea name="ctas" className={TEXTAREA} defaultValue={p.conversionUrls.map((c) => [c.label, c.url, c.kind].join(" | ")).join("\n")} />
                </Field>
                <p className="text-sm text-chrome">
                  {t("Finishing runs ")}
                  <span className="text-platinum">{t("product analysis")}</span>
                  {t(": entity model → query map → content-gap analysis → suggested pages → GEO/AEO questions → distribution suggestions → opportunities → Beacon score. Create tracking keys on the product’s")}{" "}
                  <Link className="text-blue-bright underline underline-offset-4" href={`/products/${p.slug}/tracking`}>
                    {t("tracking page")}
                  </Link>
                  .
                </p>
              </>
            )}

            <div className="flex flex-wrap items-center gap-2 border-t border-line pt-4">
              <Button variant="gold" name="intent" value="next">
                {step === ONBOARDING_STEPS.length ? t("Finish & analyse →") : t("Save & continue →")}
              </Button>
              <Button name="intent" value="save">
                {t("Save")}
              </Button>
              {step < ONBOARDING_STEPS.length && (
                <Button name="intent" value="skip">
                  {t("Skip (leave unknown)")}
                </Button>
              )}
              {step > 1 && (
                <Link href={`/products/${p.slug}/onboarding?step=${step - 1}`} className="eyebrow ml-auto hover:text-chrome">
                  {t("← Back")}
                </Link>
              )}
            </div>
          </form>
          {step === 1 && (
            <div className="mt-6 grid gap-4 border-t border-line pt-5 sm:grid-cols-[6rem_1fr]">
              <div className="flex h-24 w-24 items-center justify-center border border-line bg-obsidian">
                {ownLogo ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={ownLogo} alt={t("Current logo")} className="max-h-full max-w-full object-contain" />
                ) : (
                  <span className="eyebrow">{t("No logo")}</span>
                )}
              </div>
              <div className="flex min-w-0 flex-col gap-2">
                <div className="eyebrow text-chrome">{t("Upload a logo")}</div>
                <p className="text-[11px] text-muted">{t("The uploaded image becomes the product logo right away (PNG with transparency works best). Unsaved changes above are not kept.")}</p>
                <PhotoUpload key={p.logoUrl ?? "none"} action={uploadProductPhotosAction} kind="logo" compact>
                  <HiddenBack path={back} />
                  <input type="hidden" name="productId" value={p.id} />
                  <input type="hidden" name="asLogo" value="on" />
                </PhotoUpload>
              </div>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
