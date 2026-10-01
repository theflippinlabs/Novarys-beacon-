import Link from "next/link";
import { decideRecommendationAction } from "@/app/actions/growth";
import { Badge, Button, HiddenBack, Panel, ResponsiveTable, StatusBadge, Td, Th, formatValue } from "@/components/ui";
import { executionActionFor, learningAdjustment, measureKindFor, type LoopStage, type MeasurementSnapshot, type RecommendationOutcome } from "@/core/autopilot/loop";
import { withOrg } from "@/db";
import { autopilotLoop, type LoopItem } from "@/services/autopilot";
import { learningTallies } from "@/services/autopilot-learning";
import { enumLabel } from "@/i18n/core";
import { getI18n } from "@/i18n/server";

const STAGES: LoopStage[] = ["PROPOSED", "APPROVED", "EXECUTING", "MEASURING", "MEASURED"];
const STEPS = ["OBSERVE", "ANALYZE", "IDENTIFY", "RECOMMEND", "APPROVE", "EXECUTE", "MEASURE", "LEARN"];

/**
 * The autopilot loop: proposals awaiting a human decision, what approval
 * executed (drafts, experiment drafts, audits, targets: never publication),
 * the measurement against the baseline (correlation, not causation) and what
 * the loop learned per opportunity type.
 */
