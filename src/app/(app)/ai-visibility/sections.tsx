import { competitorAliasesAction } from "@/app/actions/intel";
import { Badge, Button, HiddenBack, Panel } from "@/components/ui";
import { enumLabel } from "@/i18n/core";
import { getT } from "@/i18n/server";
import type { CitationDomainRow, CompetitorIntel } from "@/services/ai-visibility";

/** "Citation sources": which domains sampled AI answers cite, how often, for which products and prompts, and whether the product appears. */
export async function CitationSources({ domains, productName }: { domains: CitationDomainRow[]; productName: string | null }) {
  const t = await getT();
  return (
    <Panel title={t("Citation sources")} eyebrow={t("Domains cited in sampled responses · 90 days")} className="mt-6" pad={false}>
      {domains.length === 0 ? (
        <p className="p-4 text-sm text-muted">{t("No citations observed yet. Citations appear when providers return sources (web-grounded answers).")}</p>
      ) : (
        <ul className="grid gap-3 p-4 md:grid-cols-2 xl:grid-cols-3">
          {domains.slice(0, 30).map((d) => (
            <li key={d.domain} className="flex min-w-0 flex-col gap-2 border border-line bg-obsidian/40 p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="num break-all text-sm text-platinum">{d.domain}</span>
                <Badge tone={d.kind === "OWN" ? "ok" : d.kind === "COMPETITOR" ? "warn" : "neutral"}>{enumLabel(t, d.kind)}</Badge>
                <Badge tone="muted">{enumLabel(t, d.category)}</Badge>
              </div>
              <div className="text-chrome">{t("Cited in {x} of {y} sampled responses", { x: d.samplesCiting, y: d.samplesTotal })}</div>
              <div className={d.productAppears ? "text-ok" : "text-muted"}>
                {d.productAppears
                  ? t("{product} appears with this source", { product: productName ?? t("Your product") })
                  : t("{product} not associated with this source in the samples", { product: productName ?? t("Your products") })}
              </div>
              {d.products.length > 0 && <div className="text-muted">{t("Products: {list}", { list: d.products.join(", ") })}</div>}
              {d.competitors.length > 0 && <div className="text-muted">{t("Competitors associated: {list}", { list: d.competitors.join(", ") })}</div>}
              {d.prompts.length > 0 && (
                <details>
                  <summary className="cursor-pointer text-muted">{t("{n} prompt(s)", { n: d.prompts.length })}</summary>
                  <ul className="mt-1 flex flex-col gap-1 text-muted">
                    {d.prompts.slice(0, 5).map((p) => (
                      <li key={p}>{p}</li>
                    ))}
                  </ul>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="px-4 pb-4 text-[11px] text-muted">{t("Categories are a documented heuristic based on the host name. Beacon never contacts these sources automatically.")}</p>
    </Panel>
  );
}

/** Competitor intelligence from observed facts only: share of samples, cited domains, comparison facts and topics where competitors appear and we do not. */
export async function CompetitorSection({ items, subject, back, canEdit }: { items: CompetitorIntel[]; subject: string; back: string; canEdit: boolean }) {
  const t = await getT();
  return (
    <Panel title={t("Competitors in sampled answers")} eyebrow={t("Where do competitors have discovery coverage that we do not?")} className="mt-6" pad={false}>
      {items.length === 0 ? (
        <p className="p-4 text-sm text-muted">{t("No competitor registered or observed yet.")}</p>
      ) : (
        <ul className="grid gap-3 p-4 lg:grid-cols-2">
          {items.map((c) => (
            <li key={c.competitor.id} className="flex min-w-0 flex-col gap-2 border border-line bg-obsidian/40 p-3 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-platinum">{c.competitor.name}</span>
                {c.competitor.domain && <span className="num text-muted">{c.competitor.domain}</span>}
              </div>
              <div className="text-chrome">{c.samplesTotal ? t("Observed in {x} of {y} sampled responses", { x: c.samplesMentioning, y: c.samplesTotal }) : t("No sampled response yet")}</div>
              {c.ownDomainCitedIn > 0 && <div className="text-chrome">{t("Own domain cited in {n} sampled responses", { n: c.ownDomainCitedIn })}</div>}
              {c.citedDomains.length > 0 && <div className="text-muted">{t("Sources cited with it: {list}", { list: c.citedDomains.map((d) => `${d.domain} (${d.samples})`).join(", ") })}</div>}
              {c.comparisonFacts.map((f) => (
                <div key={f.productName} className={f.sourced >= 3 ? "text-ok" : "text-warn"}>
                  {t("Sourced comparison facts with {product}: {n}/3", { product: f.productName, n: f.sourced })}
                </div>
              ))}
              {c.gaps.length > 0 && (
                <div>
                  <div className="eyebrow mb-1">{t("Observed where {subject} was not", { subject })}</div>
                  <ul className="flex flex-col gap-1">
                    {c.gaps.map((g) => (
                      <li key={g.promptId} className="text-chrome">
                        <a href={`#prompt-${g.promptId}`} className="hover:text-blue-bright">
                          {g.prompt}
                        </a>{" "}
                        <span className="num text-muted">{t("({x} of {y} samples)", { x: g.competitorSamples, y: g.samples })}</span>
                        {g.clusters.length > 0 && <div className="text-muted">{t("Clusters: {list}", { list: g.clusters.join(", ") })}</div>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {canEdit && (
                <form action={competitorAliasesAction} className="mt-1 flex flex-wrap items-end gap-2">
                  <HiddenBack path={back} />
                  <input type="hidden" name="competitorId" value={c.competitor.id} />
                  <label className="flex min-w-0 flex-1 flex-col gap-1">
                    <span className="eyebrow">{t("Aliases (comma separated)")}</span>
                    <input name="aliases" defaultValue={c.competitor.aliases.join(", ")} maxLength={2000} />
                  </label>
                  <Button>{t("Save")}</Button>
                </form>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="px-4 pb-4 text-[11px] text-muted">{t("Observed facts from sampled responses only; samples are not totals and say nothing about the quality of any product.")}</p>
    </Panel>
  );
}
