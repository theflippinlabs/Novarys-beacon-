/**
 * Product launch mode and launch checklist (pure, unit tested).
 *
 * Every item is derived from measured state gathered by
 * services/launch.ts: nothing is self-reported. An item is DONE, TODO, or
 * NOT_CONNECTED when the provider it depends on is missing (never shown as a
 * zero). Blocking items must be DONE before the "Launch product" action runs
 * without an explicit override.
 */
export const LAUNCH_MODES = ["PRE_LAUNCH", "LAUNCH", "POST_LAUNCH", "OFF"] as const;
export type LaunchMode = (typeof LAUNCH_MODES)[number];
export type LaunchPhase = "PRE_LAUNCH" | "LAUNCH_DAY" | "POST_LAUNCH";

/** Query baseline captured before launch (what the post-launch deltas compare against). */
export type LaunchBaseline = {
  capturedAt: string;
  activeQueries: number;
  /** Search totals over the 14 days before capture; null when no search provider was connected. */
  search: { clicks: number; impressions: number; days: number } | null;
  /** Average daily first-party visitors over the 14 days before capture; null without tracking events. */
  visitorsPerDay: number | null;
};

export type ItemStatus = "DONE" | "TODO" | "NOT_CONNECTED";
export type Text = { text: string; params?: Record<string, string | number> };
export type ChecklistItem = {
  key: string;
  phase: LaunchPhase;
  label: string;
  status: ItemStatus;
  blocking: boolean;
  evidence: Text;
  href: string;
};

export type IntegrationState = "CONNECTED" | "FAILING" | "NOT_CONNECTED";

export type LaunchFacts = {
  slug: string;
  knowledge: { completeness: number; facts: number; verified: number };
  domain: { name: string | null; verified: boolean; https: boolean | null };
  audit: { id: string; critical: number; schemaErrorsOnKeyPages: number; sitemaps: number; sitemapErrors: number; finishedAt: string | null } | null;
  analytics: IntegrationState;
  searchConsole: IntegrationState;
  bing: IntegrationState;
  /** Hosted llms.txt and entity endpoint: the organisation's public site switch and whether the product is served there (onboarded, not deprecated). */
  publicSite: { enabled: boolean; orgSlug: string; listed: boolean };
  /** AI visibility baseline: the product's active prompts and how many of them have at least one sampled test. */
  aiVisibility: { providerConfigured: boolean; activePrompts: number; testedPrompts: number };
  referrals: { activeCodes: number };
  /** Revenue source: the Stripe integration state and the revenue events or subscriptions received for the product. */
  revenue: { stripe: IntegrationState; events: number };
  productPage: { published: boolean; planned: boolean };
  docs: { url: string | null; verified: boolean };
  tracking: { activeKeys: number; events: number };
  launchContent: { approved: number; published: number };
  distribution: { prepared: number; submitted: number };
  queries: { active: number };
  baseline: LaunchBaseline | null;
  launchedAt: string | null;
  postLaunch: { eventsSince: number; searchDaysSince: number; analyticsDaysSince: number };
};

/** Knowledge thresholds for launch: 70 % complete and at least 60 % of facts verified. */
export const KNOWLEDGE_MIN_COMPLETENESS = 0.7;
export const KNOWLEDGE_MIN_VERIFIED = 0.6;
export const MIN_BASELINE_QUERIES = 10;
export const MONITORING_DAYS = 14;

const pct = (x: number) => Math.round(x * 100);

