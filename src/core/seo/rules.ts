/**
 * Technical SEO rule catalogue. Every issue Beacon reports references one of
 * these rules: severity, what is wrong, why it matters, how to fix it and
 * whether Beacon itself can fix it. Texts are English source strings; the UI
 * translates them with t() (French in src/i18n/fr/p2crawl.ts).
 *
 * `detail` is the per-URL message template; its {placeholders} are filled
 * from the issue params, so stored issues stay translatable.
 */
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";

export type RuleCategory =
  | "CRAWL"
  | "INDEXABILITY"
  | "METADATA"
  | "CONTENT"
  | "HEADINGS"
  | "CANONICAL"
  | "LINKS"
  | "SITEMAP"
  | "STRUCTURED_DATA"
  | "INTERNATIONAL"
  | "SOCIAL"
  | "ACCESSIBILITY"
  | "MOBILE"
  | "SECURITY"
  | "PERFORMANCE";

export type RuleDef = {
  id: string;
  category: RuleCategory;
  severity: Severity;
  what: string;
  why: string;
  howToFix: string;
  /** True only when Beacon can apply the fix itself (on pages it hosts). */
  autoFixable: boolean;
  detail: string;
};

export const CATEGORY_LABELS: Record<RuleCategory, string> = {
  CRAWL: "Crawling",
  INDEXABILITY: "Indexability",
  METADATA: "Titles and descriptions",
  CONTENT: "Content",
  HEADINGS: "Headings",
  CANONICAL: "Canonical URLs",
  LINKS: "Internal links",
  SITEMAP: "Sitemaps",
  STRUCTURED_DATA: "Structured data",
  INTERNATIONAL: "International (hreflang)",
  SOCIAL: "Social sharing",
  ACCESSIBILITY: "Accessibility",
  MOBILE: "Mobile",
  SECURITY: "Security",
  PERFORMANCE: "Server signals",
};

/** Labels for coded param values (reason / kind / source / role), translated by the UI. */
export const CODE_LABELS: Record<string, string> = {
  INDEXABLE: "indexable",
  HTTP_STATUS: "HTTP status is not 200",
  REDIRECT: "redirects to another URL",
  NOINDEX_META: "noindex in the robots meta tag",
  NOINDEX_HEADER: "noindex in the X-Robots-Tag header",
  CANONICALISED: "canonical points to another URL",
  ROBOTS_BLOCKED: "blocked by robots.txt",
  NON_HTML: "not an HTML document",
  UNREACHABLE: "could not be fetched",
  GENERIC: "generic wording",
  SITE_NAME: "only the site name",
  META: "robots meta tag",
  HEADER: "X-Robots-Tag header",
  NOT_SITEMAP: "not a sitemap document",
  TOO_LARGE: "larger than 50 MB once decompressed",
  DECOMPRESS_FAILED: "gzip data could not be decompressed",
  TOO_DEEP: "sitemap index nested deeper than 2 levels",
};

const r = (id: string, category: RuleCategory, severity: Severity, autoFixable: boolean, what: string, why: string, howToFix: string, detail: string): RuleDef => ({ id, category, severity, autoFixable, what, why, howToFix, detail });

