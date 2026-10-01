import { facetsOf, isVerified, type Facet, type ProductGraph } from "@/core/knowledge/types";
import { buildAnswerBlocks } from "@/core/geo/entity";
import { breadcrumbJsonLd, faqPageJsonLd, softwareApplicationJsonLd, articleJsonLd } from "@/core/seo/schema-org";
import { canonicalUrl, pagePath, type PageType } from "@/core/discovery/urls";
import { formatMoney, stripLongDashes } from "@/core/util/text";
import { publishableGraph } from "@/core/knowledge/facts";
import type { ContentType } from "./types";
import { EDITOR_TODO } from "./markers";
import { queryTermCoverage } from "./seo-check";
import { problemHowTo } from "@/core/queries/expand";

export type { ContentType } from "./types";
export { EDITOR_TODO } from "./markers";

/** Version of these generation rules, recorded as the provenance ("Prompt / rules version") of every rules-generated draft. */
export const CONTENT_RULES_VERSION = "content-rules-v2";

export type DraftRequest = {
  type: ContentType;
  pageType?: PageType;
  facetId?: string | null;
  competitorId?: string | null;
  targetQuery?: string | null;
  publisher: string;
};

export type Draft = {
  title: string;
  metaTitle: string | null;
  metaDescription: string | null;
  body: string;
  factRefs: { ref: string; sourceUrl?: string }[];
  structuredData: Record<string, unknown>[];
};

class Writer {
  lines: string[] = [];
  refs = new Map<string, string | undefined>();
  line(s = "") {
    this.lines.push(s);
    return this;
  }
  ref(ref: string, sourceUrl?: string) {
    this.refs.set(ref, sourceUrl);
    return this;
  }
  todo(what: string) {
    return this.line(`${EDITOR_TODO} ${what}`).line();
  }
  text() {
    return this.lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  }
  factRefs() {
    return [...this.refs.entries()].map(([ref, sourceUrl]) => ({ ref, sourceUrl }));
  }
}

const src = (g: ProductGraph, id: string | null) => (id ? g.sources.find((s) => s.id === id)?.url : undefined);
/** `s` starts with the name `name` (as a whole word, any case). */
const startsWithName = (s: string, name: string) => Boolean(name) && s.trim().toLowerCase().startsWith(name.toLowerCase()) && !/^[\p{L}\p{N}]/u.test(s.trim().slice(name.length));
/**
 * Lower-case the first letter to continue a sentence, unless the text starts
 * with a proper noun: one of `names` (the product, a competitor) or a word
 * that looks like a brand / acronym (e.g. "TikTok", "API").
 */
const lowerFirst = (s: string, names: string[] = []) => (/^[A-Z][a-z]*[A-Z]|^[A-Z]{2}/.test(s) || names.some((n) => startsWithName(s, n)) ? s : s.charAt(0).toLowerCase() + s.slice(1));
/** "Name: description" (lower-cased to continue the sentence, except in titles), without repeating the name when the description already starts with it. */
const named = (name: string, s: string, title = false) => (startsWithName(s, name) ? s.trim() : `${name}: ${title ? s.trim() : lowerFirst(s.trim(), [name])}`);
const upperFirst = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const sentence = (s: string) => (/[.!?]$/.test(s.trim()) ? s.trim() : `${s.trim()}.`);
const truncate = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…");

function ctas(g: ProductGraph, w: Writer) {
  const urls = g.product.conversionUrls;
  if (!urls.length) {
    w.todo("Add a conversion URL (trial, demo or signup) to the product so this page has a measurable CTA.");
    return;
  }
  w.line("## Get started").line();
  for (const c of urls) w.line(`- [${c.label}](${c.url}) {cta:${c.kind}}`);
  w.line();
}

function sourcesSection(w: Writer) {
  const urls = [...new Set([...w.refs.values()].filter((u): u is string => Boolean(u)).map((u) => u.replace(/\/+$/, "")))];
  if (!urls.length) return;
  w.line("## Sources").line();
  for (const u of urls) w.line(`- <${u}>`);
  w.line();
}

