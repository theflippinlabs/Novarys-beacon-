import Link from "next/link";
import { Badge, Panel, StatusBadge } from "@/components/ui";
import { ImpactSummary } from "@/components/estimate/estimate-view";
import { SPECIALISTS, type CoverageMap } from "@/brain/types";
import { getI18n } from "@/i18n/server";
import { pageData } from "@/lib/page";
import { activeRun, latestDoneRun, runFindings } from "@/services/brain";
import { coverageLabel, coverageTone, specialistLabel } from "./labels";

/** Compact latest-Brain card for the overview (loads its own data). */
export async function LatestBrain() {
  const { t, locale } = await getI18n();
  const { data } = await pageData(async (tx, ctx) => {
    const latest = await latestDoneRun(tx, ctx.org.id);
    const active = await activeRun(tx, ctx.org.id);
    const findings = latest ? await runFindings(tx, ctx.org.id, latest.id) : null;
    return { latest, active, top: findings ? [...findings.ranked.slice(0, 3), ...(findings.ranked.length < 3 ? findings.unestimated.slice(0, 3 - findings.ranked.length) : [])] : [] };
  });
  const latest = data.latest;
  const coverage = (latest?.coverage ?? {}) as Partial<CoverageMap>;
  const summary = latest?.executiveSummary ?? null;
  return (
    <Panel
      eyebrow={t("Beacon Brain")}
      title={latest ? t("Latest ranked plan") : t("No Brain run yet")}
      className="mb-6"
      actions={
        <Link href="/brain" className="eyebrow text-blue-bright hover:text-cyan">
          {t("Open the Brain")}
        </Link>
      }
    >
      {!latest ? (
        <p className="text-sm text-muted">{data.active ? t("The first Brain run is in progress.") : t("The Brain runs every week, or on demand from its page.")}</p>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap gap-1.5">
            {SPECIALISTS.map((k) => {
              const level = coverage[k]?.coverage ?? "NOT_CONNECTED";
              return (
                <Badge key={k} tone={coverageTone(level)} title={coverageLabel(t, level)}>
                  {specialistLabel(t, k)}: {coverageLabel(t, level)}
                </Badge>
              );
            })}
          </div>
          {summary && (
            <p className="text-sm text-chrome">
              <Badge tone="gold">{t("AI-written")}</Badge> {locale === "fr" ? summary.fr : summary.en}
            </p>
          )}
          {data.top.length ? (
            <ol className="flex flex-col">
              {data.top.map((f, i) => (
                <li key={f.id} className="flex flex-col gap-2 border-b border-line/60 py-2 last:border-0 md:flex-row md:items-center md:justify-between">
                  <Link href={`/brain#finding-${f.id}`} className="flex min-w-0 items-start gap-3 hover:text-platinum">
                    <span className="num w-6 pt-0.5 text-xs text-muted">{String(i + 1).padStart(2, "0")}</span>
                    <span className="min-w-0">
                      <span className="block text-sm text-platinum">{t(f.title, f.vars)}</span>
                      <span className="mt-0.5 inline-block">
                        <StatusBadge status={f.severity} />
                      </span>
                    </span>
                  </Link>
                  {f.estimable && f.estimate && <ImpactSummary impact={f.estimate} />}
                </li>
              ))}
            </ol>
          ) : (
            <p className="text-sm text-muted">{t("The latest run found nothing to act on.")}</p>
          )}
        </div>
      )}
    </Panel>
  );
}