export async function AutopilotLoop({ orgId, canDecide, back }: { orgId: string; canDecide: boolean; back: string }) {
  const { t, intl } = await getI18n();
  const { items, tallies } = await withOrg(orgId, async (tx) => ({ items: await autopilotLoop(tx, orgId), tallies: await learningTallies(tx, orgId) }));
  const by = (s: LoopStage) => items.filter((i) => i.stage === s);
  const proposed = by("PROPOSED");
  const active = items.filter((i) => i.stage === "APPROVED" || i.stage === "EXECUTING" || i.stage === "MEASURING");
  const measured = by("MEASURED").slice(0, 20);
  const n = (v: number) => formatValue(v, "count", undefined, intl);
  const recBody = (body: string) => {
    const m = /^From opportunity \((\w+), (\w+) potential\)\.$/.exec(body);
    return m ? t("From opportunity ({type}, {potential} potential).", { type: enumLabel(t, m[1]).toLocaleLowerCase(intl), potential: enumLabel(t, m[2]).toLocaleLowerCase(intl) }) : t(body);
  };
  const metricLabel = (k: string) => t(k === "clicks" ? "Search clicks" : k === "impressions" ? "Search impressions" : k === "conversions" ? "Conversions" : "AI-assistant referrals");
  const snapshot = (s: MeasurementSnapshot | null) =>
    !s ? (
      <span className="text-muted">{t("n/a")}</span>
    ) : s.state !== "OK" ? (
      <span className="text-muted">{s.state === "NOT_CONNECTED" ? t("Not connected") : t("No data yet")}</span>
    ) : (
      <span>
        {s.metrics.map((m) => `${metricLabel(m.key)} ${n(m.value)}`).join(" · ")}
        <span className="block text-[10px] text-muted">
          {s.window.start} → {s.window.end} · {t(s.source)}
        </span>
      </span>
    );
  const outcome = (o: RecommendationOutcome) => (
    <div className="text-xs">
      <Badge tone={o.label === "IMPROVED" ? "ok" : o.label === "DECLINED" ? "crit" : o.label === "NO_CHANGE" ? "neutral" : "muted"}>{enumLabel(t, o.label)}</Badge>
      <div className="mt-1 text-chrome">
        {o.before !== null && o.after !== null
          ? t("{metric}: {before} → {after}", { metric: metricLabel(o.primary), before: n(o.before), after: n(o.after) }) + (o.change !== null ? ` (${o.change > 0 ? "+" : ""}${Math.round(o.change * 100)}%)` : "")
          : o.reason === "NOT_CONNECTED"
            ? t("Not connected")
            : o.reason === "LOW_VOLUME"
              ? t("Volume too low to interpret")
              : t("No data yet")}
      </div>
      <div className="mt-1 text-[10px] text-muted">{t(o.note)}</div>
    </div>
  );
  const artefacts = (i: LoopItem) => (
    <ul className="flex flex-col gap-1 text-xs">
      {i.artefacts.map((a, k) => (
        <li key={k}>
          {a.status === "SKIPPED" ? (
            <span className="text-warn" title={a.reason ? t(a.reason) : undefined}>
              ✕ {t(a.label)}
              {a.reason ? `: ${t(a.reason)}` : ""}
            </span>
          ) : (
            <Link href={a.href} className="text-blue-bright hover:text-cyan">
              {t(a.type === "content_asset" ? "Draft" : a.type === "experiment" ? "Experiment" : a.type === "seo_audit" ? "Audit" : a.type === "distribution_target" ? "Target" : "Task")}: {t(a.label)}
            </Link>
          )}
          {a.currentStatus && (
            <span className="ml-1 align-middle">
              <StatusBadge status={a.currentStatus} />
            </span>
          )}
        </li>
      ))}
      {!i.artefacts.length && <li className="text-muted">{t("Nothing executed yet.")}</li>}
    </ul>
  );

  return (
    <Panel title={t("Autopilot loop")} eyebrow={t("Observe → analyze → identify → recommend → approve → execute → measure → learn")} className="mt-6" pad={false}>
      <div className="flex flex-wrap gap-1 border-b border-line px-4 py-3" aria-label={t("Loop steps")}>
        {STEPS.map((s, i) => (
          <span key={s} className="font-mono text-[10px] uppercase tracking-wider text-muted">
            {enumLabel(t, s)}
            {i < STEPS.length - 1 ? " →" : ""}
          </span>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 border-b border-line p-4 sm:grid-cols-5">
        {STAGES.map((s) => (
          <div key={s} className="border border-line px-3 py-2">
            <div className="eyebrow">{enumLabel(t, s)}</div>
            <div className="num text-lg text-platinum">{by(s).length}</div>
          </div>
        ))}
      </div>

      <div className="px-4 pt-4">
        <div className="eyebrow mb-2">{t("{n} recommendation(s) awaiting a decision", { n: proposed.length })}</div>
      </div>
      {proposed.length ? (
        <ResponsiveTable>
          <thead>
            <tr>
              <Th>{t("Recommendation")}</Th>
              <Th>{t("On approval")}</Th>
              <Th>{t("Measured by")}</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {proposed.map((r) => (
              <tr key={r.id} id={`rec-${r.id}`}>
                <Td primary label={t("Recommendation")}>
                  <div className="flex flex-wrap gap-1">
                    <Badge tone="muted">{enumLabel(t, r.kind)}</Badge>
                    {r.productName && <Badge tone="muted">{r.productName}</Badge>}
                  </div>
                  <div className="mt-1 text-platinum">{t(r.title)}</div>
                  <div className="text-xs text-muted">{recBody(r.body)}</div>
                  {r.opportunityId && (
                    <Link href={`/opportunities/${r.opportunityId}`} className="text-[11px] text-blue-bright hover:text-cyan">
                      {t("Open the opportunity")}
                    </Link>
                  )}
                </Td>
                <Td label={t("On approval")} className="text-xs">
                  {enumLabel(t, executionActionFor(r.kind))}
                  <div className="text-[10px] text-muted">{t("Never published or submitted automatically.")}</div>
                </Td>
                <Td label={t("Measured by")} className="text-xs">
                  {enumLabel(t, measureKindFor(r.kind))}
                </Td>
                <Td label={t("Decision")}>
                  {canDecide && (
                    <form action={decideRecommendationAction} className="flex flex-wrap gap-2">
                      <HiddenBack path={back} />
                      <input type="hidden" name="id" value={r.id} />
                      <Button name="status" value="APPROVED">
                        {t("Approve")}
                      </Button>
                      <Button name="status" value="REJECTED" variant="danger">
                        {t("Reject")}
                      </Button>
                    </form>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </ResponsiveTable>
      ) : (
        <p className="px-4 pb-4 text-sm text-muted">{t("Nothing to decide.")}</p>
      )}

      <div className="border-t border-line px-4 pt-4">
        <div className="eyebrow mb-2">{t("Approved, executing and measuring")}</div>
      </div>
      {active.length ? (
        <ResponsiveTable>
          <thead>
            <tr>
              <Th>{t("Recommendation")}</Th>
              <Th>{t("Stage")}</Th>
              <Th>{t("Executed")}</Th>
              <Th>{t("Baseline")}</Th>
              <Th>{t("Measured on")}</Th>
            </tr>
          </thead>
          <tbody>
            {active.map((r) => (
              <tr key={r.id} id={`rec-${r.id}`}>
                <Td primary label={t("Recommendation")}>
                  <div className="text-platinum">{t(r.title)}</div>
                  <div className="flex flex-wrap gap-1">
                    <Badge tone="muted">{enumLabel(t, r.kind)}</Badge>
                    {r.productName && <Badge tone="muted">{r.productName}</Badge>}
                  </div>
                  {r.executionError && <div className="mt-1 text-[11px] text-warn">{t("Part of the execution needs attention.")}</div>}
                </Td>
                <Td label={t("Stage")}>
                  <Badge tone={r.stage === "MEASURING" ? "gold" : "neutral"}>{enumLabel(t, r.stage)}</Badge>
                </Td>
                <Td label={t("Executed")}>{artefacts(r)}</Td>
                <Td label={t("Baseline")} className="text-xs">
                  {snapshot(r.baseline)}
                </Td>
                <Td label={t("Measured on")} className="num text-xs">
                  {r.measureAfter ?? t("n/a")}
                </Td>
              </tr>
            ))}
          </tbody>
        </ResponsiveTable>
      ) : (
        <p className="px-4 pb-4 text-sm text-muted">{t("Nothing in progress.")}</p>
      )}

      <div className="border-t border-line px-4 pt-4">
        <div className="eyebrow mb-2">{t("Measured outcomes")}</div>
      </div>
      {measured.length ? (
        <ResponsiveTable>
          <thead>
            <tr>
              <Th>{t("Recommendation")}</Th>
              <Th>{t("Outcome")}</Th>
              <Th>{t("Windows")}</Th>
            </tr>
          </thead>
          <tbody>
            {measured.map((r) => (
              <tr key={r.id}>
                <Td primary label={t("Recommendation")}>
                  <div className="text-platinum">{t(r.title)}</div>
                  {r.productName && <Badge tone="muted">{r.productName}</Badge>}
                </Td>
                <Td label={t("Outcome")}>{r.outcome ? outcome(r.outcome) : null}</Td>
                <Td label={t("Windows")} className="num text-[11px] text-muted">
                  {r.outcome?.baselineWindow && t("Baseline {start} → {end}", { start: r.outcome.baselineWindow.start, end: r.outcome.baselineWindow.end })}
                  {r.outcome?.measuredWindow && <div>{t("After {start} → {end}", { start: r.outcome.measuredWindow.start, end: r.outcome.measuredWindow.end })}</div>}
                </Td>
              </tr>
            ))}
          </tbody>
        </ResponsiveTable>
      ) : (
        <p className="px-4 pb-4 text-sm text-muted">{t("No outcome measured yet: each approved recommendation is measured {days} days after execution.", { days: 28 })}</p>
      )}

      <div className="border-t border-line p-4">
        <div className="eyebrow mb-2">{t("What the loop learned")}</div>
        {Object.keys(tallies).length ? (
          <ul className="flex flex-col gap-1 text-xs text-chrome">
            {Object.entries(tallies).map(([type, tally]) => {
              const adj = learningAdjustment(tally);
              return (
                <li key={type}>
                  <Badge tone="muted">{enumLabel(t, type)}</Badge>{" "}
                  {t("{improved} improved · {noChange} unchanged · {declined} declined · {insufficient} without enough data", { improved: tally.improved, noChange: tally.noChange, declined: tally.declined, insufficient: tally.insufficient ?? 0 })}
                  {" · "}
                  <span className={adj.delta > 0 ? "text-ok" : adj.delta < 0 ? "text-crit" : "text-muted"}>{t("confidence {delta}", { delta: adj.delta > 0 ? "+1" : adj.delta < 0 ? "-1" : "±0" })}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-sm text-muted">{t("No measured outcome yet. Confidence factors stay as computed until at least three outcomes per opportunity type are measured.")}</p>
        )}
        <p className="mt-3 text-[11px] text-muted">{t("Outcomes compare the target metric after execution with the baseline recorded at approval. Correlation, not causation: the adjustment moves an opportunity type's confidence by one point at most.")}</p>
      </div>
    </Panel>
  );
}