export function launchChecklist(f: LaunchFacts): ChecklistItem[] {
  const base = `/products/${f.slug}`;
  const verifiedRatio = f.knowledge.facts ? f.knowledge.verified / f.knowledge.facts : 0;
  const knowledgeOk = f.knowledge.completeness >= KNOWLEDGE_MIN_COMPLETENESS && verifiedRatio >= KNOWLEDGE_MIN_VERIFIED;
  const siteOk = Boolean(f.domain.name && f.domain.verified && f.domain.https && f.audit);
  const integration = (s: IntegrationState): ItemStatus => (s === "CONNECTED" ? "DONE" : s === "FAILING" ? "TODO" : "NOT_CONNECTED");
  const hostedOk = f.publicSite.enabled && f.publicSite.listed && f.knowledge.verified > 0;
  const ai = f.aiVisibility;
  const aiDone = ai.activePrompts > 0 && ai.testedPrompts >= ai.activePrompts;
  const revenueDone = f.revenue.stripe === "CONNECTED" || f.revenue.events > 0;
  const items: ChecklistItem[] = [
    {
      key: "knowledge",
      phase: "PRE_LAUNCH",
      label: "Product knowledge complete and verified",
      status: knowledgeOk ? "DONE" : "TODO",
      blocking: true,
      evidence: { text: "{completeness}% complete, {verified} of {facts} facts verified ({ratio}%). Needs {minC}% complete and {minV}% verified.", params: { completeness: pct(f.knowledge.completeness), verified: f.knowledge.verified, facts: f.knowledge.facts, ratio: pct(verifiedRatio), minC: pct(KNOWLEDGE_MIN_COMPLETENESS), minV: pct(KNOWLEDGE_MIN_VERIFIED) } },
      href: `${base}/knowledge`,
    },
    {
      key: "site",
      phase: "PRE_LAUNCH",
      label: "Canonical site ready",
      status: siteOk ? "DONE" : "TODO",
      blocking: true,
      evidence: !f.domain.name
        ? { text: "No canonical domain set." }
        : !f.domain.verified
          ? { text: "{domain} is not a verified domain.", params: { domain: f.domain.name } }
          : f.domain.https === false
            ? { text: "{domain} does not answer over HTTPS.", params: { domain: f.domain.name } }
            : !f.audit
              ? { text: "{domain} is verified; no successful audit yet.", params: { domain: f.domain.name } }
              : { text: "{domain} is verified and answers over HTTPS in the latest audit.", params: { domain: f.domain.name } },
      href: !f.domain.name ? `${base}/onboarding?step=website` : !f.domain.verified ? "/discovery/domains" : f.audit ? `/discovery/audits/${f.audit.id}` : `/discovery?product=${f.slug}`,
    },
    {
      // Kept blocking: critical issues used to block through the site item.
      key: "critical_issues",
      phase: "PRE_LAUNCH",
      label: "No critical technical issues",
      status: f.audit && f.audit.critical === 0 ? "DONE" : "TODO",
      blocking: true,
      evidence: !f.audit ? { text: "No successful audit yet." } : { text: "{n} open critical issue(s) in the latest audit.", params: { n: f.audit.critical } },
      href: f.audit ? `/discovery/audits/${f.audit.id}` : `/discovery?product=${f.slug}`,
    },
    {
      key: "hosted_endpoints",
      phase: "PRE_LAUNCH",
      label: "llms.txt and entity endpoint available",
      status: hostedOk ? "DONE" : "TODO",
      blocking: false,
      evidence: !f.publicSite.enabled
        ? { text: "The public site is turned off for the organisation: llms.txt and the entity endpoint answer 404." }
        : !f.publicSite.listed
          ? { text: "The product is not served yet: llms.txt and the entity endpoint list onboarded, non-deprecated products only." }
          : f.knowledge.verified === 0
            ? { text: "No verified fact yet: the entity profile and llms.txt publish verified facts only." }
            : { text: "Served at /p/{org}/llms.txt and /api/v1/entity/{org}/{product} with {n} verified fact(s).", params: { org: f.publicSite.orgSlug, product: f.slug, n: f.knowledge.verified } },
      href: !f.publicSite.enabled ? "/settings" : !f.publicSite.listed ? `${base}/onboarding` : f.knowledge.verified === 0 ? `${base}/knowledge` : `/api/v1/entity/${f.publicSite.orgSlug}/${f.slug}`,
    },
    {
      key: "analytics",
      phase: "PRE_LAUNCH",
      label: "Analytics connected",
      status: integration(f.analytics),
      blocking: false,
      evidence: { text: f.analytics === "CONNECTED" ? "Google Analytics 4 is connected." : f.analytics === "FAILING" ? "Google Analytics 4 is configured but its last sync failed." : "Not connected" },
      href: `${base}/onboarding?step=analytics`,
    },
    {
      key: "search_console",
      phase: "PRE_LAUNCH",
      label: "Search Console ready",
      status: integration(f.searchConsole),
      blocking: false,
      evidence: { text: f.searchConsole === "CONNECTED" ? "Google Search Console is connected." : f.searchConsole === "FAILING" ? "Google Search Console is configured but its last sync failed." : "Not connected" },
      href: `${base}/onboarding?step=search`,
    },
    {
      key: "bing",
      phase: "PRE_LAUNCH",
      label: "Bing Webmaster Tools connected",
      status: integration(f.bing),
      blocking: false,
      evidence: { text: f.bing === "CONNECTED" ? "Bing Webmaster Tools is connected." : f.bing === "FAILING" ? "Bing Webmaster Tools is configured but its last sync failed." : "Not connected" },
      href: `${base}/onboarding?step=search`,
    },
    {
      key: "sitemap",
      phase: "PRE_LAUNCH",
      label: "Sitemap ready",
      status: f.audit && f.audit.sitemaps > 0 && f.audit.sitemapErrors === 0 ? "DONE" : "TODO",
      blocking: false,
      evidence: !f.audit ? { text: "No successful audit yet." } : f.audit.sitemaps === 0 ? { text: "The latest audit found no sitemap." } : { text: "{n} sitemap(s) read in the latest audit, {errors} with errors.", params: { n: f.audit.sitemaps, errors: f.audit.sitemapErrors } },
      href: f.audit ? `/discovery/audits/${f.audit.id}` : `/discovery?product=${f.slug}`,
    },
    {
      key: "structured_data",
      phase: "PRE_LAUNCH",
      label: "Structured data ready",
      status: f.audit && f.audit.schemaErrorsOnKeyPages === 0 ? "DONE" : "TODO",
      blocking: false,
      evidence: !f.audit ? { text: "No successful audit yet." } : { text: "{n} structured data errors on key pages (homepage and pages one click away).", params: { n: f.audit.schemaErrorsOnKeyPages } },
      href: f.audit ? `/discovery/audits/${f.audit.id}` : `/discovery?product=${f.slug}`,
    },
    {
      key: "core_pages",
      phase: "PRE_LAUNCH",
      label: "Core pages ready",
      status: f.productPage.published ? "DONE" : "TODO",
      blocking: true,
      evidence: { text: f.productPage.published ? "The product page is published." : f.productPage.planned ? "The product page is planned but not published." : "No product page planned yet." },
      href: `/discovery?product=${f.slug}`,
    },
    {
      key: "documentation",
      phase: "PRE_LAUNCH",
      label: "Documentation ready",
      status: f.docs.url && f.docs.verified ? "DONE" : "TODO",
      blocking: false,
      evidence: !f.docs.url ? { text: "No documentation URL." } : f.docs.verified ? { text: "Documentation URL verified: {url}", params: { url: f.docs.url } } : { text: "Documentation URL not verified yet: {url}", params: { url: f.docs.url } },
      href: `${base}/knowledge`,
    },
    {
      key: "conversion_tracking",
      phase: "PRE_LAUNCH",
      label: "Conversion tracking ready",
      status: f.tracking.activeKeys > 0 && f.tracking.events > 0 ? "DONE" : "TODO",
      blocking: true,
      evidence: { text: "{keys} active tracking key(s), {events} event(s) received.", params: { keys: f.tracking.activeKeys, events: f.tracking.events } },
      href: `${base}/tracking`,
    },
    {
      key: "launch_content",
      phase: "PRE_LAUNCH",
      label: "Launch content ready",
      status: f.launchContent.approved + f.launchContent.published > 0 ? "DONE" : "TODO",
      blocking: false,
      evidence: { text: "{n} approved or published release announcement(s).", params: { n: f.launchContent.approved + f.launchContent.published } },
      href: `/content?product=${f.slug}&type=RELEASE_ANNOUNCEMENT`,
    },
    {
      key: "distribution",
      phase: "PRE_LAUNCH",
      label: "Distribution targets prepared",
      status: f.distribution.prepared + f.distribution.submitted > 0 ? "DONE" : "TODO",
      blocking: false,
      evidence: { text: "{n} target(s) prepared or further along.", params: { n: f.distribution.prepared + f.distribution.submitted } },
      href: `/distribution?product=${f.slug}`,
    },
    {
      key: "query_baseline",
      phase: "PRE_LAUNCH",
      label: "Query baseline created",
      status: f.queries.active >= MIN_BASELINE_QUERIES && f.baseline ? "DONE" : "TODO",
      blocking: false,
      evidence: f.baseline
        ? { text: "{n} active queries; baseline captured on {date}.", params: { n: f.queries.active, date: f.baseline.capturedAt.slice(0, 10) } }
        : { text: "{n} active queries (at least {min}); no baseline captured yet.", params: { n: f.queries.active, min: MIN_BASELINE_QUERIES } },
      href: f.queries.active >= MIN_BASELINE_QUERIES ? `${base}/launch#baseline` : `/queries?product=${f.slug}&status=CANDIDATE`,
    },
    {
      key: "ai_visibility_baseline",
      phase: "PRE_LAUNCH",
      label: "AI visibility baseline sampled",
      status: aiDone ? "DONE" : !ai.providerConfigured ? "NOT_CONNECTED" : "TODO",
      blocking: false,
      evidence: aiDone
        ? { text: "{tested} of {n} active AI visibility prompt(s) tested at least once.", params: { tested: ai.testedPrompts, n: ai.activePrompts } }
        : !ai.providerConfigured
          ? { text: "Not connected" }
          : ai.activePrompts === 0
            ? { text: "No active AI visibility prompt for this product yet." }
            : { text: "{tested} of {n} active AI visibility prompt(s) tested at least once.", params: { tested: ai.testedPrompts, n: ai.activePrompts } },
      href: aiDone || ai.providerConfigured ? `/ai-visibility?product=${f.slug}` : "/settings/integrations",
    },
    {
      key: "referral_code",
      phase: "PRE_LAUNCH",
      label: "Referral code active",
      status: f.referrals.activeCodes > 0 ? "DONE" : "TODO",
      blocking: false,
      evidence: { text: "{n} active referral code(s) for this product.", params: { n: f.referrals.activeCodes } },
      href: "/referrals",
    },
    {
      key: "revenue_source",
      phase: "PRE_LAUNCH",
      label: "Revenue source connected",
      status: revenueDone ? "DONE" : f.revenue.stripe === "FAILING" ? "TODO" : "NOT_CONNECTED",
      blocking: false,
      evidence:
        f.revenue.events > 0
          ? { text: "{n} revenue event(s) or subscription(s) received for this product.", params: { n: f.revenue.events } }
          : f.revenue.stripe === "CONNECTED"
            ? { text: "Stripe is connected; no revenue event for this product yet." }
            : f.revenue.stripe === "FAILING"
              ? { text: "Stripe is configured but its last sync failed." }
              : { text: "Not connected" },
      href: f.revenue.events > 0 ? "/revenue" : "/settings/integrations",
    },
    {
      key: "announcement_published",
      phase: "LAUNCH_DAY",
      label: "Launch announcement published",
      status: f.launchContent.published > 0 ? "DONE" : "TODO",
      blocking: false,
      evidence: { text: "{n} published release announcement(s).", params: { n: f.launchContent.published } },
      href: `/content?product=${f.slug}&type=RELEASE_ANNOUNCEMENT`,
    },
    {
      key: "submissions",
      phase: "LAUNCH_DAY",
      label: "Distribution submissions sent",
      status: f.distribution.submitted > 0 ? "DONE" : "TODO",
      blocking: false,
      evidence: { text: "{n} target(s) submitted, published or performing (each approved by a human).", params: { n: f.distribution.submitted } },
      href: `/distribution?product=${f.slug}`,
    },
    {
      key: "first_events",
      phase: "POST_LAUNCH",
      label: "Events received since launch",
      status: !f.launchedAt ? "TODO" : f.tracking.activeKeys === 0 ? "NOT_CONNECTED" : f.postLaunch.eventsSince > 0 ? "DONE" : "TODO",
      blocking: false,
      evidence: !f.launchedAt ? { text: "Not launched yet." } : f.tracking.activeKeys === 0 ? { text: "Not connected" } : { text: "{n} event(s) since launch.", params: { n: f.postLaunch.eventsSince } },
      href: `${base}/tracking`,
    },
    {
      key: "search_since_launch",
      phase: "POST_LAUNCH",
      label: "Search data since launch",
      status: !f.launchedAt ? "TODO" : f.searchConsole === "NOT_CONNECTED" ? "NOT_CONNECTED" : f.postLaunch.searchDaysSince > 0 ? "DONE" : "TODO",
      blocking: false,
      evidence: !f.launchedAt ? { text: "Not launched yet." } : f.searchConsole === "NOT_CONNECTED" ? { text: "Not connected" } : { text: "{n} day(s) of search data since launch.", params: { n: f.postLaunch.searchDaysSince } },
      href: `/queries/search?product=${f.slug}`,
    },
    {
      key: "analytics_since_launch",
      phase: "POST_LAUNCH",
      label: "Analytics data since launch",
      status: !f.launchedAt ? "TODO" : f.analytics === "NOT_CONNECTED" ? "NOT_CONNECTED" : f.postLaunch.analyticsDaysSince > 0 ? "DONE" : "TODO",
      blocking: false,
      evidence: !f.launchedAt ? { text: "Not launched yet." } : f.analytics === "NOT_CONNECTED" ? { text: "Not connected" } : { text: "{n} day(s) of analytics data since launch.", params: { n: f.postLaunch.analyticsDaysSince } },
      href: "/conversions",
    },
  ];
  return items;
}

