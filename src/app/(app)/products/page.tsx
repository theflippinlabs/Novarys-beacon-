import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { createProductAction } from "@/app/actions/products";
import { Badge, Button, EmptyState, Field, Flash, HiddenBack, PageHeader, Panel, StatusBadge, Table, Td, Th } from "@/components/ui";
import { products } from "@/db/schema";
import { loadProductGraph } from "@/core/knowledge/load";
import { computeCompleteness } from "@/core/knowledge/completeness";
import { latestScores } from "@/services/score";
import { pageData, type SP } from "@/lib/page";

export const metadata = { title: "Products" };

export default async function ProductsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { data, can } = await pageData(async (tx, ctx) => {
    const list = await tx.select().from(products).where(eq(products.organizationId, ctx.org.id)).orderBy(asc(products.name));
    const scores = await latestScores(tx, ctx.org.id);
    const rows = [];
    for (const p of list) {
      const g = await loadProductGraph(tx, ctx.org.id, p.id);
      rows.push({ p, completeness: g ? computeCompleteness(g).score : 0, score: scores.get(p.id)?.total ?? null });
    }
    return rows;
  });
  return (
    <>
      <PageHeader eyebrow="02 / Products" title="Product knowledge graph" description="The single source of truth for every Novarys product. Everything Beacon generates is derived from these facts — unknown facts stay unknown until a human provides them." />
      <Flash searchParams={sp} />
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel title="Ecosystem" pad={false}>
          {data.length === 0 ? (
            <div className="p-4">
              <EmptyState title="No products yet">Add the first Novarys product. The onboarding takes a few minutes and drives the entire discovery engine.</EmptyState>
            </div>
          ) : (
            <Table>
              <thead>
                <tr>
                  <Th>Product</Th>
                  <Th>Status</Th>
                  <Th>Domain</Th>
                  <Th>Knowledge</Th>
                  <Th>Beacon score</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data.map(({ p, completeness, score }) => (
                  <tr key={p.id}>
                    <Td>
                      <Link href={`/products/${p.slug}`} className="font-medium text-platinum hover:text-blue-bright">
                        {p.name}
                      </Link>
                      <div className="text-xs text-muted">{p.category ?? "Category unknown"}</div>
                    </Td>
                    <Td>
                      <StatusBadge status={p.status} />
                    </Td>
                    <Td className="num text-xs">{p.domain ?? <span className="text-muted">unknown</span>}</Td>
                    <Td className="num">{Math.round(completeness * 100)}%</Td>
                    <Td className="num">{score === null ? <span className="text-muted">not computed</span> : <span className="text-platinum">{Math.round(score)}</span>}</Td>
                    <Td className="text-right">
                      {!p.onboardingCompletedAt ? (
                        <Link className="eyebrow text-blue-bright hover:text-cyan" href={`/products/${p.slug}/onboarding?step=${Math.max(1, p.onboardingStep)}`}>
                          Continue onboarding →
                        </Link>
                      ) : (
                        <Badge tone="ok">Onboarded</Badge>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          )}
        </Panel>
        {can("product:write") && (
          <Panel eyebrow="Onboard an application" title="Add product">
            <form action={createProductAction} className="flex flex-col gap-4">
              <HiddenBack path="/products" />
              <Field label="Product name">
                <input name="name" required minLength={2} maxLength={80} placeholder="e.g. Novus Live" />
              </Field>
              <Field label="Slug (optional)" hint="Used in URLs such as /{slug}/features/…">
                <input name="slug" maxLength={80} placeholder="novus-live" />
              </Field>
              <div>
                <Button variant="gold">Add product →</Button>
              </div>
            </form>
          </Panel>
        )}
      </div>
    </>
  );
}
