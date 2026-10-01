import type { Metadata } from "next";
import Link from "next/link";
import { addChangelogAction, addComparisonFactAction, addFaqAction, addProofAction, deleteKnowledgeAction, markProductVerifiedAction, removeComparisonFactAction, setSourceAction, setVerificationAction } from "@/app/actions/products";
import { Badge, Button, Field, Flash, HiddenBack, KV, PageHeader, Panel, StatusBadge, Table, Td, Th } from "@/components/ui";
import { ProductTabs } from "@/components/shell/product-tabs";
import { computeCompleteness } from "@/core/knowledge/completeness";
import { loadProductGraph } from "@/core/knowledge/load";
import { FACET_LABELS, type FacetKind, type Source } from "@/core/knowledge/types";
import { enumLabel, type T } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";
import { pageData, productOr404, type SP } from "@/lib/page";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Knowledge graph") };
}

type Kind = "facet" | "pricing" | "faq" | "proof";

function formatMoney(cents: number, currency: string, intl: string) {
  return new Intl.NumberFormat(intl, { style: "currency", currency, maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);
}

function VerifyControls({ kind, id, back, current, sources, sourceId, editable, t }: { kind: Kind; id: string; back: string; current: string; sources: Source[]; sourceId: string | null; editable: boolean; t: T }) {
  if (!editable) return <StatusBadge status={current} />;
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <StatusBadge status={current} />
      <form action={setVerificationAction} className="flex gap-1">
        <HiddenBack path={back} />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="id" value={id} />
        {current !== "VERIFIED" && (
          <button name="verification" value="VERIFIED" className="eyebrow text-ok hover:underline" title={t("Mark as verified by a human")}>
            {t("verify")}
          </button>
        )}
        {current !== "REJECTED" && (
          <button name="verification" value="REJECTED" className="eyebrow text-crit hover:underline" title={t("Reject — never used in generated content")}>
            {t("reject")}
          </button>
        )}
      </form>
      <form action={setSourceAction} className="flex items-center gap-1">
        <HiddenBack path={back} />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="id" value={id} />
        <select name="sourceId" defaultValue={sourceId ?? ""} className="!w-40 !py-0.5 !text-[11px]" aria-label={t("Source")}>
          <option value="">{t("No source")}</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.title}
            </option>
          ))}
        </select>
        <button className="eyebrow hover:text-chrome">{t("link")}</button>
      </form>
      <form action={deleteKnowledgeAction}>
        <HiddenBack path={back} />
        <input type="hidden" name="kind" value={kind} />
        <input type="hidden" name="id" value={id} />
        <button className="eyebrow hover:text-crit" title={t("Delete")}>
          ✕
        </button>
      </form>
    </div>
  );
}

