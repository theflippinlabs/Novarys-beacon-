import type { Metadata } from "next";
import Link from "next/link";
import { and, asc, eq, sql } from "drizzle-orm";
import { notFound } from "next/navigation";
import { setIssueStatusAction } from "@/app/actions/discovery";
import { Badge, Flash, HiddenBack, KV, PageHeader, Panel, StatusBadge, Table, Td, Th } from "@/components/ui";
import { crawledPages, products, seoAudits } from "@/db/schema";
import { CATEGORY_LABELS, CODE_LABELS, renderDetail, ruleDef, type RuleCategory } from "@/core/seo/rules";
import { getI18n, getT } from "@/i18n/server";
import { pageData, sp1, type SP } from "@/lib/page";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Audit") };
}

const SEV_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 } as const;
const PREVIEW = 10;
const PAGE_SIZE = 50;
const INVENTORY_PAGE = 100;

type IssueRow = { id: string; rule: string; severity: keyof typeof SEV_ORDER; url: string; message: string; params: Record<string, string | number>; details: Record<string, unknown>; status: string };

export default async function AuditPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const { id } = await params;
  const sp = await searchParams;
  const { t, intl } = await getI18n();
  const num = (n: number) => new Intl.NumberFormat(intl).format(n);
  const sev = sp1(sp, "severity");
  const cat = sp1(sp, "category");
  const focusRule = sp1(sp, "rule");
  const page = Math.max(1, Number(sp1(sp, "p") ?? 1) || 1);
  const invPage = Math.max(1, Number(sp1(sp, "pp") ?? 1) || 1);
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { data, can } = await pageData(async (tx, ctx) => {
    const audit = await tx.query.seoAudits.findFirst({ where: and(eq(seoAudits.id, id), eq(seoAudits.organizationId, ctx.org.id)) });
    if (!audit) notFound();
    const product = await tx.query.products.findFirst({ where: eq(products.id, audit.productId) });
    const groups = await tx.execute<{ rule: string; severity: string; n: number; open: number }>(sql`
      select rule, severity, count(*)::int as n, count(*) filter (where status = 'OPEN')::int as open
      from seo_issues where audit_id = ${id} ${sev ? sql`and severity = ${sev}` : sql``} group by rule, severity`);
    // First rows of every rule (or one page of the focused rule), in one query.
    const rows = await tx.execute<IssueRow>(sql`
      select id, rule, severity, url, message, params, details, status from (
        select i.*, row_number() over (partition by rule order by url, id) as rn from seo_issues i
        where audit_id = ${id} ${sev ? sql`and severity = ${sev}` : sql``} ${focusRule ? sql`and rule = ${focusRule}` : sql``}
      ) x where ${focusRule ? sql`rn > ${(page - 1) * PAGE_SIZE} and rn <= ${page * PAGE_SIZE}` : sql`rn <= ${PREVIEW}`}
      order by rule, rn`);
    const crawled = await tx
      .select()
      .from(crawledPages)
      .where(eq(crawledPages.auditId, id))
      .orderBy(asc(crawledPages.url))
      .limit(INVENTORY_PAGE)
      .offset((invPage - 1) * INVENTORY_PAGE);
    return { audit, product, groups: groups.rows.map((g) => ({ ...g, n: Number(g.n), open: Number(g.open) })), rows: rows.rows, crawled };
  });
  const { audit } = data;
  const byRule = new Map<string, IssueRow[]>();
  for (const r of data.rows) byRule.set(r.rule, [...(byRule.get(r.rule) ?? []), r]);
  const groups = data.groups
    .map((g) => ({ ...g, def: ruleDef(g.rule) }))
    .filter((g) => !cat || g.def.category === cat)
    .sort((a, b) => SEV_ORDER[a.severity as keyof typeof SEV_ORDER] - SEV_ORDER[b.severity as keyof typeof SEV_ORDER] || b.n - a.n || a.rule.localeCompare(b.rule));
  const totalIssues = groups.reduce((s, g) => s + g.n, 0);
  const qs = (over: Record<string, string | number | undefined>) => {
    const u = new URLSearchParams();
    const base = { severity: sev, category: cat, rule: focusRule, p: focusRule ? page : undefined, ...over };
    for (const [k, v] of Object.entries(base)) if (v !== undefined && v !== "" && v !== null) u.set(k, String(v));
    const s = u.toString();
    return `/discovery/audits/${id}${s ? `?${s}` : ""}`;
  };
  const back = qs({});
  const detailText = (r: IssueRow) => (Object.keys(r.params ?? {}).length || ruleDef(r.rule).detail === r.message ? renderDetail(r.rule, r.params ?? {}, t) : t(r.message));
  const diff = audit.diff;
  const categories = [...new Set(data.groups.map((g) => ruleDef(g.rule).category))].sort();
  const running = audit.status === "QUEUED" || audit.status === "RUNNING";
  const kindLabel = { status: t("HTTP status"), title: t("title"), canonical: t("canonical"), indexability: t("indexability"), content: t("content") };

  return (
    <>
      <PageHeader
        eyebrow={t("Technical audit · {name}", { name: data.product?.name ?? "" })}
        title={audit.startUrl}
        description={t("Technical discoverability audit. Page-speed findings are server-response signals only, not Core Web Vitals field data.")}
        actions={
          <>
            <Link className="eyebrow hover:text-chrome" href={`/discovery/links?audit=${audit.id}`}>
              {t("Internal links")}
            </Link>
            <Link className="eyebrow hover:text-chrome" href={`/discovery/history?product=${data.product?.slug ?? ""}`}>
              {t("Crawl history")}
            </Link>
            <Link className="eyebrow hover:text-chrome" href={`/discovery?product=${data.product?.slug}`}>
              {t("← Discovery")}
            </Link>
          </>
        }
      />
      <Flash searchParams={sp} />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Panel title={t("Summary")} eyebrow={t(audit.status)}>
          <KV
            items={[
              [t("Status"), <StatusBadge key="s" status={audit.status} />],
              [t("Pages crawled"), running ? t("{done} of up to {max}", { done: num(audit.pagesCrawled), max: num(audit.maxPages) }) : num(audit.pagesCrawled)],
              [t("Critical"), audit.summary.CRITICAL ?? 0],
              [t("High"), audit.summary.HIGH ?? 0],
              [t("Medium"), audit.summary.MEDIUM ?? 0],
              [t("Low"), audit.summary.LOW ?? 0],
              [t("Sitemap URLs"), audit.summary.sitemapUrls ?? 0],
              [t("Indexable pages"), audit.summary.indexable ?? 0],
              [t("Blocked by robots.txt"), audit.summary.robotsBlocked ?? t("n/a")],
              [t("Redirects followed"), audit.summary.redirects ?? t("n/a")],
              [t("Crawl delay"), audit.summary.crawlDelayMs !== undefined ? t("{ms} ms", { ms: num(audit.summary.crawlDelayMs) }) : t("n/a")],
              [t("Finished"), audit.finishedAt ? audit.finishedAt.toISOString().slice(0, 16).replace("T", " ") : t("n/a")],
            ]}
          />
          {audit.error && <p className="mt-3 text-sm text-crit">✕ {t(audit.error)}</p>}
          {running && <p className="mt-3 text-sm text-muted">{t("The worker is crawling. Refresh to see results.")}</p>}
        </Panel>
        <Panel title={t("Filter")} eyebrow={t("Severity")}>
          <div className="flex flex-wrap gap-2">
            {["", "CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"].map((s) => (
              <Link key={s} href={qs({ severity: s || undefined, rule: undefined, p: undefined })} className={`border px-2 py-1 font-mono text-[10px] uppercase ${(sev ?? "") === s ? "border-blue-bright text-platinum" : "border-line text-muted"}`}>
                {s ? t(s) : t("All")}
              </Link>
            ))}
          </div>
          {categories.length > 1 && (
            <>
              <div className="eyebrow mt-4 mb-2">{t("Category")}</div>
              <div className="flex flex-wrap gap-2">
                {["", ...categories].map((c) => (
                  <Link key={c} href={qs({ category: c || undefined, rule: undefined, p: undefined })} className={`border px-2 py-1 text-[11px] ${(cat ?? "") === c ? "border-blue-bright text-platinum" : "border-line text-muted"}`}>
                    {c ? t(CATEGORY_LABELS[c as RuleCategory]) : t("All")}
                  </Link>
                ))}
              </div>
            </>
          )}
        </Panel>
      </div>

      {diff && (
        <Panel title={t("Since the previous crawl")} eyebrow={t("Changes")} className="mt-6">
          {diff.previousAuditId ? (
            <>
              <div className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
                {(
                  [
                    [t("New pages"), diff.newPages],
                    [t("Removed pages"), diff.removedPages],
                    [t("New issues"), diff.newIssues],
                    [t("Fixed issues"), diff.fixedIssues],
                    [t("Status changes"), diff.changed.status],
                    [t("Title changes"), diff.changed.title],
                    [t("Canonical changes"), diff.changed.canonical],
                    [t("Indexability changes"), diff.changed.indexability],
                    [t("Content changes"), diff.changed.content],
                    [t("Ignored issues carried over"), diff.carriedIgnored],
                    [t("Marked resolved but still detected"), diff.stillDetectedResolved],
                  ] as [string, number][]
                ).map(([label, v]) => (
                  <div key={label} className="border border-line p-2">
                    <div className="eyebrow">{label}</div>
                    <div className="num mt-1 text-lg text-platinum">{num(v)}</div>
                  </div>
                ))}
              </div>
              {(diff.examples.newPages.length > 0 || diff.examples.removedPages.length > 0 || diff.examples.changed.length > 0 || diff.examples.newIssues.length > 0 || diff.examples.fixedIssues.length > 0) && (
                <details className="mt-3 text-xs">
                  <summary className="cursor-pointer text-blue-bright">{t("Examples")}</summary>
                  <ul className="mt-2 flex flex-col gap-1 break-all text-chrome">
                    {diff.examples.newPages.map((u) => (
                      <li key={`n${u}`}>+ {u}</li>
                    ))}
                    {diff.examples.removedPages.map((u) => (
                      <li key={`r${u}`}>- {u}</li>
                    ))}
                    {diff.examples.changed.map((c) => (
                      <li key={`c${c.url}${c.kind}`}>
                        ~ {c.url} ({kindLabel[c.kind]}
                        {c.before !== null || c.after !== null ? `: ${c.before ?? t("n/a")} → ${c.after ?? t("n/a")}` : ""})
                      </li>
                    ))}
                    {diff.examples.newIssues.map((x) => (
                      <li key={`i${x.rule}${x.url}`}>
                        ! {x.rule} · {x.url}
                      </li>
                    ))}
                    {diff.examples.fixedIssues.map((x) => (
                      <li key={`f${x.rule}${x.url}`} className="text-ok">
                        ✓ {x.rule} · {x.url}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
              <p className="mt-3 text-xs text-muted">
                <Link className="text-blue-bright underline underline-offset-4" href={`/discovery/audits/${diff.previousAuditId}`}>
                  {t("Open the previous crawl")}
                </Link>
              </p>
            </>
          ) : (
            <p className="text-sm text-muted">{t("This is the first successful crawl of this product; changes appear from the next one.")}</p>
          )}
        </Panel>
      )}

      <Panel title={t("{issues} issue(s) in {rules} rule(s)", { issues: totalIssues, rules: groups.length })} eyebrow={t("Issues")} className="mt-6" pad={false}>
        {focusRule && (
          <p className="border-b border-line px-4 py-2 text-xs">
            <Link className="text-blue-bright" href={qs({ rule: undefined, p: undefined })}>
              {t("← All rules")}
            </Link>
          </p>
        )}
        {groups
          .filter((g) => !focusRule || g.rule === focusRule)
          .map((g) => {
            const list = byRule.get(g.rule) ?? [];
            const pages = Math.max(1, Math.ceil(g.n / PAGE_SIZE));
            return (
              <details key={`${g.rule}${g.severity}`} className="border-b border-line/60" open={Boolean(focusRule) || g.severity === "CRITICAL"}>
                <summary className="flex cursor-pointer flex-wrap items-center gap-3 px-4 py-3">
                  <StatusBadge status={g.severity} />
                  <span className="num text-xs text-platinum">{g.rule}</span>
                  <span className="text-xs text-muted">{g.def.what === g.rule ? t(list[0]?.message ?? g.rule) : t(g.def.what)}</span>
                  <Badge tone="muted">{g.n}</Badge>
                  {g.open < g.n && <span className="text-[11px] text-muted">{t("{n} open", { n: g.open })}</span>}
                </summary>
                <div className="grid gap-4 px-4 pb-3 text-xs md:grid-cols-2">
                  <div>
                    <div className="eyebrow mb-1">{t("What is wrong")}</div>
                    <p className="text-chrome">{t(g.def.what)}</p>
                  </div>
                  <div>
                    <div className="eyebrow mb-1">{t("Why it matters")}</div>
                    <p className="text-chrome">{g.def.why ? t(g.def.why) : t("n/a")}</p>
                  </div>
                  <div>
                    <div className="eyebrow mb-1">{t("How to fix")}</div>
                    <p className="text-chrome">{g.def.howToFix ? t(g.def.howToFix) : t("n/a")}</p>
                  </div>
                  <div>
                    <div className="eyebrow mb-1">{t("Can be auto-fixed")}</div>
                    <p className="text-chrome">{g.def.autoFixable ? t("Yes, on Beacon-hosted pages (Beacon generates their tags, structured data, sitemap and related links)") : t("No, the fix is made on your site")}</p>
                    <div className="eyebrow mt-2">{t(CATEGORY_LABELS[g.def.category])}</div>
                  </div>
                </div>
                <div className="eyebrow px-4 pb-1">{t("Affected URLs ({n})", { n: g.n })}</div>
                <Table>
                  <tbody>
                    {list.map((i) => {
                      const extra = (i.details?.images as string[] | undefined) ?? (i.details?.urls as string[] | undefined)?.filter((u) => u !== i.url);
                      return (
                        <tr key={i.id}>
                          <Td className="num max-w-md break-all text-xs">{i.url}</Td>
                          <Td className="text-xs">
                            {detailText(i)}
                            {extra && extra.length > 0 && (
                              <ul className="mt-1 flex flex-col gap-0.5 break-all text-[11px] text-muted">
                                {extra.slice(0, 10).map((u) => (
                                  <li key={u}>{u}</li>
                                ))}
                                {extra.length > 10 && <li>{t("and {n} more", { n: extra.length - 10 })}</li>}
                              </ul>
                            )}
                          </Td>
                          <Td>
                            <StatusBadge status={i.status} />
                          </Td>
                          <Td>
                            {can("query:write") && (
                              <form action={setIssueStatusAction} className="flex gap-2">
                                <HiddenBack path={back} />
                                <input type="hidden" name="id" value={i.id} />
                                <button name="status" value="RESOLVED" className="eyebrow hover:text-ok">
                                  {t("resolve")}
                                </button>
                                <button name="status" value="IGNORED" className="eyebrow hover:text-chrome">
                                  {t("ignore")}
                                </button>
                              </form>
                            )}
                          </Td>
                        </tr>
                      );
                    })}
                  </tbody>
                </Table>
                <div className="flex flex-wrap items-center gap-3 px-4 py-2 text-xs">
                  {!focusRule && g.n > list.length && (
                    <Link className="text-blue-bright" href={qs({ rule: g.rule, p: 1 })}>
                      {t("Show all {n} URLs", { n: g.n })}
                    </Link>
                  )}
                  {focusRule && pages > 1 && (
                    <>
                      {page > 1 && (
                        <Link className="text-blue-bright" href={qs({ p: page - 1 })}>
                          {t("← Previous")}
                        </Link>
                      )}
                      <span className="num text-muted">{t("Page {page} of {pages}", { page, pages })}</span>
                      {page < pages && (
                        <Link className="text-blue-bright" href={qs({ p: page + 1 })}>
                          {t("Next →")}
                        </Link>
                      )}
                    </>
                  )}
                </div>
              </details>
            );
          })}
        {!groups.length && <p className="p-4 text-sm text-muted">{sev ? t("No issues at this severity.") : t("No issues.")}</p>}
      </Panel>

      <Panel title={t("Crawled pages")} eyebrow={t("Inventory")} className="mt-6" pad={false}>
        <Table>
          <thead>
            <tr>
              <Th>{t("URL")}</Th>
              <Th>{t("Status")}</Th>
              <Th>{t("Title")}</Th>
              <Th>{t("Indexable")}</Th>
              <Th>{t("Depth")}</Th>
              <Th>{t("Words")}</Th>
              <Th>{t("Inlinks")}</Th>
              <Th>{t("Outlinks")}</Th>
              <Th>{t("Schema")}</Th>
              <Th>{t("ms")}</Th>
            </tr>
          </thead>
          <tbody>
            {data.crawled.map((c) => (
              <tr key={c.id}>
                <Td className="num max-w-xs break-all text-xs">
                  {c.url}
                  {c.finalUrl && c.finalUrl !== c.url && <div className="text-[11px] text-muted">→ {c.finalUrl}</div>}
                </Td>
                <Td className="num">{c.status || t("n/a")}</Td>
                <Td className="max-w-xs truncate text-xs">{c.title ?? <span className="text-crit">{t("missing")}</span>}</Td>
                <Td className="text-xs">{c.indexable ? "✓" : <span className="text-warn" title={c.indexability && CODE_LABELS[c.indexability] ? t(CODE_LABELS[c.indexability]) : undefined}>✕ {c.indexability && CODE_LABELS[c.indexability] ? t(CODE_LABELS[c.indexability]) : ""}</span>}</Td>
                <Td className="num">{c.depth ?? t("n/a")}</Td>
                <Td className="num">{c.wordCount}</Td>
                <Td className="num">{c.inlinks}</Td>
                <Td className="num">{c.outlinksCount}</Td>
                <Td className="text-xs">{c.structuredDataTypes.join(", ") || t("None")}</Td>
                <Td className="num">{c.loadMs}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {(invPage > 1 || data.crawled.length === INVENTORY_PAGE) && (
          <div className="flex gap-3 px-4 py-2 text-xs">
            {invPage > 1 && (
              <Link className="text-blue-bright" href={`${qs({})}${qs({}).includes("?") ? "&" : "?"}pp=${invPage - 1}`}>
                {t("← Previous")}
              </Link>
            )}
            {data.crawled.length === INVENTORY_PAGE && (
              <Link className="text-blue-bright" href={`${qs({})}${qs({}).includes("?") ? "&" : "?"}pp=${invPage + 1}`}>
                {t("Next →")}
              </Link>
            )}
          </div>
        )}
      </Panel>
    </>
  );
}
