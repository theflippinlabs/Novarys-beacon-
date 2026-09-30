import Link from "next/link";
import { and, asc, eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { setIssueStatusAction } from "@/app/actions/discovery";
import { Badge, Flash, HiddenBack, KV, PageHeader, Panel, StatusBadge, Table, Td, Th } from "@/components/ui";
import { crawledPages, products, seoAudits, seoIssues } from "@/db/schema";
import { pageData, sp1, type SP } from "@/lib/page";

export const metadata = { title: "Audit" };

const SEV_ORDER = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 } as const;

export default async function AuditPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<SP> }) {
  const { id } = await params;
  const sp = await searchParams;
  const sev = sp1(sp, "severity");
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { data, can } = await pageData(async (tx, ctx) => {
    const audit = await tx.query.seoAudits.findFirst({ where: and(eq(seoAudits.id, id), eq(seoAudits.organizationId, ctx.org.id)) });
    if (!audit) notFound();
    const product = await tx.query.products.findFirst({ where: eq(products.id, audit.productId) });
    const issues = await tx.select().from(seoIssues).where(and(eq(seoIssues.auditId, id), sev ? eq(seoIssues.severity, sev as never) : undefined));
    const crawled = await tx.select().from(crawledPages).where(eq(crawledPages.auditId, id)).orderBy(asc(crawledPages.url)).limit(500);
    return { audit, product, issues: issues.sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]), crawled };
  });
  const { audit } = data;
  const byRule = new Map<string, typeof data.issues>();
  for (const i of data.issues) byRule.set(i.rule, [...(byRule.get(i.rule) ?? []), i]);
  const back = `/discovery/audits/${id}${sev ? `?severity=${sev}` : ""}`;
  return (
    <>
      <PageHeader eyebrow={`Technical audit · ${data.product?.name ?? ""}`} title={audit.startUrl} description="Technical discoverability audit. Page-speed findings are server-response signals only, not Core Web Vitals field data." actions={<Link className="eyebrow hover:text-chrome" href={`/discovery?product=${data.product?.slug}`}>← Discovery</Link>} />
      <Flash searchParams={sp} />
      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <Panel title="Summary" eyebrow={audit.status}>
          <KV
            items={[
              ["Status", <StatusBadge key="s" status={audit.status} />],
              ["Pages crawled", audit.pagesCrawled],
              ["Critical", audit.summary.CRITICAL ?? 0],
              ["High", audit.summary.HIGH ?? 0],
              ["Medium", audit.summary.MEDIUM ?? 0],
              ["Low", audit.summary.LOW ?? 0],
              ["Sitemap URLs", audit.summary.sitemapUrls ?? 0],
              ["Indexable pages", audit.summary.indexable ?? 0],
            ]}
          />
          {audit.error && <p className="mt-3 text-sm text-crit">✕ {audit.error}</p>}
          {(audit.status === "QUEUED" || audit.status === "RUNNING") && <p className="mt-3 text-sm text-muted">The worker is crawling. Refresh to see results.</p>}
        </Panel>
        <Panel title="Filter" eyebrow="Severity">
          <div className="flex flex-wrap gap-2">
            {["", "CRITICAL", "HIGH", "MEDIUM", "LOW"].map((s) => (
              <Link key={s} href={`/discovery/audits/${id}${s ? `?severity=${s}` : ""}`} className={`border px-2 py-1 font-mono text-[10px] uppercase ${(sev ?? "") === s ? "border-gold text-platinum" : "border-line text-muted"}`}>
                {s || "All"}
              </Link>
            ))}
          </div>
        </Panel>
      </div>
      <Panel title={`${data.issues.length} issue(s) in ${byRule.size} rule(s)`} eyebrow="Issues" className="mt-6" pad={false}>
        {[...byRule.entries()].map(([rule, list]) => (
          <details key={rule} className="border-b border-line/60" open={list[0].severity === "CRITICAL"}>
            <summary className="flex cursor-pointer items-center gap-3 px-4 py-3">
              <StatusBadge status={list[0].severity} />
              <span className="num text-xs text-platinum">{rule}</span>
              <span className="text-xs text-muted">{list[0].message}</span>
              <Badge tone="muted">{list.length}</Badge>
            </summary>
            <Table>
              <tbody>
                {list.slice(0, 100).map((i) => (
                  <tr key={i.id}>
                    <Td className="num max-w-md break-all text-xs">{i.url}</Td>
                    <Td className="text-xs">{i.message}</Td>
                    <Td>
                      <StatusBadge status={i.status} />
                    </Td>
                    <Td>
                      {can("query:write") && (
                        <form action={setIssueStatusAction} className="flex gap-2">
                          <HiddenBack path={back} />
                          <input type="hidden" name="id" value={i.id} />
                          <button name="status" value="RESOLVED" className="eyebrow hover:text-ok">resolve</button>
                          <button name="status" value="IGNORED" className="eyebrow hover:text-chrome">ignore</button>
                        </form>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </details>
        ))}
        {!data.issues.length && <p className="p-4 text-sm text-muted">No issues{sev ? " at this severity" : ""}.</p>}
      </Panel>
      <Panel title="Crawled pages" eyebrow="Inventory" className="mt-6" pad={false}>
        <Table>
          <thead>
            <tr>
              <Th>URL</Th>
              <Th>Status</Th>
              <Th>Title</Th>
              <Th>Indexable</Th>
              <Th>Words</Th>
              <Th>Inlinks</Th>
              <Th>Schema</Th>
              <Th>ms</Th>
            </tr>
          </thead>
          <tbody>
            {data.crawled.map((c) => (
              <tr key={c.id}>
                <Td className="num max-w-xs break-all text-xs">{c.url}</Td>
                <Td className="num">{c.status}</Td>
                <Td className="max-w-xs truncate text-xs">{c.title ?? <span className="text-crit">missing</span>}</Td>
                <Td>{c.indexable ? "✓" : <span className="text-warn">✕</span>}</Td>
                <Td className="num">{c.wordCount}</Td>
                <Td className="num">{c.inlinks}</Td>
                <Td className="text-xs">{c.structuredDataTypes.join(", ") || "—"}</Td>
                <Td className="num">{c.loadMs}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>
    </>
  );
}
