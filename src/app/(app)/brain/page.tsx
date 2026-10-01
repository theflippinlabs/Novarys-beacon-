import Link from "next/link";
import type { Metadata } from "next";
import { count, eq } from "drizzle-orm";
import { runBrainAction } from "@/app/actions/brain";
import { Badge, Button, EmptyState, Flash, HiddenBack, PageHeader, Panel, ResponsiveTable, StatusBadge, Td, Th } from "@/components/ui";
import { AutoRefresh } from "@/components/ui/auto-refresh";
import { FindingCard } from "@/components/brain/finding-card";
import { coverageLabel, coverageTone, specialistLabel, triggerLabel } from "@/components/brain/labels";
import { SPECIALISTS, type CoverageMap } from "@/brain/types";
import { products } from "@/db/schema";
import { pageData, type SP } from "@/lib/page";
import { activeRun, latestDoneRun, runFindings, runHistory } from "@/services/brain";
import { getI18n, getT } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Beacon Brain") };
}

const fmt = (d: Date | null, intl: string) => (d ? new Date(d).toLocaleString(intl, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) : null);

export default async function BrainPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { t, intl, locale } = await getI18n();
  const { data, can } = await pageData(async (tx, ctx) => {
    const org = ctx.org.id;
    const [{ n: productCount }] = await tx.select({ n: count() }).from(products).where(eq(products.organizationId, org));
    const history = await runHistory(tx, org, 10);
    const active = await activeRun(tx, org);
    const latest = await latestDoneRun(tx, org);
    const findings = latest ? await runFindings(tx, org, latest.id) : { ranked: [], unestimated: [] };
    return { productCount: Number(productCount), history, active, latest, findings };
  });
  const back = "/brain";
  const runForm = can("job:run") ? (
    <form action={runBrainAction}>
      <HiddenBack path={back} />
      <Button variant="gold" disabled={Boolean(data.active)}>
        {data.active ? t("Run in progress") : t("Run now")}
      </Button>
    </form>
  ) : null;
  const latest = data.latest;
  const coverage = (latest?.coverage ?? {}) as Partial<CoverageMap>;
  const levels = SPECIALISTS.map((k) => coverage[k]?.coverage ?? "NOT_CONNECTED");
  const power = latest?.estimationPower ?? null;
  const summary = latest?.executiveSummary ?? null;
  const narrative = (k: (typeof SPECIALISTS)[number]) => {
    const n = latest?.narratives?.[k];
    return n ? (locale === "fr" ? n.fr : n.en) : null;
  };
  const first = data.findings.ranked[0] ?? data.findings.unestimated[0] ?? null;

  return (
    <>
      <PageHeader
        eyebrow={t("Brain")}
        title={t("Beacon Brain")}
        description={t("Six specialists analyse every area of growth on your measured data, estimators compute the expected impact of each action with an interval, and one ranked plan comes out. Nothing is invented: what cannot be measured is shown as such, and people approve every impactful action.")}
        actions={runForm}
      />
      <Flash searchParams={sp} />

      {data.active && (
        <div role="status" className="mb-6 flex flex-wrap items-center gap-2 border border-line-strong px-4 py-3 text-sm text-chrome">
          <StatusBadge status={data.active.status} />
          {t("A Brain run started {date} is in progress. This page refreshes when it finishes.", { date: fmt(data.active.createdAt, intl) ?? "" })}
          <AutoRefresh seconds={5} />
        </div>
      )}

      {!latest ? (
        data.productCount === 0 ? (
          <EmptyState
            variant="not_generated"
            what={t("No product to analyse yet")}
            why={t("The Brain analyses the products of your organisation. Add a product first; the Brain then runs every week.")}
            action={{ label: t("Open products"), href: "/products" }}
          />
        ) : (
          <EmptyState
            variant="not_generated"
            what={t("No Brain run yet")}
            why={t("The Brain runs every week for organisations with a product, or on demand. Without an Anthropic key it runs fully deterministically.")}
            action={can("job:run") ? { label: t("Run now"), form: { action: runBrainAction, back } } : { label: t("Open the overview"), href: "/" }}
          />
        )
      ) : (
        <>
          <p className="mb-4 text-xs text-muted">
            {t("Latest run: {date} ({trigger})", { date: fmt(latest.finishedAt, intl) ?? "", trigger: triggerLabel(t, latest.trigger) })}
          </p>

          <section aria-label={t("Coverage")} className="mb-6 grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {SPECIALISTS.map((k) => {
              const c = coverage[k];
              const level = c?.coverage ?? "NOT_CONNECTED";
              const n = narrative(k);
              return (
                <div key={k} className="flex min-w-0 flex-col gap-2 border border-line bg-panel p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-platinum">{specialistLabel(t, k)}</span>
                    <Badge tone={coverageTone(level)}>{coverageLabel(t, level)}</Badge>
                  </div>
                  <div className="num text-[11px] text-muted">{t("{n} finding(s)", { n: c?.findings ?? 0 })}</div>
                  {c?.missing.length ? (
                    <div className="text-xs">
                      <span className="text-muted">{t("To raise coverage:")}</span>{" "}
                      <span className="text-blue-bright">{c.missing.map((m) => t(m)).join(", ")}</span>
                    </div>
                  ) : null}
                  {n && (
                    <p className="border-t border-line pt-2 text-xs text-chrome">
                      <Badge tone="gold">{t("AI-written")}</Badge> {n}
                    </p>
                  )}
                </div>
              );
            })}
          </section>

          <div className="mb-6 grid gap-6 xl:grid-cols-[1fr_22rem]">
            <Panel eyebrow={t("Executive summary")} title={summary ? t("Written by the AI from the findings below") : t("Computed from the findings below")}>
              <div className="mb-3">
                <Badge tone={summary ? "gold" : "neutral"}>{summary ? t("AI-written") : t("Deterministic")}</Badge>
              </div>
              {summary ? (
                <>
                  <p className="text-sm text-chrome">{locale === "fr" ? summary.fr : summary.en}</p>
                  <p className="mt-3 text-[11px] text-muted">{t("Checked before saving: every number in this summary comes from the evidence and estimates of the findings.")}</p>
                </>
              ) : (
                <ul className="flex flex-col gap-2 text-sm text-chrome">
                  <li>
                    {t("{measured} of {total} areas measured, {partial} partial, {none} not connected.", {
                      measured: levels.filter((l) => l === "MEASURED").length,
                      total: SPECIALISTS.length,
                      partial: levels.filter((l) => l === "PARTIAL").length,
                      none: levels.filter((l) => l === "NOT_CONNECTED").length,
                    })}
                  </li>
                  <li>{t("{ranked} action(s) with an estimated impact, {unestimated} finding(s) that cannot be estimated yet.", { ranked: latest.rankedCount, unestimated: latest.unestimatedCount })}</li>
                  {first && <li>{t("First action: {title}", { title: t(first.title, first.vars) })}</li>}
                  {latest.llmUsage?.skipped && <li className="text-xs text-muted">{t("AI narrative not used: {reason}", { reason: t(latest.llmUsage.skipped) })}</li>}
                </ul>
              )}
            </Panel>
            <Panel eyebrow={t("Estimation power")} title={power?.bestNextConnection ? t("Connect {connect} to estimate {n} more action(s)", { connect: t(power.bestNextConnection.connect), n: power.bestNextConnection.unlocks }) : t("What the estimators can use")}>
              <div className="flex flex-col gap-3 text-xs">
                <div>
                  <div className="eyebrow mb-1">{t("Measured inputs")}</div>
                  <div className="text-chrome">{power?.measured.length ? power.measured.map((m) => t(m)).join(", ") : t("none")}</div>
                </div>
                <div>
                  <div className="eyebrow mb-1">{t("Missing inputs")}</div>
                  <div className="text-blue-bright">{power?.missing.length ? power.missing.map((m) => t(m)).join(", ") : t("none")}</div>
                </div>
                {power?.bestNextConnection && (
                  <Link href="/settings/integrations" className="eyebrow text-blue-bright hover:text-cyan">
                    {t("Open integrations")}
                  </Link>
                )}
              </div>
            </Panel>
          </div>

          <Panel eyebrow={t("Ranked plan")} title={t("Actions ranked by expected extra signups")} pad={false} className="mb-6">
            {data.findings.ranked.length ? (
              <ol>
                {data.findings.ranked.map((f) => (
                  <FindingCard key={f.id} f={f} canPropose={can("growth:write")} back={back} />
                ))}
              </ol>
            ) : (
              <p className="p-4 text-sm text-muted">{t("No action could be estimated yet. Connect the sources listed with the findings below to rank actions by expected impact.")}</p>
            )}
          </Panel>

          <Panel eyebrow={t("Not estimable yet")} title={t("Findings ordered by severity, never ranked as zero")} pad={false} className="mb-6">
            {data.findings.unestimated.length ? (
              <ol>
                {data.findings.unestimated.map((f) => (
                  <FindingCard key={f.id} f={f} canPropose={can("growth:write")} back={back} />
                ))}
              </ol>
            ) : (
              <p className="p-4 text-sm text-muted">{t("Every finding of this run has an estimated impact.")}</p>
            )}
          </Panel>
        </>
      )}

      {data.history.length > 0 && (
        <Panel eyebrow={t("History")} title={t("Brain runs")} pad={false}>
          <ResponsiveTable>
            <thead>
              <tr>
                <Th>{t("Started")}</Th>
                <Th>{t("Trigger")}</Th>
                <Th>{t("Status")}</Th>
                <Th className="text-right">{t("Ranked")}</Th>
                <Th className="text-right">{t("Not estimable")}</Th>
                <Th>{t("Summary")}</Th>
              </tr>
            </thead>
            <tbody>
              {data.history.map((r) => (
                <tr key={r.id}>
                  <Td primary className="num text-xs">
                    {fmt(r.startedAt ?? r.createdAt, intl)}
                  </Td>
                  <Td label={t("Trigger")} className="text-xs">
                    {triggerLabel(t, r.trigger)}
                  </Td>
                  <Td label={t("Status")}>
                    <StatusBadge status={r.status} />
                    {r.error && <div className="mt-1 max-w-xs break-words text-[11px] text-crit">{t(r.error)}</div>}
                  </Td>
                  <Td label={t("Ranked")} className="num text-right text-xs">
                    {r.status === "DONE" ? r.rankedCount : t("n/a")}
                  </Td>
                  <Td label={t("Not estimable")} className="num text-right text-xs">
                    {r.status === "DONE" ? r.unestimatedCount : t("n/a")}
                  </Td>
                  <Td label={t("Summary")} className="text-xs">
                    {r.status !== "DONE" ? t("n/a") : r.summarySource === "LLM" ? t("AI-written") : t("Deterministic")}
                    {r.llmUsage && r.llmUsage.calls > 0 && <div className="num text-[10px] text-muted">{t("{calls} model call(s), {rejected} rejected by the checks", { calls: r.llmUsage.calls, rejected: r.llmUsage.rejected.length })}</div>}
                  </Td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        </Panel>
      )}
    </>
  );
}