function facetList(g: ProductGraph, w: Writer, facets: Facet[], heading: string) {
  if (!facets.length) return;
  w.line(`## ${heading}`).line();
  for (const f of facets) {
    w.line(`- **${f.name}**${f.description ? `: ${sentence(f.description)}` : ""}`);
    w.ref(`facet:${f.id}`, src(g, f.sourceId));
  }
  w.line();
}

function pricingSection(g: ProductGraph, w: Writer) {
  const plans = g.pricing.filter((p) => p.verification !== "REJECTED");
  w.line("## Pricing").line();
  if (!plans.length) {
    if (g.product.pricingUrl) w.line(`Current plans are listed on the [pricing page](${g.product.pricingUrl}).`).line();
    else w.todo("No pricing recorded in the knowledge graph. Add plans or remove this section.");
    return;
  }
  for (const p of plans) {
    if (p.priceCents !== null && !p.currency) {
      // Never assume a currency: the editor must complete the plan in the knowledge graph.
      w.todo(`Plan "${p.planName}" has a price without a currency. Complete it in the knowledge graph.`);
      continue;
    }
    const price = p.priceCents === null ? "price on request" : `${formatMoney(p.priceCents, p.currency!)}${p.interval === "MONTH" ? " / month" : p.interval === "YEAR" ? " / year" : ""}`;
    w.line(`- **${p.planName}**: ${price}${p.trialDays ? ` (${p.trialDays}-day trial)` : ""}${p.description ? `. ${sentence(p.description)}` : ""}`);
    w.ref(`pricing:${p.id}`, src(g, p.sourceId) ?? g.product.pricingUrl ?? undefined);
  }
  w.line();
}

function faqSection(g: ProductGraph, w: Writer, limit = 6) {
  const faqs = g.faqs.filter((f) => f.verification !== "REJECTED").slice(0, limit);
  if (!faqs.length) return [];
  w.line("## Frequently asked questions").line();
  for (const f of faqs) {
    w.line(`### ${f.question}`).line().line(sentence(f.answer)).line();
    w.ref(`faq:${f.id}`, src(g, f.sourceId));
  }
  return faqs;
}

function productUrl(g: ProductGraph, path: string) {
  return canonicalUrl(g.product.domain, path) ?? path;
}

/** Proper nouns of the graph (product, competitors, integrations, brand-like words such as "TikTok") with their casing. */
function properNouns(g: ProductGraph): string[] {
  const words = [g.product.shortDescription, g.product.fullDescription, ...g.facets.flatMap((f) => [f.name, f.description])].flatMap((t) => (t ?? "").match(/\b(?:[A-Z][a-z]+[A-Z][\w]*|[A-Z]{2,})\b/g) ?? []);
  return [...new Set([g.product.name, ...g.competitors.map((c) => c.competitor.name), ...facetsOf(g, "INTEGRATION").map((f) => f.name), ...words])].filter(Boolean);
}

/**
 * Title (H1 and meta title) of a draft that targets a search query: the
 * format's own title when it already carries most of the query's terms,
 * otherwise the query itself, capitalised, with the graph's proper nouns
 * re-cased ("tiktok" → "TikTok") and the product name appended when absent.
 * Only the query's own words are used, so no claim is added.
 */
function targetedTitle(base: string, query: string | null | undefined, g: ProductGraph): string {
  let q = query?.trim().replace(/\s+/g, " ") ?? "";
  if (!q || queryTermCoverage(q, base) >= 0.5) return base;
  for (const n of properNouns(g)) q = q.replace(new RegExp(`(?<![\\p{L}\\p{N}])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}])`, "giu"), () => n);
  q = upperFirst(q);
  return queryTermCoverage(g.product.name, q) >= 1 ? q : `${q} | ${g.product.name}`;
}

/**
 * Deterministic, fact-grounded draft generation. Every statement is composed
 * from VERIFIED knowledge-graph facts and recorded in `factRefs`; anything the graph
 * cannot support becomes an explicit editor TODO instead of invented copy.
 * An LLM provider can rewrite the prose (see ai/tasks.ts) but the fact check
 * always runs against the same graph afterwards.
 */
