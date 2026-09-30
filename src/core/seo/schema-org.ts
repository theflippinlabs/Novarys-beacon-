import { facetsOf, isVerified, type ProductGraph } from "@/core/knowledge/types";

/**
 * Schema.org JSON-LD generation. Structured data is only emitted for facts
 * that exist in the knowledge graph AND will be visible on the page. Unknown
 * values are omitted rather than guessed. Prices are only emitted when the
 * plan price is known and human-verified.
 */
type JsonLd = Record<string, unknown>;

const compact = <T extends JsonLd>(o: T): T =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && v.length === 0))) as T;

export function organizationJsonLd(org: { name: string; url?: string | null; logoUrl?: string | null; sameAs?: string[] }): JsonLd {
  return compact({ "@context": "https://schema.org", "@type": "Organization", name: org.name, url: org.url ?? undefined, logo: org.logoUrl ?? undefined, sameAs: org.sameAs });
}

export function softwareApplicationJsonLd(g: ProductGraph, opts: { url: string; publisher?: string; visibleOffers?: boolean } ): JsonLd {
  const p = g.product;
  const offers =
    opts.visibleOffers === false
      ? []
      : g.pricing
          .filter((plan) => plan.priceCents !== null && isVerified(plan))
          .map((plan) =>
            compact({
              "@type": "Offer",
              name: plan.planName,
              price: (plan.priceCents! / 100).toFixed(2),
              priceCurrency: plan.currency,
              ...(plan.interval === "MONTH" || plan.interval === "YEAR"
                ? { priceSpecification: { "@type": "UnitPriceSpecification", price: (plan.priceCents! / 100).toFixed(2), priceCurrency: plan.currency, billingDuration: plan.interval === "MONTH" ? "P1M" : "P1Y", unitCode: plan.interval === "MONTH" ? "MON" : "ANN" } }
                : {}),
            }),
          );
  return compact({
    "@context": "https://schema.org",
    "@type": p.domain ? "WebApplication" : "SoftwareApplication",
    name: p.name,
    description: p.shortDescription ?? undefined,
    url: opts.url,
    applicationCategory: p.category ? "BusinessApplication" : undefined,
    applicationSubCategory: p.category ?? undefined,
    operatingSystem: p.domain ? "Web" : undefined,
    inLanguage: p.languages.length ? p.languages : undefined,
    image: p.logoUrl ?? undefined,
    screenshot: p.screenshots.map((s) => s.url),
    featureList: facetsOf(g, "FEATURE").map((f) => f.name),
    datePublished: p.releaseDate ?? undefined,
    publisher: opts.publisher ? { "@type": "Organization", name: opts.publisher } : undefined,
    sameAs: p.socialAccounts.map((s) => s.url),
    offers: offers.length === 1 ? offers[0] : offers.length ? offers : undefined,
  });
}

export function faqPageJsonLd(faqs: { question: string; answer: string }[]): JsonLd | null {
  if (!faqs.length) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.question, acceptedAnswer: { "@type": "Answer", text: f.answer } })),
  };
}

export function breadcrumbJsonLd(items: { name: string; url: string }[]): JsonLd {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, item: it.url })),
  };
}

export function articleJsonLd(a: { headline: string; description?: string | null; url: string; datePublished?: string | null; dateModified?: string | null; publisher: string }): JsonLd {
  return compact({
    "@context": "https://schema.org",
    "@type": "Article",
    headline: a.headline.slice(0, 110),
    description: a.description ?? undefined,
    mainEntityOfPage: a.url,
    datePublished: a.datePublished ?? undefined,
    dateModified: a.dateModified ?? a.datePublished ?? undefined,
    publisher: { "@type": "Organization", name: a.publisher },
  });
}

/** HowTo is only emitted when the page genuinely contains ordered steps. */
export function howToJsonLd(name: string, steps: string[]): JsonLd | null {
  if (steps.length < 2) return null;
  return { "@context": "https://schema.org", "@type": "HowTo", name, step: steps.map((s, i) => ({ "@type": "HowToStep", position: i + 1, text: s })) };
}

/** Serialise for a <script type="application/ld+json"> tag without allowing `</script>` breakouts. */
export function serializeJsonLd(data: unknown): string {
  return JSON.stringify(data).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}
