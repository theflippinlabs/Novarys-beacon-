import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { Badge, KV, PageHeader, Panel } from "@/components/ui";
import { testDetail } from "@/services/ai-visibility";
import { pageData } from "@/lib/page";
import { stripLongDashes } from "@/core/util/text";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Sampled run") };
}

/** One sampled AI response: provider, models, prompt, date, full response, entities with context, citations. */
export default async function AiRunDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { t } = await getI18n();
  if (!/^[0-9a-f-]{36}$/.test(id)) notFound();
  const { data } = await pageData(async (tx, ctx) => {
    const d = await testDetail(tx, ctx.org.id, id);
    if (!d) notFound();
    return d;
  });
  const { test, prompt, product, citations } = data;
  const paramList = Object.entries(test.params ?? {}).map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
  return (
    <>
      <PageHeader
        eyebrow={t("Sampled run · {date}", { date: test.ranAt.toISOString().slice(0, 16).replace("T", " ") })}
        title={test.promptText ?? prompt?.prompt ?? t("Prompt")}
        description={t("One sampled observation through the provider's API. It does not represent every user's AI response.")}
        actions={
          <Link className="eyebrow hover:text-chrome" href="/ai-visibility">
            {t("← All")}
          </Link>
        }
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_22rem]">
        <div className="flex min-w-0 flex-col gap-6">
          <Panel title={t("Full response")}>
            <p className="whitespace-pre-wrap break-words text-sm text-chrome">{stripLongDashes(test.response)}</p>
          </Panel>
          <Panel title={t("Entities mentioned")} eyebrow={t("Order of first appearance, with context")}>
            {test.productsMentioned.length + test.competitorsMentioned.length === 0 ? (
              <p className="text-sm text-muted">{t("No known product or competitor was mentioned.")}</p>
            ) : (
              <ul className="flex flex-col gap-3">
                {[...test.productsMentioned.map((m) => ({ ...m, kind: "PRODUCT", key: m.productId })), ...test.competitorsMentioned.map((m) => ({ ...m, kind: "COMPETITOR", key: m.competitorId }))]
                  .sort((a, b) => a.position - b.position)
                  .map((m) => (
                    <li key={m.key} className="border-b border-line/60 pb-3 text-sm">
                      <div className="flex flex-wrap items-center gap-2">
                        <Badge tone={m.kind === "PRODUCT" ? "gold" : "neutral"}>{enumLabel(t, m.kind)}</Badge>
                        <span className="text-platinum">{m.name}</span>
                        <span className="num text-xs text-muted">{t("order of appearance {n}", { n: m.position })}</span>
                        {typeof m.offset === "number" && <span className="num text-xs text-muted">{t("character {n}", { n: m.offset })}</span>}
                      </div>
                      {m.snippet && <p className="mt-1 text-xs text-chrome">{stripLongDashes(m.snippet)}</p>}
                    </li>
                  ))}
              </ul>
            )}
          </Panel>
          <Panel title={t("Citations")} eyebrow={t("{n} source(s)", { n: citations.length || test.citations.length })} pad={false}>
            {citations.length ? (
              <ul className="flex flex-col divide-y divide-line/60">
                {citations.map((c) => (
                  <li key={c.id} className="flex min-w-0 flex-col gap-1 px-4 py-3 text-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="num text-muted">{c.position}.</span>
                      <Badge tone={c.kind === "OWN" ? "ok" : c.kind === "COMPETITOR" ? "warn" : "neutral"}>{enumLabel(t, c.kind)}</Badge>
                      <Badge tone="muted">{enumLabel(t, c.category)}</Badge>
                      <span className="num text-chrome">{c.registrableDomain}</span>
                    </div>
                    {c.title && <div className="text-chrome">{c.title}</div>}
                    <a href={c.url} rel="noopener noreferrer nofollow" target="_blank" className="num break-all text-muted hover:text-blue-bright">
                      {c.url}
                    </a>
                    {(c.nearProductIds.length > 0 || c.nearCompetitorIds.length > 0) && (
                      <div className="text-muted">{t("Mentioned near this citation: {n} product(s), {m} competitor(s)", { n: c.nearProductIds.length, m: c.nearCompetitorIds.length })}</div>
                    )}
                  </li>
                ))}
              </ul>
            ) : test.citations.length ? (
              <ul className="flex flex-col gap-1 p-4 text-xs">
                {test.citations.map((u) => (
                  <li key={u} className="num break-all text-muted">
                    {u}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="p-4 text-sm text-muted">{t("No citation returned for this response.")}</p>
            )}
          </Panel>
        </div>
        <Panel title={t("Run")}>
          <KV
            items={[
              [t("Provider"), test.provider],
              [t("Configured model"), test.model],
              [t("Served model"), test.servedModel ?? t("Not reported")],
              [t("Web search"), test.grounded ? t("Yes") : t("No")],
              [t("Locale"), test.locale ?? t("n/a")],
              [t("Date"), test.ranAt.toISOString().slice(0, 16).replace("T", " ")],
              [t("Product"), product?.name ?? t("Ecosystem")],
              [t("Label"), enumLabel(t, test.label)],
              [t("Parameters"), paramList.length ? paramList.join(" · ") : t("n/a")],
            ]}
          />
        </Panel>
      </div>
    </>
  );
}
