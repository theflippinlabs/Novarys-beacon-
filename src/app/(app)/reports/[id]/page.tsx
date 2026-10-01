import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Badge, PageHeader, cx } from "@/components/ui";
import { PrintButton } from "@/components/briefing/print-button";
import { changePct, formatChange, itemText, metricPrev, metricValue, SECTION_TITLES, type ReportScope } from "@/core/reports/report";
import { isUuid } from "@/core/media/image";
import { pageData } from "@/lib/page";
import { getI18n, getT } from "@/i18n/server";
import { getReport } from "@/services/reports";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Weekly executive report") };
}

/** Print: hide the app shell and controls, black text on white, no backgrounds, one scope per page. */
const PRINT_CSS = `@media print {
  @page { margin: 14mm; }
  html, body { background: #fff !important; }
  body > div > header, body > div > aside, nav, .no-print { display: none !important; }
  main { padding: 0 !important; }
  .report-print, .report-print * { color: #111 !important; background: transparent !important; box-shadow: none !important; border-color: #bbb !important; text-shadow: none !important; }
  .report-print a { text-decoration: none !important; }
  .report-scope { break-before: page; }
  .report-scope:first-of-type { break-before: auto; }
  .report-section { break-inside: avoid; }
}`;

export default async function ReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const { data } = await pageData((tx, ctx) => getReport(tx, ctx.org.id, id));
  if (!data) notFound();
  const { t, intl } = await getI18n();
  const r = data.payload;
  const scopeName = (s: ReportScope) => (s.productId ? s.name : t("Organisation total"));
  return (
    <div className="report-print">
      <style>{PRINT_CSS}</style>
      <PageHeader
        eyebrow={t("Reports")}
        title={t("Weekly executive report")}
        description={t("Period {start} to {end}, compared with {pstart} to {pend}.", { start: r.period.start, end: r.period.end, pstart: r.previous.start, pend: r.previous.end })}
        actions={
          <span className="no-print flex flex-wrap items-center gap-2">
            <PrintButton />
            <a className="border border-line-strong px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-platinum hover:border-blue-bright" href={`/api/reports/${data.id}/export?format=csv`}>
              CSV
            </a>
            <a className="border border-line-strong px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-platinum hover:border-blue-bright" href={`/api/reports/${data.id}/export?format=md`}>
              Markdown
            </a>
            <a className="border border-line-strong px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-platinum hover:border-blue-bright" href={`/api/reports/${data.id}/export?format=json`}>
              JSON
            </a>
          </span>
        }
      />
      {r.scopes.length > 1 && (
        <div className="no-print mb-6 flex flex-wrap gap-2">
          {r.scopes.map((s, i) => (
            <a key={s.productId ?? "org"} href={`#scope-${i}`} className="rounded-full border border-line-strong px-3 py-1 text-xs text-chrome hover:border-blue-bright">
              {scopeName(s)}
            </a>
          ))}
        </div>
      )}
      <p className="mb-6 text-xs text-muted">{t("Generated {date} (UTC). Not connected and no-data states are shown as such, never as zero. AI observations are sampled answers, not totals. Amounts in different currencies are never added together.", { date: new Date(r.generatedAt).toLocaleString(intl, { timeZone: "UTC", dateStyle: "medium", timeStyle: "short" }) })}</p>
      {r.scopes.map((s, si) => (
        <section key={s.productId ?? "org"} id={`scope-${si}`} className="report-scope mb-10">
          <h2 className="mb-4 border-b border-line pb-2 text-lg font-semibold text-gold-bright">
            {scopeName(s)}
            {s.slug && (
              <Link href={`/products/${s.slug}`} className="no-print ml-2 text-xs font-normal text-blue-bright">
                {t("Open product →")}
              </Link>
            )}
          </h2>
          <div className="grid gap-4 lg:grid-cols-2">
            {s.sections.map((sec) => (
              <div key={sec.key} className="report-section min-w-0 border border-line bg-panel/90">
                <h3 className="eyebrow border-b border-line px-4 py-2.5">{t(SECTION_TITLES[sec.key])}</h3>
                {sec.metrics.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-sm">
                      <thead>
                        <tr className="eyebrow">
                          <th className="px-3 py-2 font-normal">{t("Metric")}</th>
                          <th className="px-3 py-2 text-right font-normal">{t("This week")}</th>
                          <th className="px-3 py-2 text-right font-normal">{t("Previous week")}</th>
                          <th className="px-3 py-2 text-right font-normal">{t("Change")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {sec.metrics.map((m) => {
                          const c = changePct(m.now, m.prev);
                          return (
                            <tr key={m.key} className="border-t border-line/60" data-metric-state={m.state}>
                              <td className="px-3 py-2 text-chrome">
                                {t(m.label)}
                                {m.currency && <span className="num ml-1 text-[11px] text-muted">{m.currency}</span>}
                              </td>
                              <td className={cx("num px-3 py-2 text-right", m.state === "OK" ? "text-platinum" : "text-muted")}>{metricValue(m, intl, t)}</td>
                              <td className="num px-3 py-2 text-right text-muted">{metricPrev(m, intl, t)}</td>
                              <td className={cx("num px-3 py-2 text-right", c === null ? "text-muted" : c > 0 ? "text-ok" : c < 0 ? "text-crit" : "text-muted")}>{formatChange(m, intl, t)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
                {sec.items.length > 0 && (
                  <ul className="flex flex-col gap-1.5 px-4 py-3 text-sm">
                    {sec.items.map((i, k) => (
                      <li key={k} className="text-chrome">
                        {i.href ? (
                          <Link href={i.href} className="hover:text-platinum">
                            {itemText(t, i)}
                          </Link>
                        ) : (
                          itemText(t, i)
                        )}
                      </li>
                    ))}
                  </ul>
                )}
                {sec.key === "AI_OBSERVATIONS" && (
                  <div className="px-4 pb-3">
                    <Badge tone="muted">{t("Sampled observations")}</Badge>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
