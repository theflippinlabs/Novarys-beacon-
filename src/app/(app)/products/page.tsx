import Link from "next/link";
import { asc, eq } from "drizzle-orm";
import { createProductAction } from "@/app/actions/products";
import {
  Badge,
  Button,
  EmptyState,
  Field,
  Flash,
  HiddenBack,
  LinkButton,
  PageHeader,
  Panel,
  StatusBadge,
  Table,
  Td,
  Th,
} from "@/components/ui";
import { products } from "@/db/schema";
import { loadProductGraph } from "@/core/knowledge/load";
import { computeCompleteness } from "@/core/knowledge/completeness";
import { latestScores } from "@/services/score";
import { pageData, type SP } from "@/lib/page";
import { getI18n, getT } from "@/i18n/server";
import type { Metadata } from "next";
import { buildMediaUrl, mediaIdFromUrl } from "@/core/media/image";
import { env } from "@/lib/env";

/** Logos uploaded to Beacon are shown in the app; remote logo URLs are not hot-linked. */
function ownLogo(url: string | null): string | null {
  const id = url ? mediaIdFromUrl(url, [env().BEACON_BASE_URL]) : null;
  return id ? buildMediaUrl(id) : null;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Products") };
}

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<SP>;
}) {
  const sp = await searchParams;
  const { data, can } = await pageData(async (tx, ctx) => {
    const list = await tx
      .select()
      .from(products)
      .where(eq(products.organizationId, ctx.org.id))
      .orderBy(asc(products.name));
    const scores = await latestScores(tx, ctx.org.id);
    const rows = [];
    for (const p of list) {
      const g = await loadProductGraph(tx, ctx.org.id, p.id);
      rows.push({
        p,
        completeness: g ? computeCompleteness(g).score : 0,
        score: scores.get(p.id)?.total ?? null,
      });
    }
    return rows;
  });
  const { t } = await getI18n();
  const canEdit = can("product:write");
  return (
    <>
      <PageHeader
        eyebrow={t("02 / Products")}
        title={t("Product knowledge graph")}
        description={t(
          "The single source of truth for every Novarys product. Everything Beacon generates is derived from these facts; unknown facts stay unknown until a human provides them.",
        )}
      />
      <Flash searchParams={sp} />
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel title={t("Ecosystem")} pad={false}>
          {data.length === 0 ? (
            <div className="p-4">
              <EmptyState title={t("No products yet")}>
                {t(
                  "Add the first Novarys product. The onboarding takes a few minutes and drives the entire discovery engine.",
                )}
              </EmptyState>
            </div>
          ) : (
            <>
              {/* Phones: one card per product, with the actions always visible. */}
              <ul className="divide-y divide-line md:hidden">
                {data.map(({ p, completeness, score }) => (
                  <li key={p.id} className="flex flex-col gap-3 p-4">
                    <div className="flex items-center gap-3">
                      {ownLogo(p.logoUrl) && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={ownLogo(p.logoUrl)!}
                          alt=""
                          width={40}
                          height={40}
                          className="h-10 w-10 shrink-0 border border-line bg-obsidian object-contain"
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <Link
                          href={`/products/${p.slug}`}
                          className="block truncate font-medium text-platinum"
                        >
                          {p.name}
                        </Link>
                        <div className="truncate text-xs text-muted">
                          {p.domain ?? p.category ?? t("Category unknown")}
                        </div>
                      </div>
                      <StatusBadge status={p.status} />
                    </div>
                    <div className="flex items-center gap-4 text-xs text-chrome">
                      <span>
                        {t("Knowledge")}{" "}
                        <span className="num text-platinum">
                          {Math.round(completeness * 100)}%
                        </span>
                      </span>
                      <span>
                        {t("Beacon score")}{" "}
                        <span className="num text-platinum">
                          {score === null
                            ? t("not computed")
                            : Math.round(score)}
                        </span>
                      </span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <LinkButton href={`/products/${p.slug}`}>
                        {t("Open")}
                      </LinkButton>
                      {canEdit && (
                        <LinkButton
                          variant="gold"
                          href={`/products/${p.slug}/onboarding?step=${p.onboardingCompletedAt ? 1 : Math.max(1, p.onboardingStep)}`}
                        >
                          {p.onboardingCompletedAt
                            ? t("Edit")
                            : t("Continue onboarding →")}
                        </LinkButton>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
              <div className="hidden md:block">
                <Table>
                  <thead>
                    <tr>
                      <Th>{t("Product")}</Th>
                      <Th>{t("Status")}</Th>
                      <Th>{t("Domain")}</Th>
                      <Th>{t("Knowledge")}</Th>
                      <Th>{t("Beacon score")}</Th>
                      <Th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.map(({ p, completeness, score }) => (
                      <tr key={p.id}>
                        <Td>
                          <div className="flex items-center gap-3">
                            {ownLogo(p.logoUrl) && (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={ownLogo(p.logoUrl)!}
                                alt=""
                                width={32}
                                height={32}
                                className="h-8 w-8 shrink-0 border border-line bg-obsidian object-contain"
                              />
                            )}
                            <div className="min-w-0">
                              <Link
                                href={`/products/${p.slug}`}
                                className="font-medium text-platinum hover:text-blue-bright"
                              >
                                {p.name}
                              </Link>
                              <div className="text-xs text-muted">
                                {p.category ?? t("Category unknown")}
                              </div>
                            </div>
                          </div>
                        </Td>
                        <Td>
                          <StatusBadge status={p.status} />
                        </Td>
                        <Td className="num text-xs">
                          {p.domain ?? (
                            <span className="text-muted">{t("unknown")}</span>
                          )}
                        </Td>
                        <Td className="num">
                          {Math.round(completeness * 100)}%
                        </Td>
                        <Td className="num">
                          {score === null ? (
                            <span className="text-muted">
                              {t("not computed")}
                            </span>
                          ) : (
                            <span className="text-platinum">
                              {Math.round(score)}
                            </span>
                          )}
                        </Td>
                        <Td className="text-right">
                          <div className="flex items-center justify-end gap-3">
                            {!p.onboardingCompletedAt ? (
                              <Link
                                className="eyebrow text-blue-bright hover:text-cyan"
                                href={`/products/${p.slug}/onboarding?step=${Math.max(1, p.onboardingStep)}`}
                              >
                                {t("Continue onboarding →")}
                              </Link>
                            ) : (
                              <>
                                <Badge tone="ok">{t("Onboarded")}</Badge>
                                {canEdit && (
                                  <Link
                                    className="eyebrow text-blue-bright hover:text-cyan"
                                    href={`/products/${p.slug}/onboarding?step=1`}
                                  >
                                    {t("Edit")}
                                  </Link>
                                )}
                              </>
                            )}
                          </div>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </Table>
              </div>
            </>
          )}
        </Panel>
        {can("product:write") && (
          <Panel eyebrow={t("Onboard an application")} title={t("Add product")}>
            <form action={createProductAction} className="flex flex-col gap-4">
              <HiddenBack path="/products" />
              <Field label={t("Product name")}>
                <input
                  name="name"
                  required
                  minLength={2}
                  maxLength={80}
                  placeholder={t("e.g. Novus Live")}
                />
              </Field>
              <Field
                label={t("Slug (optional)")}
                hint={t("Used in URLs such as {path}", {
                  path: "/{slug}/features/…",
                })}
              >
                <input name="slug" maxLength={80} placeholder="novus-live" />
              </Field>
              <div>
                <Button variant="gold">{t("Add product →")}</Button>
              </div>
            </form>
          </Panel>
        )}
      </div>
    </>
  );
}
