import { notFound } from "next/navigation";
import { asSystem } from "@/db";
import { crossSellRules } from "@/db/schema";
import { eq } from "drizzle-orm";
import { recommendProduct } from "@/ai/tasks";
import { withTracking } from "@/core/discovery/urls";
import { orgBySlug, publicGraphs } from "@/services/public";

export const dynamic = "force-dynamic";
export const metadata = { title: "Which product fits?", robots: { index: false } };

/** Public, explainable product finder backed only by verified product facts. */
export default async function AskPage({ params, searchParams }: { params: Promise<{ org: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { org: slug } = await params;
  const sp = await searchParams;
  const need = typeof sp.need === "string" ? sp.need.slice(0, 1000) : "";
  const data = await asSystem(async (tx) => {
    const org = await orgBySlug(tx, slug);
    if (!org) return null;
    if (!need || need.trim().length < 5) return { org, result: null };
    const graphs = await publicGraphs(tx, org.id);
    const rules = await tx.select().from(crossSellRules).where(eq(crossSellRules.organizationId, org.id));
    return { org, result: recommendProduct(need, graphs, new Set(rules.map((r) => `${r.sourceProductId}:${r.destinationProductId}`))) };
  });
  if (!data) notFound();
  const r = data.result;
  return (
    <main className="mx-auto min-h-screen max-w-2xl px-4 py-16">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/beacon-emblem-128.png" alt="" width={56} height={56} className="mb-4" />
      <div className="eyebrow text-gold">{data.org.branding.displayName ?? data.org.name}</div>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Describe what you need.</h1>
      <p className="mt-2 text-sm text-chrome">We match your need against verified product facts and explain why. If nothing fits, we say so.</p>
      <form method="get" className="mt-8 flex flex-col gap-3 sm:flex-row">
        <input name="need" defaultValue={need} placeholder="I run a TikTok agency with 30 creators." aria-label="Your need" required minLength={5} maxLength={1000} />
        <button className="border border-gold bg-gold px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-obsidian">Find</button>
      </form>
      {r && (
        <section className="mt-10">
          {r.primary ? (
            <div className="border border-line p-6">
              <div className="eyebrow">Recommended · {r.primary.fit === "STRONG" ? "strong fit" : "partial fit"}</div>
              <h2 className="mt-1 text-xl text-platinum">{r.primary.productName}</h2>
              <p className="mt-2 text-sm text-chrome">{r.explanation}</p>
              {r.primary.relevantFeatures.length > 0 && <p className="mt-3 text-sm text-chrome">Relevant features: {r.primary.relevantFeatures.join(", ")}.</p>}
              {r.primary.pricing.length > 0 && <p className="mt-1 text-sm text-chrome">Pricing: {r.primary.pricing.join(" · ")}.</p>}
              {r.primary.cta && (
                <a href={withTracking(r.primary.cta.url, { utm_source: "beacon-ask", utm_medium: "recommendation", utm_campaign: slug })} className="mt-4 inline-block border border-platinum px-4 py-2 font-mono text-[11px] uppercase tracking-[0.14em] text-platinum">
                  {r.primary.cta.label} →
                </a>
              )}
              {r.complementary.length > 0 && <p className="mt-6 text-xs text-muted">Also relevant: {r.complementary.map((c) => c.productName).join(", ")}.</p>}
            </div>
          ) : (
            <p className="text-sm text-chrome">{r.explanation}</p>
          )}
        </section>
      )}
    </main>
  );
}