export function generateDraft(graph: ProductGraph, req: DraftRequest): Draft {
  // Anything Beacon drafts can be published or distributed: only VERIFIED facts are used.
  const g = publishableGraph(graph);
  const p = g.product;
  const w = new Writer();
  const facet = req.facetId ? g.facets.find((f) => f.id === req.facetId) ?? null : null;
  const comp = req.competitorId ? g.competitors.find((c) => c.competitorId === req.competitorId) ?? null : null;
  const home = p.domain ? `https://${p.domain}` : undefined;
  const features = facetsOf(g, "FEATURE");
  const audiences = facetsOf(g, "AUDIENCE");
  const problems = facetsOf(g, "PROBLEM");
  const structuredData: Record<string, unknown>[] = [];

  const intro = () => {
    if (p.shortDescription) {
      w.line(sentence(named(p.name, p.shortDescription))).line();
      w.ref("product:short_description", home);
    } else w.todo(`Add a short description of ${p.name} to the knowledge graph.`);
  };

  switch (req.type) {
    case "LANDING_PAGE": {
      const pageType = req.pageType ?? (facet ? facetPageType(facet) : "PRODUCT");
      const path = pageType === "PRODUCT" ? pagePath("PRODUCT", p.slug) : pagePath(pageType, p.slug, facet?.slug ?? comp?.competitor.slug);
      const title = targetedTitle(facet ? landingTitle(pageType, p.name, facet.name) : p.shortDescription ? named(p.name, p.shortDescription, true) : p.name, req.targetQuery, g);
      w.line(`# ${title}`).line();
      if (facet) {
        if (facet.description) {
          w.line(sentence(facet.description)).line();
          w.ref(`facet:${facet.id}`, src(g, facet.sourceId));
        } else w.todo(`Describe "${facet.name}" in the knowledge graph.`);
        intro();
      } else {
        intro();
        if (p.fullDescription) {
          w.line("## What it is").line().line(p.fullDescription.trim()).line();
          w.ref("product:full_description", home);
        }
      }
      facetList(g, w, audiences, "Who it is for");
      facetList(g, w, problems, "Problems it solves");
      facetList(g, w, facet?.kind === "FEATURE" ? features.filter((f) => f.id !== facet.id).slice(0, 6) : features.slice(0, 8), facet?.kind === "FEATURE" ? "Related capabilities" : "Key features");
      if (p.howItWorks) {
        w.line("## How it works").line().line(p.howItWorks.trim()).line();
        w.ref("product:how_it_works", p.documentationUrl ?? home);
      }
      facetList(g, w, facetsOf(g, "INTEGRATION"), "Integrations");
      const proofs = g.proofs.filter((pr) => pr.publishable && isVerified(pr));
      if (proofs.length) {
        w.line("## Evidence").line();
        for (const pr of proofs) {
          w.line(`> ${pr.content}${pr.attribution ? ` (${pr.attribution})` : ""}`).line();
          w.ref(`proof:${pr.id}`, src(g, pr.sourceId));
        }
      }
      pricingSection(g, w);
      const faqs = faqSection(g, w);
      ctas(g, w);
      sourcesSection(w);
      const url = productUrl(g, path);
      structuredData.push(softwareApplicationJsonLd(g, { url, publisher: req.publisher }));
      const faqLd = faqPageJsonLd(faqs);
      if (faqLd) structuredData.push(faqLd);
      structuredData.push(breadcrumbJsonLd([{ name: p.name, url: productUrl(g, `/${p.slug}`) }, ...(path !== `/${p.slug}` ? [{ name: facet?.name ?? title, url }] : [])]));
      return finish(w, title, p.shortDescription ?? facet?.description ?? null, structuredData);
    }

    case "COMPARISON": {
      if (!comp) throw new Error("A comparison draft requires a competitor");
      const sourced = comp.comparisonFacts.filter((f) => f.sourceUrl);
      const title = targetedTitle(`${p.name} vs ${comp.competitor.name}`, req.targetQuery, g);
      w.line(`# ${title}`).line();
      intro();
      w.line(`_This comparison is based only on publicly available, sourced information. Each row links to its source; verify details before making a decision._`).line();
      if (sourced.length) {
        w.line(`| Dimension | ${p.name} | ${comp.competitor.name} | Source |`).line("|---|---|---|---|");
        sourced.forEach((f, i) => {
          w.line(`| ${f.dimension} | ${f.product} | ${f.competitor} | <${f.sourceUrl}> |`);
          w.ref(`comparison:${comp.competitorId}:${i}`, f.sourceUrl);
        });
        w.line();
      } else w.todo(`Add sourced comparison facts for ${comp.competitor.name}. Never publish unsourced competitor claims.`);
      facetList(g, w, audiences, `Who ${p.name} is for`);
      ctas(g, w);
      sourcesSection(w);
      structuredData.push(articleJsonLd({ headline: title, description: p.shortDescription, url: productUrl(g, pagePath("COMPARISON", p.slug, comp.competitor.slug)), publisher: req.publisher, datePublished: null }));
      return finish(w, title, `A sourced, factual comparison of ${p.name} and ${comp.competitor.name}.`, structuredData);
    }

    case "FAQ": {
      const title = targetedTitle(`${p.name}: frequently asked questions`, req.targetQuery, g);
      w.line(`# ${title}`).line();
      const { answers, gaps } = buildAnswerBlocks(g);
      for (const a of answers) {
        w.line(`## ${a.question}`).line().line(a.answer).line();
        for (const r of a.basedOn) w.ref(r, a.sources[0]);
      }
      for (const gap of gaps) w.todo(`Unanswered: ${gap}`);
      sourcesSection(w);
      const ld = faqPageJsonLd(answers.map((a) => ({ question: a.question, answer: a.answer })));
      if (ld) structuredData.push(ld);
      return finish(w, title, `Factual answers about ${p.name}: what it is, who it is for, pricing and integrations.`, structuredData);
    }

    case "ARTICLE":
    case "TUTORIAL": {
      const howTo = problems[0] ? problemHowTo(lowerFirst(problems[0].name, properNouns(g))) : null;
      const topic = req.targetQuery ?? howTo ?? `getting started with ${p.name}`;
      const title = upperFirst(topic);
      w.line(`# ${title}`).line();
      if (problems.length) facetList(g, w, problems.slice(0, 4), "The problem");
      else w.todo("Describe the problem this guide addresses (no problems recorded in the graph).");
      w.line(`## How ${p.name} helps`).line();
      intro();
      if (req.type === "TUTORIAL") {
        const steps = (p.howItWorks ?? "").split(/\n+|(?<=\.)\s+(?=\d+[.)]\s)/).map((s) => s.replace(/^\s*\d+[.)]\s*/, "").trim()).filter(Boolean);
        if (steps.length >= 2) {
          w.line("## Steps").line();
          steps.forEach((s, i) => w.line(`${i + 1}. ${sentence(s)}`));
          w.line();
          w.ref("product:how_it_works", p.documentationUrl ?? home);
        } else w.todo("Write the step-by-step procedure (the graph's 'how it works' does not contain ordered steps).");
      }
      facetList(g, w, features.slice(0, 5), "Relevant capabilities");
      ctas(g, w);
      sourcesSection(w);
      structuredData.push(articleJsonLd({ headline: title, description: p.shortDescription, url: productUrl(g, pagePath("GUIDE", p.slug, topic)), publisher: req.publisher, datePublished: null }));
      return finish(w, title, p.shortDescription ? truncate(`${title}. ${p.shortDescription}`, 160) : null, structuredData);
    }

    case "RELEASE_ANNOUNCEMENT": {
      const entry = g.changelog[0];
      const title = entry ? `${p.name}${entry.version ? ` ${entry.version}` : ""}: ${entry.title}` : `${p.name} release announcement`;
      w.line(`# ${title}`).line();
      if (entry) {
        w.line(`Released ${entry.releasedOn}.`).line();
        if (entry.body) w.line(entry.body.trim()).line();
        w.ref(`changelog:${entry.id}`, src(g, entry.sourceId));
      } else w.todo("No changelog entry recorded. Add one before drafting an announcement.");
      intro();
      ctas(g, w);
      sourcesSection(w);
      return finish(w, title, entry ? truncate(`${entry.title}. ${entry.body ?? ""}`, 160) : null, structuredData);
    }

    case "X_POST": {
      const feature = facet ?? features[0];
      const cta = p.conversionUrls[0]?.url ?? home;
      let text = p.shortDescription ? `${named(p.name, p.shortDescription.replace(/\.$/, ""))}.` : `${p.name}.`;
      if (feature) text += ` ${feature.name}${feature.description ? `: ${lowerFirst(feature.description.replace(/\.$/, ""), [p.name])}` : ""}.`;
      const budget = 280 - (cta ? cta.length + 1 : 0);
      text = truncate(text, budget) + (cta ? ` ${cta}` : "");
      w.line(text);
      if (p.shortDescription) w.ref("product:short_description", home);
      if (feature) w.ref(`facet:${feature.id}`, src(g, feature.sourceId));
      return finish(w, `X post | ${p.name}`, null, structuredData);
    }

    case "LINKEDIN_POST":
    case "NEWSLETTER": {
      const title = req.type === "NEWSLETTER" ? `${p.name} update` : `LinkedIn post | ${p.name}`;
      if (req.type === "NEWSLETTER") w.line(`# ${title}`).line();
      if (problems[0]) {
        w.line(sentence(`${problems[0].name} is a recurring problem for ${audiences[0] ? lowerFirst(audiences[0].name, [p.name]) : "teams"}`)).line();
        w.ref(`facet:${problems[0].id}`, src(g, problems[0].sourceId));
        if (audiences[0]) w.ref(`facet:${audiences[0].id}`, src(g, audiences[0].sourceId));
      }
      intro();
      if (features.length) {
        w.line(`What it does:`).line();
        for (const f of features.slice(0, 4)) {
          w.line(`→ ${f.name}${f.description ? `: ${lowerFirst(sentence(f.description), [p.name])}` : ""}`);
          w.ref(`facet:${f.id}`, src(g, f.sourceId));
        }
        w.line();
      }
      if (req.type === "NEWSLETTER" && g.changelog[0]) {
        w.line(`## What's new`).line().line(`${g.changelog[0].releasedOn}: ${g.changelog[0].title}`).line();
        w.ref(`changelog:${g.changelog[0].id}`, src(g, g.changelog[0].sourceId));
      }
      const cta = p.conversionUrls[0];
      if (cta) w.line(`${cta.label}: ${cta.url}`);
      else w.todo("Add a conversion URL for the call to action.");
      return finish(w, title, null, structuredData);
    }

    case "TIKTOK_SCRIPT":
    case "SHORT_VIDEO_SCRIPT": {
      const title = `${req.type === "TIKTOK_SCRIPT" ? "TikTok" : "Short video"} script | ${p.name}`;
      w.line(`# ${title}`).line().line("_Format: 30 to 45 seconds, vertical, on-screen text + voice-over._").line();
      w.line("## Hook (0-3s)").line();
      if (problems[0]) {
        w.line(`"${sentence(problems[0].name)} Here's how ${audiences[0] ? lowerFirst(audiences[0].name, [p.name]) : "teams"} handle it."`).line();
        w.ref(`facet:${problems[0].id}`, src(g, problems[0].sourceId));
      } else w.todo("Write a hook: no problem statement recorded in the graph.");
      w.line("## Beats").line();
      features.slice(0, 3).forEach((f, i) => {
        w.line(`${i + 1}. Show **${f.name}** on screen${f.description ? ` (VO: "${sentence(f.description)}")` : ""}`);
        w.ref(`facet:${f.id}`, src(g, f.sourceId));
      });
      if (!features.length) w.todo("Add at least one feature to script product beats.");
      w.line().line("## Call to action").line();
      const cta = p.conversionUrls[0];
      w.line(cta ? `On-screen: "${cta.label}" → ${cta.url}` : `On-screen: ${p.name}${home ? ` (${home})` : ""}`);
      w.line().line("_Film real product footage only; do not stage fake results or testimonials._");
      return finish(w, title, null, structuredData);
    }

    case "DIRECTORY_DESCRIPTION": {
      const title = `Directory listing | ${p.name}`;
      w.line(`# ${title}`).line();
      w.line(`**Name:** ${p.name}`).line(`**Website:** ${home ?? "unknown"}`).line(`**Category:** ${p.category ?? "unknown"}`).line();
      w.line("**Tagline (≤ 60 chars):**").line();
      if (p.shortDescription) {
        w.line(truncate(p.shortDescription, 60)).line();
        w.ref("product:short_description", home);
      } else w.todo("Add a short description.");
      w.line("**Description (≤ 300 chars):**").line();
      w.line(truncate([p.shortDescription, features.slice(0, 3).map((f) => f.name).join(", ")].filter(Boolean).join(" Features: "), 300)).line();
      for (const f of features.slice(0, 3)) w.ref(`facet:${f.id}`, src(g, f.sourceId));
      const priced = g.pricing.filter((x) => x.priceCents !== null && x.currency && isVerified(x));
      w.line(`**Pricing:** ${priced.length ? priced.map((x) => `${x.planName} ${formatMoney(x.priceCents!, x.currency!)}`).join(", ") : p.freeTrial ? "Free trial available" : "see website"}`);
      for (const x of priced) w.ref(`pricing:${x.id}`, src(g, x.sourceId));
      return finish(w, title, null, structuredData);
    }

    case "OUTREACH": {
      const title = `Outreach draft | ${p.name}`;
      w.line(`# ${title}`).line().line("**Subject:** " + (p.shortDescription ? truncate(named(p.name, p.shortDescription), 70) : p.name)).line();
      w.line("Hi {{recipient_name}},").line();
      w.todo("Personalise one sentence about why this recipient/publication is relevant. Do not send without human review.");
      intro();
      for (const f of features.slice(0, 3)) {
        w.line(`- ${f.name}${f.description ? `: ${lowerFirst(sentence(f.description), [p.name])}` : ""}`);
        w.ref(`facet:${f.id}`, src(g, f.sourceId));
      }
      w.line().line(`More information: ${home ?? "{{product_url}}"}`).line().line("Best regards,").line("{{sender_name}}");
      return finish(w, title, null, structuredData);
    }
  }
}

