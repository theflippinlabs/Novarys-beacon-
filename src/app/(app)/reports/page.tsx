import Link from "next/link";
import type { Metadata } from "next";
import { EmptyState, Flash, HiddenBack, PageHeader, Panel, Table, Td, Th } from "@/components/ui";
import { generateReportAction } from "@/app/actions/reports";
import { pageData, type SP } from "@/lib/page";
import { getI18n, getT } from "@/i18n/server";
import { listReports, weeklyPeriod } from "@/services/reports";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Reports") };
}

export default async function ReportsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { data, can } = await pageData((tx, ctx) => listReports(tx, ctx.org.id));
  const { t, intl } = await getI18n();
  const next = weeklyPeriod();
  return (
    <>
      <PageHeader
        eyebrow={t("Reports")}
        title={t("Weekly executive reports")}
        description={t("Discovery, visibility, content, conversion, revenue, AI observations, opportunities, experiments, risks and next actions, per product and for the organisation, each compared with the previous week. Generated every week; export as CSV, Markdown or JSON, or print.")}
        actions={
          can("job:run") ? (
            <form action={generateReportAction}>
              <HiddenBack path="/reports" />
              <button className="inline-flex items-center gap-2 border border-gold bg-gradient-to-b from-gold-bright to-gold px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-obsidian hover:brightness-110" title={t("Week {start} to {end}", { start: next.period.start, end: next.period.end })}>
                {t("Generate now")}
              </button>
            </form>
          ) : null
        }
      />
      <Flash searchParams={sp} />
      {!data.length ? (
        <EmptyState
          variant="not_generated"
          what={t("No report yet")}
          why={t("Beacon generates the weekly report every week. Use Generate now to build the report of the last complete week ({start} to {end}).", { start: next.period.start, end: next.period.end })}
          action={can("job:run") ? { label: t("Generate now"), form: { action: generateReportAction, back: "/reports" } } : { label: t("Command center"), href: "/" }}
        />
      ) : (
        <Panel title={t("{n} report(s)", { n: data.length })} pad={false}>
          <Table>
            <thead>
              <tr>
                <Th>{t("Period")}</Th>
                <Th>{t("Generated")}</Th>
                <Th>{t("Export")}</Th>
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <Link href={`/reports/${r.id}`} className="num text-blue-bright hover:underline">
                      {t("Week {start} to {end}", { start: r.periodStart, end: r.periodEnd })}
                    </Link>
                  </Td>
                  <Td className="num text-xs">{r.updatedAt.toLocaleString(intl, { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" })}</Td>
                  <Td>
                    <span className="flex flex-wrap gap-3 text-xs">
                      <a className="text-blue-bright hover:underline" href={`/api/reports/${r.id}/export?format=csv`}>
                        CSV
                      </a>
                      <a className="text-blue-bright hover:underline" href={`/api/reports/${r.id}/export?format=md`}>
                        Markdown
                      </a>
                      <a className="text-blue-bright hover:underline" href={`/api/reports/${r.id}/export?format=json`}>
                        JSON
                      </a>
                    </span>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      )}
    </>
  );
}
