import type { Metadata } from "next";
import Link from "next/link";
import { and, desc, eq } from "drizzle-orm";
import { Badge, EmptyState, PageHeader, Panel, Table, Td, Th } from "@/components/ui";
import { products, seoAudits } from "@/db/schema";
import { getI18n, getT } from "@/i18n/server";
import { pageData, sp1, type SP } from "@/lib/page";
import { linkGraph, type GraphRow } from "@/services/link-graph";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Internal links") };
}

export default async function LinksPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { t, intl } = await getI18n();
  const num = (n: number) => new Intl.NumberFormat(intl).format(n);
  const auditParam = sp1(sp, "audit");
  const slug = sp1(sp, "product");
  const { data } = await pageData(async (tx, ctx) => {
    let audit = auditParam && /^[0-9a-f-]{36}$/.test(auditParam) ? await tx.query.seoAudits.findFirst({ where: and(eq(seoAudits.id, auditParam), eq(seoAudits.organizationId, ctx.org.id)) }) : null;
    if (!audit && slug) {
      const p = await tx.query.products.findFirst({ where: and(eq(products.organizationId, ctx.org.id), eq(products.slug, slug)) });
      if (p) audit = await tx.query.seoAudits.findFirst({ where: and(eq(seoAudits.organizationId, ctx.org.id), eq(seoAudits.productId, p.id), eq(seoAudits.status, "SUCCEEDED")), orderBy: desc(seoAudits.createdAt) });
    }
    if (!audit) return null;
    const product = await tx.query.products.findFirst({ where: eq(products.id, audit.productId) });
    const graph = audit.status === "SUCCEEDED" ? await linkGraph(tx, ctx.org.id, audit.id) : null;
    return { audit, product, graph };
  });
  if (!data) {
    return (
      <>
        <PageHeader eyebrow={t("03 / Discovery")} title={t("Internal links")} />
        <EmptyState variant="not_generated" what={t("No successful audit yet")} why={t("Run a technical audit from the Discovery page; the link graph is built from its crawl.")} action={{ label: t("Run a technical audit"), href: "/discovery" }} />
      </>
    );
  }
  const { audit, product, graph } = data;
  const clusters = new Map<string, GraphRow[]>();
  for (const r of graph?.rows ?? []) clusters.set(r.cluster, [...(clusters.get(r.cluster) ?? []), r]);
  const sorted = [...clusters.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const orphans = graph?.rows.filter((r) => r.orphan).length ?? 0;
  const srcLabel = { QUERY_CLUSTER: t("query cluster"), PAGE_PLAN: t("page plan"), URL_PATH: t("URL path") };
  return (
    <>
      <PageHeader
        eyebrow={t("Internal links · {name}", { name: product?.name ?? "" })}
        title={audit.startUrl}
        description={t("Link graph of the crawl: inlinks and outlinks per page, click depth from the start URL, orphans and topic clusters (from query clusters or the page plan when Beacon knows the page, else the first URL path segment).")}
        actions={
          <Link className="eyebrow hover:text-chrome" href={`/discovery/audits/${audit.id}`}>
            {t("← Audit")}
          </Link>
        }
      />
      {!graph ? (
        <EmptyState variant="no_data_yet" what={t("No link graph yet.")} why={t("The crawl has not finished yet.")} action={{ label: t("Open the audit →"), href: `/discovery/audits/${audit.id}` }} />
      ) : (
        <>
          <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {(
              [
                [t("Pages"), graph.rows.length],
                [t("Internal link edges"), graph.edges],
                [t("Orphan pages"), orphans],
                [t("Clusters"), clusters.size],
              ] as [string, number][]
            ).map(([label, v]) => (
              <div key={label} className="border border-line bg-panel p-3">
                <div className="eyebrow">{label}</div>
                <div className="num mt-1 text-xl text-platinum">{num(v)}</div>
              </div>
            ))}
          </div>

          <Panel title={t("Suggested internal links")} eyebrow={t("Suggestions")} pad={false} className="mb-6">
            {graph.suggestions.length ? (
              <>
                <div className="hidden md:block">
                  <Table>
                    <thead>
                      <tr>
                        <Th>{t("From page")}</Th>
                        <Th>{t("Link to")}</Th>
                        <Th>{t("Suggested anchor")}</Th>
                        <Th>{t("Why")}</Th>
                      </tr>
                    </thead>
                    <tbody>
                      {graph.suggestions.map((s) => (
                        <tr key={`${s.source}${s.target}`}>
                          <Td className="num max-w-xs break-all text-xs">{s.source}</Td>
                          <Td className="num max-w-xs break-all text-xs">{s.target}</Td>
                          <Td className="text-xs text-platinum">“{s.anchor}”</Td>
                          <Td className="text-xs">
                            {s.reason.code === "QUERY_MENTION" ? t("The source text mentions “{phrase}”, a query the target page covers.", { phrase: s.reason.phrase }) : t("The source text covers the target topic “{phrase}”.", { phrase: s.reason.phrase })}
                            {s.reason.sameCluster && <span className="text-muted"> {t("Same cluster.")}</span>}
                            {s.reason.targetInlinks === 0 && <span className="text-warn"> {t("Target is an orphan.")}</span>}
                          </Td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                </div>
                <ul className="flex flex-col divide-y divide-line md:hidden">
                  {graph.suggestions.map((s) => (
                    <li key={`${s.source}${s.target}`} className="flex flex-col gap-1 px-4 py-3 text-xs">
                      <span className="break-all text-muted">{s.source}</span>
                      <span className="break-all text-platinum">→ {s.target}</span>
                      <span>“{s.anchor}”</span>
                    </li>
                  ))}
                </ul>
                <p className="px-4 py-2 text-[11px] text-muted">{t("Suggestions only: add the links on your site where they read naturally. Anchors are varied on purpose; at most 3 suggestions per target.")}</p>
              </>
            ) : (
              <p className="p-4 text-sm text-muted">{t("No suggestions: no page text mentions the topics of weakly linked pages.")}</p>
            )}
          </Panel>

          {sorted.map(([cluster, rows]) => (
            <Panel key={cluster} title={cluster} eyebrow={t("{n} page(s) · from {source}", { n: rows.length, source: srcLabel[rows[0].clusterSource] })} pad={false} className="mb-4">
              <div className="hidden md:block">
                <Table>
                  <thead>
                    <tr>
                      <Th>{t("URL")}</Th>
                      <Th>{t("Depth")}</Th>
                      <Th>{t("Inlinks")}</Th>
                      <Th>{t("Outlinks")}</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.url}>
                        <Td className="num max-w-md break-all text-xs">
                          {r.url}
                          {r.title && <div className="text-[11px] text-muted">{r.title}</div>}
                        </Td>
                        <Td className="num">{r.depth ?? t("n/a")}</Td>
                        <Td className="num">{r.inlinks}</Td>
                        <Td className="num">{r.outlinks}</Td>
                        <Td>
                          {r.orphan && <Badge tone="warn">{t("Orphan")}</Badge>} {r.plannedPage && <Badge tone="muted">{t("Beacon page")}</Badge>}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
              <ul className="flex flex-col divide-y divide-line md:hidden">
                {rows.map((r) => (
                  <li key={r.url} className="flex flex-col gap-1 px-4 py-3 text-xs">
                    <span className="break-all text-platinum">{r.url}</span>
                    <span className="num text-muted">{t("Depth {depth} · {in} in · {out} out", { depth: r.depth ?? t("n/a"), in: r.inlinks, out: r.outlinks })}</span>
                    {r.orphan && (
                      <span>
                        <Badge tone="warn">{t("Orphan")}</Badge>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </Panel>
          ))}
        </>
      )}
    </>
  );
}