const FACET_PAGE: Partial<Record<Facet["kind"], PageType>> = { FEATURE: "FEATURE", USE_CASE: "USE_CASE", INDUSTRY: "INDUSTRY", AUDIENCE: "AUDIENCE", INTEGRATION: "INTEGRATION" };
export const facetPageType = (f: Facet): PageType => FACET_PAGE[f.kind] ?? "PRODUCT";

function landingTitle(type: PageType, product: string, item: string) {
  switch (type) {
    case "FEATURE":
      return `${item} | ${product}`;
    case "USE_CASE":
      return `${product} for ${lowerFirst(item, [product])}`;
    case "INDUSTRY":
      return `${product} for the ${item} industry`;
    case "AUDIENCE":
      return `${product} for ${item}`;
    case "INTEGRATION":
      return `${product} + ${item} integration`;
    default:
      return `${product}: ${item}`;
  }
}

/** Facts entered by people may contain long dashes; generated content never does. */
function noLongDashes<T>(v: T): T {
  if (typeof v === "string") return stripLongDashes(v) as T;
  if (Array.isArray(v)) return v.map(noLongDashes) as T;
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, noLongDashes(x)])) as T;
  return v;
}

function finish(w: Writer, rawTitle: string, rawDescription: string | null, structuredData: Record<string, unknown>[]): Draft {
  const title = stripLongDashes(rawTitle);
  const description = rawDescription === null ? null : stripLongDashes(rawDescription);
  return {
    title,
    metaTitle: truncate(title, 65),
    metaDescription: description ? truncate(description.replace(/\s+/g, " "), 160) : null,
    body: stripLongDashes(w.text()),
    factRefs: w.factRefs(),
    structuredData: noLongDashes(structuredData),
  };
}
