import Link from "next/link";
import { proposeBrainFindingAction } from "@/app/actions/brain";
import { Badge, HiddenBack, StatusBadge } from "@/components/ui";
import { ImpactEstimateView, ImpactSummary } from "@/components/estimate/estimate-view";
import { getI18n } from "@/i18n/server";
import type { BrainFindingRow } from "@/services/brain";
import { specialistLabel } from "./labels";

/** One Brain finding: rank, severity, area, evidence, estimate with "How this was estimated", and its actions. */
export async function FindingCard({ f, canPropose, back }: { f: BrainFindingRow; canPropose: boolean; back: string }) {
  const { t } = await getI18n();
  return (
    <li id={`finding-${f.id}`} className="border-b border-line/60 p-4 last:border-0">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="flex min-w-0 gap-3">
          <span className="num w-7 shrink-0 pt-0.5 text-sm text-gold">{String(f.rank).padStart(2, "0")}</span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <StatusBadge status={f.severity} />
              <Badge tone="muted">{specialistLabel(t, f.specialist)}</Badge>
              {f.alsoFrom.map((s) => (
                <Badge key={s} tone="muted">
                  {specialistLabel(t, s)}
                </Badge>
              ))}
            </div>
            <div className="mt-1.5 text-sm font-medium text-platinum">{t(f.title, f.vars)}</div>
            <p className="mt-1 text-xs text-chrome">{t(f.summary, f.vars)}</p>
          </div>
        </div>
        {f.estimate && <ImpactSummary impact={f.estimate} />}
      </div>
      <div className="mt-3 grid gap-3 md:pl-10 lg:grid-cols-2">
        <div className="min-w-0">
          <div className="eyebrow mb-1">{t("Evidence")}</div>
          <ul className="flex flex-col gap-1 text-xs">
            {f.evidence.map((e, i) => (
              <li key={`${e.label}-${i}`} className="flex min-w-0 flex-wrap gap-x-2">
                <span className="text-muted">{t(e.label)}</span>
                {e.href ? (
                  <Link href={e.href} className="num break-all text-blue-bright hover:text-cyan">
                    {t(e.value)}
                  </Link>
                ) : (
                  <span className="num break-all text-platinum">{t(e.value)}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div className="min-w-0">
          {f.estimate ? (
            <details>
              <summary className="cursor-pointer text-[11px] text-chrome hover:text-blue-bright">{t("How this was estimated")}</summary>
              <div className="mt-3">
                <ImpactEstimateView impact={f.estimate} />
              </div>
            </details>
          ) : (
            <p className="text-[11px] text-muted">{t("No estimator applies to this action.")}</p>
          )}
        </div>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2 md:pl-10">
        <Link href={f.action.href} className="inline-flex min-h-10 items-center border border-line-strong px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-platinum hover:border-blue-bright md:min-h-0">
          {t(f.action.label)}
        </Link>
        {canPropose && (
          <form action={proposeBrainFindingAction}>
            <HiddenBack path={back} />
            <input type="hidden" name="id" value={f.id} />
            <button className={`inline-flex min-h-10 items-center border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] md:min-h-0 ${f.action.kind === "PROPOSE_RECOMMENDATION" ? "border-gold bg-gradient-to-b from-gold-bright to-gold text-obsidian" : "border-line-strong text-chrome hover:border-blue-bright"}`} title={t("Creates a recommendation that waits for human approval in Autopilot.")}>
              {t("Propose")}
            </button>
          </form>
        )}
      </div>
    </li>
  );
}