const LIST: RuleDef[] = [
  // Crawling
  r("robots.missing", "CRAWL", "LOW", false, "robots.txt is missing.", "Without robots.txt, crawlers assume everything may be crawled and cannot discover your sitemap from it.", "Publish a robots.txt at the site root that declares your sitemap and only disallows sections that must stay out of search.", "robots.txt returned HTTP {status}; crawling is treated as allowed."),
  r("robots.blocks_all", "CRAWL", "CRITICAL", false, "robots.txt blocks search engines from the whole site.", "Search engines cannot crawl any page, so new and updated content is never discovered.", "Remove the \"Disallow: /\" rule for search engine user agents (or for *), unless the site must stay hidden.", "robots.txt disallows the site root for {agent}."),
  r("robots.blocked_url", "CRAWL", "INFO", false, "Beacon did not crawl this URL because robots.txt disallows it.", "Beacon honours robots.txt, so blocked URLs are not audited.", "If this URL should be public and audited, allow it in robots.txt; otherwise no action is needed.", "Disallowed by robots.txt for {agent}."),
  r("http.unreachable", "CRAWL", "HIGH", false, "The URL could not be fetched.", "If Beacon cannot fetch the page, search engines and visitors may fail too.", "Check DNS, the TLS certificate, firewall rules and server availability for this URL.", "Could not fetch: {error}"),
  r("http.error", "CRAWL", "HIGH", false, "The page returns a client error (4xx).", "Broken pages waste crawl budget, lose the value of links pointing to them and frustrate visitors.", "Restore the page, or redirect it (301) to the closest relevant page and update the links that point to it.", "Page returned HTTP {status}."),
  r("http.server_error", "CRAWL", "CRITICAL", false, "The page returns a server error (5xx).", "Server errors interrupt crawling, make search engines visit less often and can drop pages from the index.", "Check the server logs for this URL and fix the failing handler or upstream dependency.", "Page returned HTTP {status}."),
  r("http.redirect_chain", "CRAWL", "LOW", false, "The URL goes through a chain of two or more redirects.", "Each hop adds latency, and some crawlers stop following long chains.", "Redirect the first URL straight to the final destination and update internal links to the final URL.", "Redirect chain of {hops} hops ending at {final}."),
  // Indexability
  r("robots.noindex", "INDEXABILITY", "HIGH", false, "The page asks search engines not to index it.", "A noindex page never appears in search results, even when it is linked and listed in the sitemap.", "Remove noindex from the robots meta tag or the X-Robots-Tag header if the page should be found.", "noindex set in the {source}: {value}"),
  r("indexability.homepage", "INDEXABILITY", "CRITICAL", false, "The homepage cannot be indexed.", "The homepage usually carries the most links and brand searches; if it cannot be indexed the whole site loses visibility.", "Fix the cause shown so the homepage returns 200, has no noindex and canonicalises to itself.", "Homepage is not indexable: {reason}."),
  r("indexability.impressions_page", "INDEXABILITY", "HIGH", false, "A page that already earns search impressions cannot be indexed.", "Search Console shows impressions for this URL; making it non-indexable removes visibility you already have.", "Fix the cause shown so the page returns 200, has no noindex and canonicalises to itself, unless removing it is intended.", "Page with {impressions} search impressions is not indexable: {reason}."),
  // Metadata
  r("meta.title_missing", "METADATA", "HIGH", true, "The page has no title.", "The title is the main headline shown in search results and a strong relevance signal.", "Add a unique, descriptive <title> of about 15 to 65 characters.", "Missing <title>."),
  r("meta.title_length", "METADATA", "LOW", true, "The title is too short or too long.", "Very short titles say little about the page; long titles are cut off in search results.", "Rewrite the title to about 15 to 65 characters, leading with what the page is about.", "Title is {length} characters (aim for 15 to 65)."),
  r("meta.title_weak", "METADATA", "MEDIUM", true, "The title is generic or only repeats the site name.", "A generic title (such as \"Home\" or \"Untitled\") or the bare site name on an inner page does not tell searchers what the page offers. A title equal to the H1 is fine.", "Write a title that names the specific topic of the page, optionally followed by the brand.", "Weak title \"{title}\" ({kind})."),
  r("meta.description_missing", "METADATA", "MEDIUM", true, "The page has no meta description.", "Search engines then pick a snippet themselves, which is often less relevant and less convincing.", "Add a meta description of about 50 to 165 characters summarising what the visitor will find.", "Missing meta description."),
  r("meta.description_length", "METADATA", "LOW", true, "The meta description is too short or too long.", "Short descriptions under-sell the page; long ones are truncated in results.", "Rewrite the description to about 50 to 165 characters.", "Meta description is {length} characters (aim for 50 to 165)."),
  r("duplicate.title", "METADATA", "MEDIUM", true, "Several pages share exactly the same title.", "Identical titles make pages compete with each other and hide what makes each one different.", "Give every page a unique title that reflects its specific content.", "Duplicate title shared with {others} other page(s)."),
  r("duplicate.title_near", "METADATA", "LOW", true, "Several pages have nearly identical titles.", "Titles that differ only by a word or a number look like duplicates to searchers and crawlers.", "Differentiate the titles so each one states what is specific to its page.", "Title is nearly identical to {others} other page(s)."),
  r("duplicate.description", "METADATA", "MEDIUM", true, "Several pages share exactly the same meta description.", "Duplicate descriptions make search snippets indistinguishable.", "Write a unique description for each page.", "Duplicate meta description shared with {others} other page(s)."),
  // Content
  r("duplicate.content", "CONTENT", "MEDIUM", false, "Several URLs serve the same visible text.", "Duplicate pages split links and signals between URLs, and search engines may index the wrong one.", "Keep one URL per piece of content: redirect duplicates (301) or point their canonical to the preferred URL.", "Same visible text as {others} other page(s)."),
  r("content.thin", "CONTENT", "LOW", false, "The page has very little visible text.", "Thin pages rarely answer a searcher's question and are less likely to rank or be cited.", "Expand the page with useful, specific information, or merge it into a stronger page.", "Only {words} words of visible text."),
  r("content.stale", "CONTENT", "LOW", false, "The content has not been updated for over a year.", "Outdated pages lose trust, and answers built on them may be wrong.", "Review the page, update facts and dates, and publish the revision.", "Content not updated for over a year."),
  // Headings
  r("headings.h1_missing", "HEADINGS", "HIGH", true, "The page has no H1 heading.", "The H1 tells visitors and crawlers what the page is about.", "Add one H1 that states the main topic of the page.", "No H1 heading."),
  r("headings.h1_multiple", "HEADINGS", "LOW", false, "The page has several H1 headings.", "Several H1s blur the main topic of the page.", "Keep one H1 and turn the others into H2 subheadings.", "{count} H1 headings."),
  r("headings.hierarchy", "HEADINGS", "LOW", false, "Heading levels skip a level.", "A broken outline makes the structure harder to follow for assistive technology and crawlers.", "Use heading levels in order (H2 under H1, H3 under H2) without skipping.", "Heading levels skip from H{from} to H{to}."),
  // Canonical
  r("canonical.missing", "CANONICAL", "MEDIUM", true, "No canonical URL is declared.", "Without a canonical, URL variants (parameters, trailing slashes) can be indexed as separate pages.", "Add <link rel=\"canonical\"> with the absolute preferred URL of the page.", "No canonical URL declared."),
  r("canonical.relative", "CANONICAL", "LOW", true, "The canonical URL is relative.", "Relative canonicals are easy to break when pages are copied or served on other hosts.", "Use an absolute URL (with https:// and the host) in the canonical tag.", "Canonical URL is relative; use an absolute URL."),
  r("canonical.cross_domain", "CANONICAL", "MEDIUM", false, "The canonical points to another host.", "Search engines will index the other host's URL instead of this one.", "Point the canonical to this site unless the page is intentionally a copy of the other host.", "Canonical points to another host ({host})."),
  r("canonical.to_redirect", "CANONICAL", "HIGH", false, "The canonical points to a URL that redirects.", "Search engines may ignore a canonical that does not resolve directly to an indexable page.", "Set the canonical to the final URL of the redirect.", "Canonical points to {target}, which redirects to {final}."),
  r("canonical.to_error", "CANONICAL", "HIGH", false, "The canonical points to a broken URL.", "A canonical to an error page tells search engines to index a page that does not exist.", "Point the canonical to a live, indexable URL (usually the page itself).", "Canonical points to {target}, which returns HTTP {status}."),
  r("canonical.to_noindex", "CANONICAL", "HIGH", false, "The canonical points to a page set to noindex.", "Conflicting signals: this page defers to a page that refuses to be indexed, so neither may appear.", "Point the canonical to an indexable URL, or remove noindex from the target.", "Canonical points to {target}, which is set to noindex."),
  r("canonical.chain", "CANONICAL", "MEDIUM", false, "The canonical points to a page that canonicalises somewhere else.", "Canonical chains are often ignored, so the preferred URL may not be the one indexed.", "Point every canonical directly at the final preferred URL.", "Canonical points to {target}, which canonicalises to {next}."),
  // Links
  r("links.broken_internal", "LINKS", "HIGH", false, "Internal links point to a broken page.", "Broken links waste crawl budget, lose link value and frustrate visitors.", "Update or remove the link, or restore the target page.", "Links to {target} which returns {status}."),
  r("links.to_redirect", "LINKS", "LOW", false, "Internal links point to a URL that redirects.", "Linking to redirects wastes crawl budget and slows visitors down.", "Update the link so it points directly at the final URL.", "Links to {target}, which redirects to {final}."),
  r("links.orphan", "LINKS", "MEDIUM", true, "Orphan page: no crawled page links to it.", "Pages without internal links are hard for crawlers and visitors to discover and receive no link value.", "Link to the page from related pages (see the internal linking suggestions).", "Orphan page: no internal links point to it."),
  // Sitemaps
  r("sitemap.missing", "SITEMAP", "HIGH", true, "No XML sitemap was found.", "A sitemap helps search engines find every page you want indexed, especially new or poorly linked ones.", "Publish an XML sitemap of your indexable URLs and declare it in robots.txt.", "No XML sitemap found (checked robots.txt declarations and /sitemap.xml)."),
  r("sitemap.invalid", "SITEMAP", "HIGH", false, "A sitemap could not be read.", "Search engines ignore sitemaps they cannot parse, so its URLs lose that discovery path.", "Serve a valid XML sitemap (optionally gzip-compressed, at most 50 MB uncompressed) and keep index nesting shallow.", "Sitemap could not be read ({reason})."),
  r("sitemap.child_error", "SITEMAP", "MEDIUM", false, "A sitemap listed in a sitemap index returns an error.", "The URLs in that child sitemap are not submitted to search engines.", "Fix the child sitemap URL or remove it from the index.", "Child sitemap returned HTTP {status}."),
  r("sitemap.not_found_entry", "SITEMAP", "MEDIUM", true, "The sitemap lists a URL that returns an error.", "Listing broken URLs wastes crawl budget and lowers trust in the sitemap.", "Remove the URL from the sitemap or restore the page.", "Sitemap lists a URL returning {status}."),
  r("sitemap.redirect_entry", "SITEMAP", "MEDIUM", true, "The sitemap lists a URL that redirects.", "Sitemaps should only list final URLs; redirects make crawlers do extra work and dilute the signal.", "Replace the URL in the sitemap with its final destination.", "Sitemap lists a URL that redirects to {final}."),
  r("sitemap.non_indexable_entry", "SITEMAP", "LOW", true, "The sitemap lists a URL that cannot be indexed.", "A sitemap should only contain pages you want indexed; mixed signals reduce trust in it.", "Remove the URL from the sitemap, or make the page indexable if it should rank.", "Sitemap lists a non-indexable URL ({reason})."),
  r("sitemap.canonical_mismatch", "SITEMAP", "MEDIUM", true, "The sitemap lists a URL whose canonical points elsewhere.", "The sitemap and the page disagree about the preferred URL.", "List the canonical URL in the sitemap, or make the page canonicalise to itself.", "Sitemap lists this URL but its canonical is {canonical}."),
  r("sitemap.blocked_by_robots", "SITEMAP", "HIGH", false, "The sitemap lists a URL that robots.txt disallows.", "You ask search engines to index a URL they are not allowed to crawl.", "Allow the URL in robots.txt, or remove it from the sitemap.", "Sitemap lists a URL that robots.txt disallows for {agent}."),
  r("sitemap.missing_important", "SITEMAP", "LOW", true, "An indexable, linked page is missing from every sitemap.", "Pages outside the sitemap are discovered later and are easier to overlook.", "Add the URL to your XML sitemap.", "Indexable page with {inlinks} internal link(s) is not in any sitemap."),
  r("sitemap.unchecked", "SITEMAP", "INFO", false, "Some sitemap URLs were not checked.", "The crawl budget was reached before every sitemap URL could be fetched, so their status is unknown.", "Raise the page budget of the audit (up to 500) to check more URLs.", "{count} sitemap URL(s) were not checked because the crawl budget was reached."),
  // Structured data
  r("schema.invalid_json", "STRUCTURED_DATA", "MEDIUM", false, "A JSON-LD block cannot be parsed.", "Invalid JSON-LD is ignored entirely, so the page loses its structured data.", "Fix the JSON syntax of the block (validate it before publishing).", "A JSON-LD block could not be parsed."),
  r("schema.required_missing", "STRUCTURED_DATA", "MEDIUM", true, "Structured data is missing required properties.", "Search engines skip structured data that lacks the properties they require for that type.", "Add the missing properties with real values only; never invent ratings, prices or reviews.", "{type} structured data is missing required properties: {properties}."),
  r("schema.entity_missing", "STRUCTURED_DATA", "LOW", true, "The homepage has no entity structured data.", "Organization or SoftwareApplication markup helps search engines and AI assistants identify who you are and what you offer.", "Add Organization and SoftwareApplication (or Product) JSON-LD to the homepage.", "Homepage has no Organization / SoftwareApplication structured data."),
  // International
  r("hreflang.invalid", "INTERNATIONAL", "MEDIUM", false, "Some hreflang values are invalid.", "Invalid language codes are ignored, so the wrong language version may be shown.", "Use ISO 639-1 language codes, optionally with an ISO 3166-1 region (e.g. en, fr-FR) or x-default.", "Invalid hreflang values: {values}"),
  r("hreflang.self", "INTERNATIONAL", "LOW", false, "The hreflang set does not reference the page itself.", "Each language version should list itself as well as its alternates.", "Add a self-referencing hreflang entry to the set.", "hreflang set does not reference this page."),
  r("hreflang.no_return", "INTERNATIONAL", "MEDIUM", false, "An hreflang alternate does not link back.", "hreflang annotations must be reciprocal; one-way links are ignored.", "Add the matching hreflang entry on the alternate page pointing back to this page.", "Alternate {target} ({lang}) does not link back to this page."),
  // Social
  r("social.og_title", "SOCIAL", "LOW", true, "og:title is missing.", "Shared links fall back to guesses, which often look broken on social networks.", "Add an og:title meta tag.", "Missing og:title."),
  r("social.og_description", "SOCIAL", "LOW", true, "og:description is missing.", "Shared links show no summary or a random excerpt.", "Add an og:description meta tag.", "Missing og:description."),
  r("social.og_image", "SOCIAL", "LOW", true, "og:image is missing.", "Shared links without an image get far less attention.", "Add an og:image meta tag with an absolute image URL.", "Missing og:image."),
  r("social.twitter_card", "SOCIAL", "LOW", true, "twitter:card is missing.", "X (Twitter) shows a minimal preview without a card type.", "Add a twitter:card meta tag (summary or summary_large_image).", "Missing twitter:card."),
  // Accessibility / mobile / security
  r("a11y.html_lang", "ACCESSIBILITY", "LOW", true, "The page does not declare its language.", "Screen readers and search engines rely on the lang attribute to handle the text correctly.", "Add a lang attribute to the <html> element (e.g. lang=\"en\").", "Missing lang attribute on <html>."),
  r("a11y.empty_links", "ACCESSIBILITY", "LOW", false, "Some links have no accessible text.", "Links without text are meaningless to screen readers and carry no anchor relevance.", "Give each link visible text, an aria-label, or an image with alt text.", "{count} links have no accessible text."),
  r("images.alt_missing", "ACCESSIBILITY", "MEDIUM", false, "Images have no alt attribute.", "Alt text describes images to screen readers and to image search; a missing attribute is an accessibility failure (decorative images may use alt=\"\").", "Add a short, descriptive alt attribute to each listed image, or alt=\"\" if it is purely decorative.", "{count} of {total} images have no alt attribute."),
  r("images.dimensions", "PERFORMANCE", "LOW", false, "Images have no explicit width and height.", "Without dimensions the layout shifts while images load.", "Add width and height attributes (or CSS aspect-ratio) to each image.", "{count} images lack explicit width/height (layout shift risk)."),
  r("mobile.viewport", "MOBILE", "MEDIUM", true, "The page has no viewport meta tag.", "Without it, mobile browsers render a zoomed-out desktop layout.", "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">.", "Missing viewport meta tag."),
  r("security.mixed_content", "SECURITY", "MEDIUM", false, "The https page loads resources over http.", "Browsers block or warn about insecure resources, breaking the page and eroding trust.", "Load every resource over https.", "{count} resources loaded over insecure http."),
  // Performance signals
  r("speed.page_weight", "PERFORMANCE", "MEDIUM", false, "The HTML document is very heavy.", "Large documents are slower to download and parse, especially on mobile networks.", "Reduce inline scripts, styles and markup; load large data on demand.", "HTML document is {kb} KB."),
  r("speed.server_response", "PERFORMANCE", "MEDIUM", false, "The server responded slowly.", "Slow responses delay every visit and can reduce how much a crawler fetches. This is a server signal, not a Core Web Vitals measurement.", "Profile the server for this URL and add caching where possible.", "Server responded in {ms} ms (signal only; not a Core Web Vitals measurement)."),
];

export const RULES: Readonly<Record<string, RuleDef>> = Object.freeze(Object.fromEntries(LIST.map((x) => [x.id, x])));

/** Look up a rule; unknown ids (from older audits) get a neutral INFO definition. */
export function ruleDef(id: string): RuleDef {
  return RULES[id] ?? { id, category: "CRAWL", severity: "INFO", autoFixable: false, what: id, why: "", howToFix: "", detail: id };
}

export type IssueParams = Record<string, string | number>;

const CODED_PARAMS = new Set(["reason", "kind", "source"]);

/** Fill a rule's detail template. `t` translates (identity for English storage). */
export function renderDetail(rule: string, params: IssueParams = {}, t: (s: string, vars?: Record<string, string | number>) => string = (s, v) => fill(s, v)): string {
  const def = RULES[rule];
  if (!def) return rule;
  const vars: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(params)) vars[k] = CODED_PARAMS.has(k) && typeof v === "string" && CODE_LABELS[v] ? t(CODE_LABELS[v]) : v;
  return t(def.detail, vars);
}

function fill(s: string, vars?: Record<string, string | number>) {
  return vars ? s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m)) : s;
}

/** Every English string of the catalogue (used to check translations). */
export function catalogueStrings(): string[] {
  const out = new Set<string>();
  for (const d of LIST) for (const s of [d.what, d.why, d.howToFix, d.detail]) out.add(s);
  for (const s of Object.values(CATEGORY_LABELS)) out.add(s);
  for (const s of Object.values(CODE_LABELS)) out.add(s);
  return [...out];
}

/** Stable identity of an issue across audits (product, rule, URL and an optional sub-key). */
export function issueFingerprint(productId: string, rule: string, url: string, key?: string | null): string {
  return [productId, rule, url, key ?? ""].join("|");
}