export default async function KnowledgePage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<SP> }) {
  const { slug } = await params;
  const sp = await searchParams;
  const { t, intl, locale } = await getI18n();
  /** Enum label: translated in French, raw value in English (unchanged output). */
  const lbl = (v: string) => (locale === "fr" ? enumLabel(t, v) : v);
  const { data: g, can } = await pageData(async (tx, ctx) => {
    const p = await productOr404(tx, ctx.org.id, slug);
    return (await loadProductGraph(tx, ctx.org.id, p.id))!;
  });
  const p = g.product;
  const back = `/products/${p.slug}/knowledge`;
  const editable = can("product:write");
  const completeness = computeCompleteness(g);
  const kinds: FacetKind[] = ["AUDIENCE", "INDUSTRY", "PROBLEM", "FEATURE", "USE_CASE", "INTEGRATION", "DIFFERENTIATOR"];

  return (
    <>
      <PageHeader eyebrow={t("Knowledge graph · {name}", { name: p.name })} title={t("Facts, sources & verification")} description={t("Only verified facts carry full confidence in generated content and structured data. Rejected facts are never used. Unknown fields are listed explicitly.")} />
      <ProductTabs slug={p.slug} active="knowledge" />
      <Flash searchParams={sp} />

      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel title={t("Core identity")} eyebrow={t("Product")} actions={<Link className="eyebrow hover:text-chrome" href={`/products/${p.slug}/onboarding?step=1`}>{t("Edit in onboarding →")}</Link>}>
          <KV
            items={[
              [t("Domain"), p.domain],
              [t("Category"), p.category],
              [t("Status"), lbl(p.status)],
              [t("Release date"), p.releaseDate],
              [t("API available"), p.apiAvailable === null ? null : p.apiAvailable ? t("Yes") : t("No")],
              [t("Free trial"), p.freeTrial === null ? null : p.freeTrial ? t("Yes") : t("No")],
              [t("Languages"), p.languages.join(", ") || null],
              [t("Countries"), p.supportedCountries.join(", ") || null],
              [t("Short description"), p.shortDescription],
              [t("Documentation"), p.documentationUrl],
              [t("Conversion URLs"), p.conversionUrls.map((c) => c.label).join(", ") || null],
              [t("Last verified"), p.lastVerifiedAt?.toISOString().slice(0, 10) ?? t("Never — descriptions carry reduced confidence")],
            ]}
          />
          {can("content:approve") && (
            <form action={markProductVerifiedAction} className="mt-4">
              <HiddenBack path={back} />
              <input type="hidden" name="productId" value={p.id} />
              <Button>{t("I verified the core descriptions")}</Button>
            </form>
          )}
        </Panel>
        <Panel title={t("{pct}% complete", { pct: Math.round(completeness.score * 100) })} eyebrow={t("Entity completeness")}>
          <ul className="flex flex-col gap-2">
            {completeness.missing.slice(0, 10).map((m) => (
              <li key={m.key} className="text-xs">
                <span className={m.status === "missing" ? "text-crit" : "text-warn"}>{m.status === "missing" ? "✕" : "◐"}</span> <span className="text-platinum">{t(m.label)}</span> <span className="text-muted">— {t(m.hint)}</span>
              </li>
            ))}
            {!completeness.missing.length && <li className="text-sm text-ok">{t("✓ All tracked entity facts present.")}</li>}
          </ul>
        </Panel>
      </div>

      <Panel title={t("Canonical sources")} eyebrow={t("Proof / sources")} className="mt-6" actions={<Link className="eyebrow hover:text-chrome" href={`/products/${p.slug}/onboarding?step=11`}>{t("Edit →")}</Link>}>
        {g.sources.length ? (
          <ul className="grid gap-2 md:grid-cols-2">
            {g.sources.map((s) => (
              <li key={s.id} className="flex items-center gap-2 text-sm">
                <Badge>{lbl(s.kind)}</Badge>
                <a href={s.url} target="_blank" rel="noreferrer noopener" className="truncate text-chrome underline-offset-4 hover:underline">
                  {s.title}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">{t("No sources. Every public claim should trace back to a canonical URL.")}</p>
        )}
      </Panel>

      {kinds.map((kind) => {
        const list = g.facets.filter((f) => f.kind === kind);
        return (
          <Panel key={kind} title={t(FACET_LABELS[kind].plural)} eyebrow={t("{n} item(s)", { n: list.length })} className="mt-6" pad={false}>
            {list.length ? (
              <Table>
                <thead>
                  <tr>
                    <Th>{t("Name")}</Th>
                    <Th>{t("Description")}</Th>
                    <Th>{t("Verification & source")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((f) => (
                    <tr key={f.id}>
                      <Td className="whitespace-nowrap text-platinum">{f.name}</Td>
                      <Td className="max-w-xl text-xs">{f.description ?? <span className="text-muted">{t("No description")}</span>}</Td>
                      <Td>
                        <VerifyControls kind="facet" id={f.id} back={back} current={f.verification} sources={g.sources} sourceId={f.sourceId} editable={editable} t={t} />
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            ) : (
              <p className="p-4 text-sm text-muted">{t("Unknown — none recorded.")}</p>
            )}
          </Panel>
        );
      })}

      <Panel title={t("Pricing")} eyebrow={t("Plans")} className="mt-6" pad={false}>
        {g.pricing.length ? (
          <Table>
            <thead>
              <tr>
                <Th>{t("Plan")}</Th>
                <Th>{t("Price")}</Th>
                <Th>{t("Trial")}</Th>
                <Th>{t("Verification & source")}</Th>
              </tr>
            </thead>
            <tbody>
              {g.pricing.map((x) => (
                <tr key={x.id}>
                  <Td className="text-platinum">{x.planName}</Td>
                  <Td className="num">{x.priceCents === null ? <span className="text-muted">{t("not public")}</span> : `${formatMoney(x.priceCents, x.currency, intl)} / ${lbl(x.interval).toLocaleLowerCase(intl)}`}</Td>
                  <Td className="num">{x.trialDays ? t("{n} days", { n: x.trialDays }) : "—"}</Td>
                  <Td>
                    <VerifyControls kind="pricing" id={x.id} back={back} current={x.verification} sources={g.sources} sourceId={x.sourceId} editable={editable} t={t} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="p-4 text-sm text-muted">{t("Pricing unknown.")}</p>
        )}
      </Panel>

      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Panel title={t("FAQ")} eyebrow={t("{n} entries", { n: g.faqs.length })}>
          <ul className="flex flex-col gap-4">
            {g.faqs.map((f) => (
              <li key={f.id} className="border-b border-line/60 pb-3">
                <div className="text-sm text-platinum">{f.question}</div>
                <div className="mt-1 text-xs text-chrome">{f.answer}</div>
                <div className="mt-2">
                  <VerifyControls kind="faq" id={f.id} back={back} current={f.verification} sources={g.sources} sourceId={f.sourceId} editable={editable} t={t} />
                </div>
              </li>
            ))}
          </ul>
          {editable && (
            <form action={addFaqAction} className="mt-4 flex flex-col gap-3">
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
                  <option value="">{t("No source")}</option>
                  {g.sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
                </select>
              </Field>
              <div>
                <Button>{t("Add FAQ")}</Button>
              </div>
            </form>
          )}
        </Panel>

        <Panel title={t("Proof")} eyebrow={t("Testimonials · case studies · metrics")}>
          <ul className="flex flex-col gap-4">
            {g.proofs.map((pr) => (
              <li key={pr.id} className="border-b border-line/60 pb-3">
                <div className="flex items-center gap-2">
                  <Badge>{lbl(pr.kind)}</Badge>
                  <span className="text-sm text-platinum">{pr.title}</span>
                  {pr.publishable ? <Badge tone="ok">{t("publishable")}</Badge> : <Badge tone="muted">{t("internal only")}</Badge>}
                </div>
                <div className="mt-1 text-xs text-chrome">{pr.content}</div>
                {pr.attribution && <div className="text-xs text-muted">— {pr.attribution}</div>}
                <div className="mt-2">
                  <VerifyControls kind="proof" id={pr.id} back={back} current={pr.verification} sources={g.sources} sourceId={pr.sourceId} editable={editable} t={t} />
                </div>
              </li>
            ))}
            {!g.proofs.length && <li className="text-sm text-muted">{t("No proof recorded. Beacon never invents customers, testimonials or metrics.")}</li>}
          </ul>
          {editable && (
            <form action={addProofAction} className="mt-4 grid gap-3 sm:grid-cols-2">
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
                  <option value="">{t("No source")}</option>
                  {g.sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.title}
                    </option>
                  ))}
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
                  <label className="flex items-center gap-1 text-xs text-chrome">
                    <input type="checkbox" name="verified" /> {t("verified")}
                  </label>
                  <Button>{t("Add")}</Button>
                </form>
              )}
            </div>
          ))}
        </div>
      </Panel>

      <Panel title={t("Changelog")} eyebrow={t("Releases")} className="mt-6">
        <ul className="flex flex-col gap-2">
          {g.changelog.map((c) => (
            <li key={c.id} className="flex items-start justify-between gap-3 border-b border-line/60 pb-2 text-sm">
              <div>
                <span className="num text-xs text-muted">{c.releasedOn}</span> {c.version && <Badge>{c.version}</Badge>} <span className="text-platinum">{c.title}</span>
                {c.body && <div className="text-xs text-chrome">{c.body}</div>}
              </div>
              {editable && (
                <form action={deleteKnowledgeAction}>
                  <HiddenBack path={back} />
                  <input type="hidden" name="kind" value="changelog" />
                  <input type="hidden" name="id" value={c.id} />
                  <button className="eyebrow hover:text-crit">✕</button>
                </form>
              )}
            </li>
          ))}
          {!g.changelog.length && <li className="text-sm text-muted">{t("No releases recorded.")}</li>}
        </ul>
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
