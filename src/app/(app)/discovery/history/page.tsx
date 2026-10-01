import type { Metadata } from "next";
import Link from "next/link";
import { and, eq } from "drizzle-orm";
import { EmptyState, PageHeader, Panel, StatusBadge, Table, Td, Th } from "@/components/ui";
import { products } from "@/db/schema";
import { getI18n, getT } from "@/i18n/server";
import { pageData, sp1, type SP } from "@/lib/page";
import { auditHistory } from "@/services/seo";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Crawl history") };
}

export default async function HistoryPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { t, intl } = await getI18n();
  const num = (n: number) => new Intl.NumberFormat(intl).format(n);
  const slug = sp1(sp, "product");
  const { data } = await pageData(async (tx, ctx) => {
    const product = slug ? await tx.query.products.findFirst({ where: and(eq(products.organizationId, ctx.org.id), eq(products.slug, slug)) }) : null;
    return { product, audits: product ? await auditHistory(tx, ctx.org.id, product.id) : [] };
  });
  return (
    <>
      <PageHeader
        eyebrow={t("Crawl history · {name}", { name: data.product?.name ?? "" })}
        title={t("Crawl history")}
        description={t("Every technical audit of this product, with what changed since the crawl before it.")}
        actions={
          <Link className="eyebrow hover:text-chrome" href={`/discovery?product=${slug ?? ""}`}>
            {t("← Discovery")}
          </Link>
        }
      />
      {!data.audits.length ? (
        <EmptyState variant="not_generated" what={t("No audits yet.")} why={t("The crawl history lists every technical audit of this product with what changed since the previous one.")} action={{ label: t("Run a technical audit"), href: `/discovery?product=${slug ?? ""}` }} />
      ) : (
        <Panel pad={false}>
          <Table>
            <thead>
              <tr>
                <Th>{t("Started")}</Th>
                <Th>{t("Status")}</Th>
                <Th>{t("Pages")}</Th>
                <Th>{t("Critical")}</Th>
                <Th>{t("High")}</Th>
                <Th>{t("New pages")}</Th>
                <Th>{t("Removed pages")}</Th>
                <Th>{t("New issues")}</Th>
                <Th>{t("Fixed issues")}</Th>
              </tr>
            </thead>
            <tbody>
              {data.audits.map((a) => (
                <tr key={a.id}>
                  <Td className="num text-xs">
                    <Link className="text-blue-bright hover:text-cyan" href={`/discovery/audits/${a.id}`}>
                      {a.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                    </Link>
                  </Td>
                  <Td>
                    <StatusBadge status={a.status} />
                  </Td>
                  <Td className="num">{num(a.pagesCrawled)}</Td>
                  <Td className="num">{a.summary.CRITICAL ?? t("n/a")}</Td>
                  <Td className="num">{a.summary.HIGH ?? t("n/a")}</Td>
                  <Td className="num">{a.diff?.previousAuditId ? num(a.diff.newPages) : t("n/a")}</Td>
                  <Td className="num">{a.diff?.previousAuditId ? num(a.diff.removedPages) : t("n/a")}</Td>
                  <Td className="num">{a.diff?.previousAuditId ? num(a.diff.newIssues) : t("n/a")}</Td>
                  <Td className="num">{a.diff?.previousAuditId ? num(a.diff.fixedIssues) : t("n/a")}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
      )}
    </>
  );
}