/** Blocking items that are not done. */
export const openBlockers = (items: ChecklistItem[]) => items.filter((i) => i.blocking && i.status !== "DONE");

/**
 * Effective phase for display. OFF stays off. PRE_LAUNCH stays pre-launch
 * until a human launches. LAUNCH is "launch day" on the launch date and
 * becomes POST_LAUNCH afterwards; monitoring covers the 14 days after launch.
 */
export function launchPhase(p: { launchMode: LaunchMode; launchDate: string | null; launchedAt: Date | string | null }, now: Date = new Date()): { mode: LaunchMode; phase: LaunchPhase | null; dayOfLaunch: number | null; monitoring: boolean } {
  if (p.launchMode === "OFF") return { mode: "OFF", phase: null, dayOfLaunch: null, monitoring: false };
  if (p.launchMode === "PRE_LAUNCH") return { mode: "PRE_LAUNCH", phase: "PRE_LAUNCH", dayOfLaunch: null, monitoring: false };
  const launchDay = p.launchDate ?? (p.launchedAt ? new Date(p.launchedAt).toISOString().slice(0, 10) : null);
  if (!launchDay) return { mode: p.launchMode, phase: p.launchMode === "LAUNCH" ? "LAUNCH_DAY" : "POST_LAUNCH", dayOfLaunch: null, monitoring: false };
  const today = now.toISOString().slice(0, 10);
  const day = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${launchDay}T00:00:00Z`)) / 86_400_000);
  const monitoring = day >= 0 && day <= MONITORING_DAYS;
  if (p.launchMode === "LAUNCH" && day <= 0) return { mode: "LAUNCH", phase: "LAUNCH_DAY", dayOfLaunch: day, monitoring };
  return { mode: day > 0 ? "POST_LAUNCH" : p.launchMode, phase: "POST_LAUNCH", dayOfLaunch: day, monitoring };
}

export type DailyPoint = { day: string; value: number | null };
export type DeltaRow = { day: string; value: number | null; delta: number | null };

/** Day-over-day deltas of a daily series. A missing day (null) has no delta, and the next day's delta is unknown too. */
export function dailyDeltas(points: DailyPoint[]): DeltaRow[] {
  return points.map((p, i) => {
    const prev = i > 0 ? points[i - 1].value : null;
    return { day: p.day, value: p.value, delta: p.value === null || prev === null ? null : p.value - prev };
  });
}
