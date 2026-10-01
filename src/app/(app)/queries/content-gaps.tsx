import { gapDraftAction, gapOpportunityAction } from "@/app/actions/intel";
import { Badge, Button, HiddenBack, Panel, StatusBadge } from "@/components/ui";
import type { ContentGap } from "@/core/content/gaps";
import { enumLabel } from "@/i18n/core";
import { getT } from "@/i18n/server";

const REASON_LABEL: Record<string, string> = {
  DEMAND_WITHOUT_RANKING: "Search impressions without a ranking page",
  UNCOVERED_RELEVANT: "Business-relevant and not fully covered",
  AI_COMPETITOR_ONLY: "Competitors appear in sampled AI answers, the product does not",
  NO_PILLAR: "No pillar page for this cluster",
};

/** Content gaps as mobile-friendly cards, one per query cluster, with their evidence and two actions. */
export async function ContentGaps({ gaps, productId, productName, back, canGrowth, canContent }: { gaps: ContentGap[]; productId: string; productName: string; back: string; canGrowth: boolean; canContent: boolean }) {
  const t = await getT();
  return (
    <Panel title={t("Content gaps · {product}", { product: productName })} eyebrow={t("One recommended asset per cluster")} className="mt-6" pad={false}>
      <div id="gaps" />
      {gaps.length === 0 ? (
        <p className="p-4 text-sm text-muted">{t("No content gap: every relevant cluster is covered, or there is no measured evidence yet.")}</p>
      ) : (
        <ul className="grid gap-3 p-4 md:grid-cols-2">
          {gaps.map((g) => (
            <li key={g.clusterId} id={`gap-${g.clusterId}`} className="flex min-w-0 flex-col gap-3 border border-line bg-obsidian/40 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <StatusBadge status={g.coverage.status} />
                <Badge tone={g.relevance.level === "HIGH" ? "gold" : "neutral"}>{t("{level} relevance", { level: t(g.relevance.level) })}</Badge>
                <Badge tone="muted">{enumLabel(t, g.intent)}</Badge>
                <Badge tone="muted">{enumLabel(t, g.topicType)}</Badge>
              </div>
              <div className="break-words text-base text-platinum">{g.clusterName}</div>
              <ul className="flex flex-col gap-1 text-xs text-chrome">
                {g.reasons.map((r) => (
                  <li key={r}>• {t(REASON_LABEL[r] ?? r)}</li>
                ))}
              </ul>
              <dl className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-2">
                <div className="min-w-0">
                  <dt className="eyebrow">{t("Recommended asset")}</dt>
                  <dd className="text-chrome">{enumLabel(t, g.recommendedAsset)}</dd>
                  {g.supportingAssets.length > 0 && <dd className="text-muted">{t("Supporting: {list}", { list: g.supportingAssets.map((a) => enumLabel(t, a)).join(", ") })}</dd>}
                </div>
                <div className="min-w-0">
                  <dt className="eyebrow">{t("Search demand")}</dt>
                  <dd className="text-chrome">
                    {g.demand.status === "MEASURED" ? t("{impressions} impressions, {clicks} clicks", { impressions: g.demand.impressions ?? 0, clicks: g.demand.clicks ?? 0 }) : t("Unknown (no search provider data)")}
                  </dd>
                </div>
                <div className="min-w-0">
                  <dt className="eyebrow">{t("Coverage evidence")}</dt>
                  <dd className="break-words text-chrome">{g.coverage.evidence ? t(g.coverage.evidence) : t("n/a")}</dd>
                </div>
                <div className="min-w-0">
                  <dt className="eyebrow">{t("Existing page")}</dt>
                  <dd className="break-all text-chrome">{g.existingPage ?? t("None")}</dd>
                </div>
                <div className="min-w-0 sm:col-span-2">
                  <dt className="eyebrow">{t("Business relevance")}</dt>
                  <dd className="text-chrome">{t(g.relevance.reason)}</dd>
                </div>
              </dl>
              {g.competitors.length > 0 && <p className="text-xs text-muted">{t("Competitors appearing: {list}", { list: g.competitors.join(" / ") })}</p>}
              <p className="num text-[11px] text-muted">
                {t("Sources: {queries} queries, {tests} sampled AI responses, {urls} URLs", { queries: g.sources.queryIds.length, tests: g.sources.testIds.length, urls: g.sources.urls.length })}
              </p>
              {(canGrowth || canContent) && (
                <div className="flex flex-wrap gap-2">
                  {canGrowth && (
                    <form action={gapOpportunityAction}>
                      <HiddenBack path={back} />
                      <input type="hidden" name="productId" value={productId} />
                      <input type="hidden" name="clusterId" value={g.clusterId} />
                      <Button>{t("Create opportunity")}</Button>
                    </form>
                  )}
                  {canContent && (
                    <form action={gapDraftAction}>
                      <HiddenBack path={back} />
                      <input type="hidden" name="productId" value={productId} />
                      <input type="hidden" name="clusterId" value={g.clusterId} />
                      <Button variant="gold">{t("Create draft")}</Button>
                    </form>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
