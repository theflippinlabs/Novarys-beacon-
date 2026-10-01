import { Badge, KV, PageHeader, Panel } from "@/components/ui";
import { ProductTabs } from "@/components/shell/product-tabs";
import { buildAnswerBlocks, buildEntityProfile, type SourcedClaim } from "@/core/geo/entity";
import { loadProductGraph } from "@/core/knowledge/load";
import { env } from "@/lib/env";
import { pageData, productOr404, type SP } from "@/lib/page";
import { getI18n, getT } from "@/i18n/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("GEO / Entity") };
}

async function Claims({ items }: { items: SourcedClaim[] }) {
  const t = await getT();
  if (!items.length) return <span className="text-muted">{t("Unknown")}</span>;
  return (
    <ul className="flex flex-col gap-1">
      {items.map((c, i) => (
        <li key={i} className="text-xs">
          {c.text} {c.verified ? <Badge tone="ok">{t("verified")}</Badge> : <Badge tone="muted">{t("unverified")}</Badge>}
        </li>
      ))}
    </ul>
  );
}

export default async function GeoPage({ params }: { params: Promise<{ slug: string }>; searchParams: Promise<SP> }) {
  const { slug } = await params;
  const { data, ctx } = await pageData(async (tx, ctx) => {
    const p = await productOr404(tx, ctx.org.id, slug);
    return (await loadProductGraph(tx, ctx.org.id, p.id))!;
  });
  const { t } = await getI18n();
  const profile = buildEntityProfile(data, ctx.org.branding.displayName ?? ctx.org.name);
  const { answers, gaps } = buildAnswerBlocks(data);
  const base = env().BEACON_BASE_URL;
  const entityUrl = `${base}/api/v1/entity/${ctx.org.slug}/${data.product.slug}`;
  return (
    <>
      <PageHeader
        eyebrow={t("GEO / AEO · {name}", { name: data.product.name })}
        title={t("Machine-readable entity & answer blocks")}
        description={t("Concise, sourced, citation-worthy facts for answer engines. Beacon cannot guarantee inclusion in any AI system; it maximises the quality and verifiability of public information.")}
      />
      <ProductTabs slug={data.product.slug} active="geo" />
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title={t("Entity profile")} eyebrow={t("WHO · WHAT · WHO FOR · PROBLEM · HOW · PROOF · PRICE · DIFFERENTIATION")}>
          <KV
            items={[
              [t("Who"), t("{product} by {organization}", { product: profile.who.product, organization: profile.who.organization })],
              [t("What"), profile.what.summary?.text ?? null],
              [t("Who for"), <Claims key="a" items={profile.whoFor.audiences} />],
              [t("Problem"), <Claims key="p" items={profile.problem} />],
              [t("How"), profile.how?.text ?? null],
              [t("Proof"), <Claims key="pr" items={profile.proof} />],
              [t("Price"), profile.price.length ? profile.price.map((x) => (x.verified ? t("{plan}: {price}", { plan: x.plan, price: x.price ?? t("not public") }) : t("{plan}: {price} (unverified)", { plan: x.plan, price: x.price ?? t("not public") }))).join(" · ") : null],
              [t("Differentiation"), <Claims key="d" items={profile.differentiation} />],
              [t("Last verified"), profile.lastVerified?.slice(0, 10) ?? t("Never")],
              [t("Unknown"), profile.unknowns.map((u) => t(u)).join(", ") || "—"],
            ]}
          />
          <div className="mt-5 border-t border-line pt-4 text-xs text-chrome">
            {t("Public JSON endpoint:")}{" "}
            <a href={entityUrl} className="num text-blue-bright underline underline-offset-4" target="_blank" rel="noreferrer">
              {entityUrl}
            </a>
            <div className="mt-1 text-muted">{t("Only verified, publishable facts are exposed publicly; unverified claims are withheld.")}</div>
          </div>
        </Panel>
        <Panel title={t("{n} answer blocks", { n: answers.length })} eyebrow={t("Citation-ready answers")}>
          <ul className="flex flex-col gap-4">
            {answers.map((a) => (
              <li key={a.id} className="border-b border-line/60 pb-3">
                <div className="text-sm text-platinum">{a.question}</div>
                <p className="mt-1 text-sm text-chrome">{a.answer}</p>
                <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-muted">
                  <Badge tone={a.confidence >= 0.8 ? "ok" : "warn"}>{t("confidence {pct}%", { pct: Math.round(a.confidence * 100) })}</Badge>
                  {a.sources.map((s) => (
                    <a key={s} href={s} className="num underline-offset-4 hover:underline" target="_blank" rel="noreferrer noopener">
                      {s}
                    </a>
                  ))}
                  {!a.sources.length && <span className="text-warn">{t("no source linked")}</span>}
                </div>
              </li>
            ))}
          </ul>
          {gaps.length > 0 && (
            <div className="mt-4">
              <div className="eyebrow mb-2 text-warn">{t("Unanswerable until facts are added")}</div>
              <ul className="flex flex-col gap-1 text-xs text-chrome">
                {gaps.map((g) => (
                  <li key={g}>○ {t(g)}</li>
                ))}
              </ul>
            </div>
          )}
        </Panel>
      </div>
      <Panel title={t("Raw entity profile")} eyebrow="beacon.entity/v1" className="mt-6">
        <pre className="max-h-[28rem] overflow-auto text-[11px] leading-relaxed text-chrome">{JSON.stringify(profile, null, 2)}</pre>
      </Panel>
    </>
  );
}
