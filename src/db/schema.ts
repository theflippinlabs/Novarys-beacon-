/**
 * Novarys Beacon — canonical database schema.
 *
 * Conventions
 * - Every tenant-owned table carries `organization_id` and is protected by
 *   Postgres Row Level Security (see migrations/0001_rls.sql). Application
 *   code ALSO filters by organization explicitly (defence in depth).
 * - Money is stored in minor units (cents) as bigint + ISO currency.
 * - "Unknown" is a first-class state: nullable columns mean "not provided",
 *   and verification columns track whether a human validated a fact.
 */
import { relations, sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const id = () => uuid("id").primaryKey().defaultRandom();
const orgId = () =>
  uuid("organization_id")
    .notNull()
    .references(() => organizations.id, { onDelete: "cascade" });
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date());

// ─── Enums ──────────────────────────────────────────────────────────────
export const roleEnum = pgEnum("member_role", ["OWNER", "ADMIN", "EDITOR", "ANALYST", "VIEWER"]);
export const productStatusEnum = pgEnum("product_status", ["UNKNOWN", "IN_DEVELOPMENT", "BETA", "LIVE", "DEPRECATED"]);
export const verificationEnum = pgEnum("verification_status", ["UNVERIFIED", "NEEDS_REVIEW", "VERIFIED", "REJECTED"]);
export const facetKindEnum = pgEnum("facet_kind", [
  "FEATURE",
  "USE_CASE",
  "AUDIENCE",
  "INDUSTRY",
  "PROBLEM",
  "INTEGRATION",
  "DIFFERENTIATOR",
]);
export const sourceKindEnum = pgEnum("source_kind", [
  "WEBSITE",
  "DOCUMENTATION",
  "PRICING",
  "CHANGELOG",
  "CASE_STUDY",
  "PRESS",
  "REPOSITORY",
  "LEGAL",
  "OTHER",
]);
export const proofKindEnum = pgEnum("proof_kind", ["TESTIMONIAL", "CASE_STUDY", "METRIC", "AWARD", "REVIEW", "CERTIFICATION"]);
export const billingIntervalEnum = pgEnum("billing_interval", ["ONE_TIME", "MONTH", "YEAR", "USAGE", "CUSTOM"]);
export const queryIntentEnum = pgEnum("query_intent", [
  "INFORMATIONAL",
  "COMMERCIAL",
  "TRANSACTIONAL",
  "NAVIGATIONAL",
  "COMPARISON",
  "PROBLEM",
  "ALTERNATIVE",
]);
export const funnelStageEnum = pgEnum("funnel_stage", ["AWARENESS", "CONSIDERATION", "DECISION", "RETENTION"]);
export const coverageEnum = pgEnum("coverage_status", ["NONE", "PARTIAL", "COVERED"]);
export const queryStatusEnum = pgEnum("query_status", ["CANDIDATE", "ACTIVE", "ARCHIVED"]);
export const querySourceEnum = pgEnum("query_source", ["MANUAL", "GENERATED", "IMPORTED", "SEARCH_CONSOLE"]);
export const pageTypeEnum = pgEnum("page_type", [
  "PRODUCT",
  "FEATURE",
  "USE_CASE",
  "INDUSTRY",
  "AUDIENCE",
  "INTEGRATION",
  "COMPARISON",
  "ALTERNATIVE",
  "GUIDE",
  "ANSWER",
  "DOCS",
  "CHANGELOG",
  "OTHER",
]);
export const pageStatusEnum = pgEnum("page_status", ["PLANNED", "DRAFT", "IN_REVIEW", "APPROVED", "PUBLISHED", "ARCHIVED"]);
export const pageOriginEnum = pgEnum("page_origin", ["PLANNED", "INVENTORY"]);
export const contentTypeEnum = pgEnum("content_type", [
  "LANDING_PAGE",
  "ARTICLE",
  "FAQ",
  "TUTORIAL",
  "COMPARISON",
  "RELEASE_ANNOUNCEMENT",
  "X_POST",
  "LINKEDIN_POST",
  "TIKTOK_SCRIPT",
  "SHORT_VIDEO_SCRIPT",
  "NEWSLETTER",
  "DIRECTORY_DESCRIPTION",
  "OUTREACH",
]);
export const contentStatusEnum = pgEnum("content_status", [
  "IDEA",
  "GENERATED",
  "FACT_CHECK",
  "SEO_CHECK",
  "HUMAN_APPROVAL",
  "APPROVED",
  "PUBLISHED",
  "REJECTED",
]);
export const severityEnum = pgEnum("severity", ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]);
export const issueStatusEnum = pgEnum("issue_status", ["OPEN", "RESOLVED", "IGNORED"]);
export const runStatusEnum = pgEnum("run_status", ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED"]);
export const potentialEnum = pgEnum("potential", ["LOW", "MEDIUM", "HIGH"]);
export const opportunityStatusEnum = pgEnum("opportunity_status", ["OPEN", "ACCEPTED", "IN_PROGRESS", "DONE", "DISMISSED"]);
export const distributionKindEnum = pgEnum("distribution_kind", [
  "DIRECTORY",
  "LAUNCH_PLATFORM",
  "COMMUNITY",
  "SOCIAL_CHANNEL",
  "NEWSLETTER",
  "PARTNER",
  "AFFILIATE",
  "INFLUENCER",
  "AGENCY",
  "MEDIA",
  "BACKLINK",
]);
export const distributionStatusEnum = pgEnum("distribution_status", [
  "DISCOVERED",
  "QUALIFIED",
  "PREPARED",
  "SUBMITTED",
  "PUBLISHED",
  "REJECTED",
  "FOLLOW_UP",
  "PERFORMING",
]);
export const conversionEventEnum = pgEnum("conversion_event_type", [
  "PAGE_VIEW",
  "CTA_CLICK",
  "SIGNUP",
  "TRIAL_STARTED",
  "ACTIVATED",
  "CHECKOUT_STARTED",
  "SUBSCRIBED",
  "UPGRADED",
  "CANCELLED",
]);
export const channelEnum = pgEnum("acquisition_channel", [
  "ORGANIC_SEARCH",
  "AI_REFERRAL",
  "REFERRAL",
  "AFFILIATE",
  "SOCIAL",
  "EMAIL",
  "PAID",
  "DIRECT",
  "CROSS_SELL",
  "OTHER",
]);
export const subscriptionStatusEnum = pgEnum("subscription_status", ["TRIALING", "ACTIVE", "PAST_DUE", "CANCELLED"]);
export const revenueTypeEnum = pgEnum("revenue_event_type", [
  "NEW",
  "RENEWAL",
  "UPGRADE",
  "DOWNGRADE",
  "CHURN",
  "ONE_TIME",
  "REFUND",
]);
export const commissionStatusEnum = pgEnum("commission_status", ["PENDING", "APPROVED", "PAID", "VOID", "ON_HOLD"]);
export const affiliateStatusEnum = pgEnum("affiliate_status", ["PENDING", "ACTIVE", "SUSPENDED"]);
export const crossSellEventEnum = pgEnum("cross_sell_event_type", ["IMPRESSION", "CLICK", "CONVERSION", "DISMISS"]);
export const experimentStatusEnum = pgEnum("experiment_status", ["DRAFT", "RUNNING", "READY_FOR_REVIEW", "CONCLUDED", "ABANDONED"]);
export const recommendationStatusEnum = pgEnum("recommendation_status", ["PROPOSED", "APPROVED", "REJECTED", "DONE"]);
export const integrationProviderEnum = pgEnum("integration_provider", [
  "GOOGLE_SEARCH_CONSOLE",
  "GOOGLE_ANALYTICS",
  "BING_WEBMASTER",
  "STRIPE",
  "ANTHROPIC",
  "OPENAI",
  "PERPLEXITY",
]);
export const integrationStatusEnum = pgEnum("integration_status", ["NOT_CONNECTED", "CONNECTED", "ERROR", "DISABLED"]);
export const jobStatusEnum = pgEnum("job_status", ["QUEUED", "RUNNING", "SUCCEEDED", "FAILED", "DEAD", "CANCELLED"]);
export const apiKeyKindEnum = pgEnum("api_key_kind", ["PUBLISHABLE", "SECRET"]);
export const campaignStatusEnum = pgEnum("campaign_status", ["DRAFT", "ACTIVE", "PAUSED", "ENDED"]);

// ─── Identity, tenancy & access ─────────────────────────────────────────
export const organizations = pgTable("organizations", {
  id: id(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  /** Branding and org-specific behaviour (never hard-code Novarys assumptions in core services). */
  branding: jsonb("branding").$type<{ displayName?: string; accent?: string; logoUrl?: string }>().notNull().default({}),
  settings: jsonb("settings")
    .$type<{
      attribution?: { model: "LAST_TOUCH" | "FIRST_TOUCH"; lookbackDays: number; referralPrecedence: boolean };
      crossSell?: { globalDailyCap: number };
      publicSiteEnabled?: boolean;
    }>()
    .notNull()
    .default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const users = pgTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const memberships = pgTable(
  "memberships",
  {
    organizationId: orgId(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: roleEnum("role").notNull().default("VIEWER"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.organizationId, t.userId] }), index("memberships_user_idx").on(t.userId)],
);

export const sessions = pgTable(
  "sessions",
  {
    /** SHA-256 of the opaque session token; the raw token only lives in the cookie. */
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

export const apiKeys = pgTable(
  "api_keys",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    kind: apiKeyKindEnum("kind").notNull(),
    prefix: text("prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    scopes: text("scopes").array().notNull().default(sql`'{}'::text[]`),
    /** Browser origins allowed to use a publishable key. */
    allowedOrigins: text("allowed_origins").array().notNull().default(sql`'{}'::text[]`),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("api_keys_org_idx").on(t.organizationId)],
);

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: id(),
    organizationId: orgId(),
    actorUserId: uuid("actor_user_id").references(() => users.id, { onDelete: "set null" }),
    actorType: text("actor_type").notNull().default("USER"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ipHash: text("ip_hash"),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_org_created_idx").on(t.organizationId, t.createdAt)],
);

export const rateLimitBuckets = pgTable(
  "rate_limit_buckets",
  {
    key: text("key").notNull(),
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.key, t.windowStart] })],
);

// ─── Product knowledge graph ────────────────────────────────────────────
export const products = pgTable(
  "products",
  {
    id: id(),
    organizationId: orgId(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    domain: text("domain"),
    logoUrl: text("logo_url"),
    screenshots: jsonb("screenshots").$type<{ url: string; alt: string }[]>().notNull().default([]),
    shortDescription: text("short_description"),
    fullDescription: text("full_description"),
    howItWorks: text("how_it_works"),
    category: text("category"),
    status: productStatusEnum("status").notNull().default("UNKNOWN"),
    releaseDate: date("release_date"),
    languages: text("languages").array().notNull().default(sql`'{}'::text[]`),
    supportedCountries: text("supported_countries").array().notNull().default(sql`'{}'::text[]`),
    documentationUrl: text("documentation_url"),
    /** null = unknown. */
    apiAvailable: boolean("api_available"),
    freeTrial: boolean("free_trial"),
    pricingUrl: text("pricing_url"),
    socialAccounts: jsonb("social_accounts").$type<{ network: string; url: string }[]>().notNull().default([]),
    conversionUrls: jsonb("conversion_urls")
      .$type<{ label: string; url: string; kind: "TRY_FREE" | "START_NOW" | "VIEW_DEMO" | "COMPARE_PLANS" | "BOOK_DEMO" | "ASK" | "OTHER" }[]>()
      .notNull()
      .default([]),
    trackingParams: jsonb("tracking_params").$type<Record<string, string>>().notNull().default({}),
    keywords: text("keywords").array().notNull().default(sql`'{}'::text[]`),
    semanticEntities: jsonb("semantic_entities").$type<{ name: string; type: string; sameAs?: string }[]>().notNull().default([]),
    onboardingStep: integer("onboarding_step").notNull().default(0),
    onboardingCompletedAt: timestamp("onboarding_completed_at", { withTimezone: true }),
    lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("products_org_slug_uq").on(t.organizationId, t.slug), index("products_org_idx").on(t.organizationId)],
);

export const productSources = pgTable(
  "product_sources",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    title: text("title").notNull(),
    kind: sourceKindEnum("kind").notNull().default("WEBSITE"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    httpStatus: integer("http_status"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("product_sources_uq").on(t.productId, t.url)],
);

/**
 * Facets normalise the repeated "list of named things" parts of the knowledge
 * graph (features, use cases, audiences, industries, problems, integrations,
 * differentiators) into one table discriminated by `kind`.
 */
export const productFacets = pgTable(
  "product_facets",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    kind: facetKindEnum("kind").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    sourceId: uuid("source_id").references(() => productSources.id, { onDelete: "set null" }),
    verification: verificationEnum("verification").notNull().default("UNVERIFIED"),
    sortOrder: integer("sort_order").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("product_facets_uq").on(t.productId, t.kind, t.slug),
    index("product_facets_org_kind_idx").on(t.organizationId, t.kind),
  ],
);

export const productPricing = pgTable("product_pricing", {
  id: id(),
  organizationId: orgId(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  planName: text("plan_name").notNull(),
  /** null = price not public / unknown. */
  priceCents: bigint("price_cents", { mode: "number" }),
  currency: text("currency").notNull().default("EUR"),
  interval: billingIntervalEnum("interval").notNull().default("MONTH"),
  description: text("description"),
  includedFeatures: text("included_features").array().notNull().default(sql`'{}'::text[]`),
  trialDays: integer("trial_days"),
  sourceId: uuid("source_id").references(() => productSources.id, { onDelete: "set null" }),
  verification: verificationEnum("verification").notNull().default("UNVERIFIED"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const productFaqs = pgTable("product_faqs", {
  id: id(),
  organizationId: orgId(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  question: text("question").notNull(),
  answer: text("answer").notNull(),
  sourceId: uuid("source_id").references(() => productSources.id, { onDelete: "set null" }),
  verification: verificationEnum("verification").notNull().default("UNVERIFIED"),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const productProofs = pgTable("product_proofs", {
  id: id(),
  organizationId: orgId(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  kind: proofKindEnum("kind").notNull(),
  title: text("title").notNull(),
  content: text("content").notNull(),
  attribution: text("attribution"),
  sourceId: uuid("source_id").references(() => productSources.id, { onDelete: "set null" }),
  verification: verificationEnum("verification").notNull().default("UNVERIFIED"),
  /** Explicit permission to publish (testimonials, customer names). */
  publishable: boolean("publishable").notNull().default(false),
  createdAt: createdAt(),
});

export const productChangelog = pgTable("product_changelog", {
  id: id(),
  organizationId: orgId(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  version: text("version"),
  releasedOn: date("released_on").notNull(),
  title: text("title").notNull(),
  body: text("body"),
  sourceId: uuid("source_id").references(() => productSources.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

export const competitors = pgTable(
  "competitors",
  {
    id: id(),
    organizationId: orgId(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    domain: text("domain"),
    notes: text("notes"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("competitors_org_slug_uq").on(t.organizationId, t.slug)],
);

export const productCompetitors = pgTable(
  "product_competitors",
  {
    organizationId: orgId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    competitorId: uuid("competitor_id")
      .notNull()
      .references(() => competitors.id, { onDelete: "cascade" }),
    /** Factual comparison points; each must carry a source URL. */
    comparisonFacts: jsonb("comparison_facts")
      .$type<{ dimension: string; product: string; competitor: string; sourceUrl: string; verifiedAt?: string }[]>()
      .notNull()
      .default([]),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.productId, t.competitorId] })],
);

// ─── Discovery: queries, pages, content ─────────────────────────────────
export const queryClusters = pgTable(
  "query_clusters",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    pillarPageId: uuid("pillar_page_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("query_clusters_uq").on(t.organizationId, t.productId, t.slug)],
);

export const queries = pgTable(
  "queries",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    clusterId: uuid("cluster_id").references(() => queryClusters.id, { onDelete: "set null" }),
    query: text("query").notNull(),
    normalized: text("normalized").notNull(),
    intent: queryIntentEnum("intent").notNull(),
    intentConfidence: doublePrecision("intent_confidence").notNull().default(0.5),
    market: text("market").notNull().default("global"),
    language: text("language").notNull().default("en"),
    funnelStage: funnelStageEnum("funnel_stage").notNull(),
    /** 1 (low) … 5 (critical); a human estimate or derived from measured demand. */
    importance: integer("importance").notNull().default(3),
    coverage: coverageEnum("coverage").notNull().default("NONE"),
    pageId: uuid("page_id").references(() => pages.id, { onDelete: "set null" }),
    status: queryStatusEnum("status").notNull().default("ACTIVE"),
    source: querySourceEnum("source").notNull().default("MANUAL"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    notes: text("notes"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("queries_uq").on(t.organizationId, t.normalized, t.language, t.market),
    index("queries_product_idx").on(t.productId),
    index("queries_org_status_idx").on(t.organizationId, t.status),
  ],
);

export const pages = pgTable(
  "pages",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    type: pageTypeEnum("type").notNull(),
    path: text("path").notNull(),
    title: text("title").notNull(),
    status: pageStatusEnum("status").notNull().default("PLANNED"),
    origin: pageOriginEnum("origin").notNull().default("PLANNED"),
    facetId: uuid("facet_id").references(() => productFacets.id, { onDelete: "set null" }),
    competitorId: uuid("competitor_id").references(() => competitors.id, { onDelete: "set null" }),
    targetQueryId: uuid("target_query_id"),
    contentAssetId: uuid("content_asset_id"),
    /** Publication gate breakdown (see core/discovery/quality.ts). */
    quality: jsonb("quality").$type<Record<string, number | string | boolean>>().notNull().default({}),
    qualityScore: doublePrecision("quality_score"),
    lastCrawledAt: timestamp("last_crawled_at", { withTimezone: true }),
    httpStatus: integer("http_status"),
    indexable: boolean("indexable"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("pages_org_product_path_uq").on(t.organizationId, t.productId, t.path),
    index("pages_org_status_idx").on(t.organizationId, t.status),
  ],
);

export const contentAssets = pgTable(
  "content_assets",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    pageId: uuid("page_id").references(() => pages.id, { onDelete: "set null" }),
    targetQueryId: uuid("target_query_id").references(() => queries.id, { onDelete: "set null" }),
    type: contentTypeEnum("type").notNull(),
    title: text("title").notNull(),
    brief: text("brief"),
    status: contentStatusEnum("status").notNull().default("IDEA"),
    currentVersion: integer("current_version").notNull().default(0),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    approvedBy: uuid("approved_by").references(() => users.id, { onDelete: "set null" }),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    rejectionReason: text("rejection_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("content_assets_org_status_idx").on(t.organizationId, t.status)],
);

export type ClaimCheck = {
  claim: string;
  status: "SUPPORTED" | "UNSUPPORTED" | "NEEDS_REVIEW";
  factRef?: string;
  sourceUrl?: string;
};

export const contentVersions = pgTable(
  "content_versions",
  {
    id: id(),
    organizationId: orgId(),
    assetId: uuid("asset_id")
      .notNull()
      .references(() => contentAssets.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    body: text("body").notNull(),
    metaTitle: text("meta_title"),
    metaDescription: text("meta_description"),
    structuredData: jsonb("structured_data").$type<Record<string, unknown>[]>().notNull().default([]),
    factRefs: jsonb("fact_refs").$type<{ ref: string; sourceUrl?: string }[]>().notNull().default([]),
    factCheck: jsonb("fact_check").$type<{ passed: boolean; claims: ClaimCheck[]; checkedAt: string } | null>(),
    seoCheck: jsonb("seo_check").$type<{ passed: boolean; checks: { rule: string; ok: boolean; message: string }[] } | null>(),
    aiRunId: uuid("ai_run_id"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("content_versions_uq").on(t.assetId, t.version)],
);

// ─── SEO ────────────────────────────────────────────────────────────────
export const seoAudits = pgTable(
  "seo_audits",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    status: runStatusEnum("status").notNull().default("QUEUED"),
    startUrl: text("start_url").notNull(),
    maxPages: integer("max_pages").notNull().default(50),
    pagesCrawled: integer("pages_crawled").notNull().default(0),
    summary: jsonb("summary").$type<Record<string, number>>().notNull().default({}),
    error: text("error"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("seo_audits_product_idx").on(t.productId, t.createdAt)],
);

export const seoIssues = pgTable(
  "seo_issues",
  {
    id: id(),
    organizationId: orgId(),
    auditId: uuid("audit_id")
      .notNull()
      .references(() => seoAudits.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    rule: text("rule").notNull(),
    severity: severityEnum("severity").notNull(),
    message: text("message").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    status: issueStatusEnum("status").notNull().default("OPEN"),
    createdAt: createdAt(),
  },
  (t) => [index("seo_issues_audit_idx").on(t.auditId), index("seo_issues_org_sev_idx").on(t.organizationId, t.severity, t.status)],
);

export const crawledPages = pgTable(
  "crawled_pages",
  {
    id: id(),
    organizationId: orgId(),
    auditId: uuid("audit_id")
      .notNull()
      .references(() => seoAudits.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    status: integer("status"),
    title: text("title"),
    metaDescription: text("meta_description"),
    canonical: text("canonical"),
    indexable: boolean("indexable"),
    wordCount: integer("word_count"),
    loadMs: integer("load_ms"),
    bytes: integer("bytes"),
    inlinks: integer("inlinks").notNull().default(0),
    outlinks: jsonb("outlinks").$type<string[]>().notNull().default([]),
    structuredDataTypes: text("structured_data_types").array().notNull().default(sql`'{}'::text[]`),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("crawled_pages_uq").on(t.auditId, t.url)],
);

// ─── Visibility monitoring ──────────────────────────────────────────────
/** Daily time series imported from providers or computed from first-party events. */
export const visibilityMetrics = pgTable(
  "visibility_metrics",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    metric: text("metric").notNull(),
    day: date("day").notNull(),
    dimension: text("dimension").notNull().default(""),
    value: doublePrecision("value").notNull(),
    /** Denominator for averaged metrics (e.g. impressions for position). */
    weight: doublePrecision("weight"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("visibility_metrics_uq").on(t.productId, t.provider, t.metric, t.day, t.dimension),
    index("visibility_metrics_org_day_idx").on(t.organizationId, t.metric, t.day),
  ],
);

export const aiVisibilityPrompts = pgTable("ai_visibility_prompts", {
  id: id(),
  organizationId: orgId(),
  productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
  prompt: text("prompt").notNull(),
  category: text("category"),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const aiVisibilityTests = pgTable(
  "ai_visibility_tests",
  {
    id: id(),
    organizationId: orgId(),
    promptId: uuid("prompt_id")
      .notNull()
      .references(() => aiVisibilityPrompts.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
    response: text("response").notNull(),
    productsMentioned: jsonb("products_mentioned").$type<{ productId: string; name: string; position: number }[]>().notNull().default([]),
    competitorsMentioned: jsonb("competitors_mentioned").$type<{ competitorId: string; name: string; position: number }[]>().notNull().default([]),
    citations: jsonb("citations").$type<string[]>().notNull().default([]),
    ownDomainCited: boolean("own_domain_cited").notNull().default(false),
    orgMentioned: boolean("org_mentioned").notNull().default(false),
    /** Rank among all detected entities, only when objectively measurable. */
    position: integer("position"),
    label: text("label").notNull().default("SAMPLED_OBSERVATION"),
    createdAt: createdAt(),
  },
  (t) => [index("ai_visibility_tests_prompt_idx").on(t.promptId, t.ranAt)],
);

export const aiMentions = pgTable("ai_mentions", {
  id: id(),
  organizationId: orgId(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  testId: uuid("test_id").references(() => aiVisibilityTests.id, { onDelete: "cascade" }),
  engine: text("engine").notNull(),
  source: text("source").notNull(),
  url: text("url"),
  context: text("context"),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
});

// ─── Intelligence ───────────────────────────────────────────────────────
export type OpportunityAction = { order: number; action: string; kind: string; done?: boolean };

export const opportunities = pgTable(
  "opportunities",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    queryId: uuid("query_id").references(() => queries.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    title: text("title").notNull(),
    problem: text("problem").notNull(),
    evidence: jsonb("evidence").$type<{ label: string; value: string }[]>().notNull().default([]),
    competitors: jsonb("competitors").$type<string[]>().notNull().default([]),
    actions: jsonb("actions").$type<OpportunityAction[]>().notNull().default([]),
    potential: potentialEnum("potential").notNull(),
    impact: integer("impact").notNull(),
    confidence: integer("confidence").notNull(),
    effort: integer("effort").notNull(),
    urgency: integer("urgency").notNull(),
    priorityScore: doublePrecision("priority_score").notNull(),
    status: opportunityStatusEnum("status").notNull().default("OPEN"),
    /** Deterministic key so regeneration is idempotent. */
    fingerprint: text("fingerprint").notNull(),
    generatedBy: text("generated_by").notNull().default("rules"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("opportunities_fingerprint_uq").on(t.organizationId, t.fingerprint),
    index("opportunities_org_status_idx").on(t.organizationId, t.status, t.priorityScore),
  ],
);

export const growthReports = pgTable("growth_reports", {
  id: id(),
  organizationId: orgId(),
  productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
  periodStart: date("period_start").notNull(),
  periodEnd: date("period_end").notNull(),
  sections: jsonb("sections").$type<Record<string, unknown>>().notNull(),
  generatedBy: text("generated_by").notNull(),
  createdAt: createdAt(),
});

export const recommendations = pgTable(
  "recommendations",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    reportId: uuid("report_id").references(() => growthReports.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    /** Affects production content, external accounts or paid campaigns. */
    requiresApproval: boolean("requires_approval").notNull().default(true),
    status: recommendationStatusEnum("status").notNull().default("PROPOSED"),
    decidedBy: uuid("decided_by").references(() => users.id, { onDelete: "set null" }),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("recommendations_org_status_idx").on(t.organizationId, t.status)],
);

export const experiments = pgTable("experiments", {
  id: id(),
  organizationId: orgId(),
  productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  hypothesis: text("hypothesis").notNull(),
  primaryMetric: text("primary_metric").notNull(),
  signalToMonitor: text("signal_to_monitor"),
  status: experimentStatusEnum("status").notNull().default("DRAFT"),
  startsOn: date("starts_on"),
  endsOn: date("ends_on"),
  result: text("result"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const aiRuns = pgTable(
  "ai_runs",
  {
    id: id(),
    organizationId: orgId(),
    task: text("task").notNull(),
    provider: text("provider").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    inputHash: text("input_hash").notNull(),
    output: jsonb("output").$type<unknown>(),
    confidence: doublePrecision("confidence"),
    sources: jsonb("sources").$type<string[]>().notNull().default([]),
    latencyMs: integer("latency_ms"),
    status: text("status").notNull(),
    error: text("error"),
    reviewedBy: uuid("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("ai_runs_org_task_idx").on(t.organizationId, t.task, t.createdAt)],
);

// ─── Distribution ───────────────────────────────────────────────────────
export const campaigns = pgTable(
  "campaigns",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    channel: channelEnum("channel").notNull(),
    utmSource: text("utm_source").notNull(),
    utmMedium: text("utm_medium").notNull(),
    utmCampaign: text("utm_campaign").notNull(),
    status: campaignStatusEnum("status").notNull().default("DRAFT"),
    startsOn: date("starts_on"),
    endsOn: date("ends_on"),
    budgetCents: bigint("budget_cents", { mode: "number" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("campaigns_utm_uq").on(t.organizationId, t.utmSource, t.utmMedium, t.utmCampaign)],
);

export const distributionTargets = pgTable(
  "distribution_targets",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    kind: distributionKindEnum("kind").notNull(),
    name: text("name").notNull(),
    url: text("url"),
    status: distributionStatusEnum("status").notNull().default("DISCOVERED"),
    relevance: integer("relevance"),
    notes: text("notes"),
    contentAssetId: uuid("content_asset_id").references(() => contentAssets.id, { onDelete: "set null" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    submissionApprovedBy: uuid("submission_approved_by").references(() => users.id, { onDelete: "set null" }),
    submissionApprovedAt: timestamp("submission_approved_at", { withTimezone: true }),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    publishedUrl: text("published_url"),
    followUpOn: date("follow_up_on"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("distribution_targets_org_status_idx").on(t.organizationId, t.status)],
);

// ─── Novarys ID (unified identity, privacy-first) ───────────────────────
export const identities = pgTable(
  "identities",
  {
    id: id(),
    organizationId: orgId(),
    /** Stable reference supplied by the identity provider / product (never an email). */
    externalRef: text("external_ref").notNull(),
    /** Keyed HMAC of the normalised email for de-duplication and fraud checks; raw email never stored. */
    emailHash: text("email_hash"),
    consent: jsonb("consent")
      .$type<{ analytics: boolean; marketing: boolean; crossProduct: boolean; updatedAt: string }>()
      .notNull()
      .default({ analytics: false, marketing: false, crossProduct: false, updatedAt: new Date(0).toISOString() }),
    preferences: jsonb("preferences").$type<Record<string, unknown>>().notNull().default({}),
    acquisition: jsonb("acquisition").$type<{ channel?: string; campaignId?: string; referralCodeId?: string; firstTouchAt?: string }>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("identities_ref_uq").on(t.organizationId, t.externalRef), index("identities_email_idx").on(t.organizationId, t.emailHash)],
);

export const identityProducts = pgTable(
  "identity_products",
  {
    organizationId: orgId(),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    plan: text("plan"),
    status: subscriptionStatusEnum("status"),
    trialEndsAt: timestamp("trial_ends_at", { withTimezone: true }),
    /** Non-sensitive traits a product explicitly chose to share (e.g. "agency", "team_size:10-50"). */
    sharedTraits: text("shared_traits").array().notNull().default(sql`'{}'::text[]`),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.identityId, t.productId] })],
);

// ─── Referrals & affiliates ─────────────────────────────────────────────
export const affiliates = pgTable("affiliates", {
  id: id(),
  organizationId: orgId(),
  name: text("name").notNull(),
  contactEmailHash: text("contact_email_hash"),
  status: affiliateStatusEnum("status").notNull().default("PENDING"),
  commissionBps: integer("commission_bps").notNull().default(2000),
  commissionMonths: integer("commission_months").notNull().default(12),
  holdDays: integer("hold_days").notNull().default(30),
  notes: text("notes"),
  createdAt: createdAt(),
});

export const referralCodes = pgTable(
  "referral_codes",
  {
    id: id(),
    organizationId: orgId(),
    code: text("code").notNull().unique(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    affiliateId: uuid("affiliate_id").references(() => affiliates.id, { onDelete: "cascade" }),
    referrerIdentityId: uuid("referrer_identity_id").references(() => identities.id, { onDelete: "cascade" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    destinationUrl: text("destination_url").notNull(),
    active: boolean("active").notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [index("referral_codes_org_idx").on(t.organizationId)],
);

/** Every acquisition touch (visit with referral code / UTM / known referrer). */
export const attributionEvents = pgTable(
  "attribution_events",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    visitorId: text("visitor_id").notNull(),
    identityId: uuid("identity_id").references(() => identities.id, { onDelete: "set null" }),
    channel: channelEnum("channel").notNull(),
    referralCodeId: uuid("referral_code_id").references(() => referralCodes.id, { onDelete: "set null" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    utm: jsonb("utm").$type<Record<string, string>>().notNull().default({}),
    referrerHost: text("referrer_host"),
    landingUrl: text("landing_url"),
    ipHash: text("ip_hash"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("attribution_events_visitor_idx").on(t.organizationId, t.visitorId, t.occurredAt)],
);

export const conversionEvents = pgTable(
  "conversion_events",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    type: conversionEventEnum("type").notNull(),
    visitorId: text("visitor_id"),
    identityId: uuid("identity_id").references(() => identities.id, { onDelete: "set null" }),
    pageUrl: text("page_url"),
    pagePath: text("page_path"),
    ctaId: text("cta_id"),
    channel: channelEnum("channel"),
    referralCodeId: uuid("referral_code_id").references(() => referralCodes.id, { onDelete: "set null" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    properties: jsonb("properties").$type<Record<string, string | number | boolean>>().notNull().default({}),
    idempotencyKey: text("idempotency_key"),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("conversion_events_idem_uq").on(t.organizationId, t.idempotencyKey),
    index("conversion_events_org_type_idx").on(t.organizationId, t.type, t.occurredAt),
    index("conversion_events_product_idx").on(t.productId, t.occurredAt),
  ],
);

export const subscriptions = pgTable(
  "subscriptions",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    identityId: uuid("identity_id").references(() => identities.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    plan: text("plan"),
    status: subscriptionStatusEnum("status").notNull(),
    mrrCents: bigint("mrr_cents", { mode: "number" }).notNull().default(0),
    currency: text("currency").notNull().default("EUR"),
    channel: channelEnum("channel"),
    referralCodeId: uuid("referral_code_id").references(() => referralCodes.id, { onDelete: "set null" }),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("subscriptions_ext_uq").on(t.organizationId, t.provider, t.externalId)],
);

export const revenueEvents = pgTable(
  "revenue_events",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    subscriptionId: uuid("subscription_id").references(() => subscriptions.id, { onDelete: "set null" }),
    identityId: uuid("identity_id").references(() => identities.id, { onDelete: "set null" }),
    type: revenueTypeEnum("type").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    mrrDeltaCents: bigint("mrr_delta_cents", { mode: "number" }).notNull().default(0),
    currency: text("currency").notNull().default("EUR"),
    channel: channelEnum("channel").notNull().default("DIRECT"),
    campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "set null" }),
    referralCodeId: uuid("referral_code_id").references(() => referralCodes.id, { onDelete: "set null" }),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("revenue_events_ext_uq").on(t.organizationId, t.provider, t.externalId),
    index("revenue_events_org_time_idx").on(t.organizationId, t.occurredAt),
  ],
);

export const commissions = pgTable(
  "commissions",
  {
    id: id(),
    organizationId: orgId(),
    affiliateId: uuid("affiliate_id")
      .notNull()
      .references(() => affiliates.id, { onDelete: "cascade" }),
    revenueEventId: uuid("revenue_event_id")
      .notNull()
      .references(() => revenueEvents.id, { onDelete: "cascade" }),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    currency: text("currency").notNull(),
    status: commissionStatusEnum("status").notNull().default("PENDING"),
    fraudFlags: jsonb("fraud_flags").$type<string[]>().notNull().default([]),
    payableAfter: timestamp("payable_after", { withTimezone: true }).notNull(),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("commissions_uq").on(t.affiliateId, t.revenueEventId)],
);

// ─── Cross-sell ─────────────────────────────────────────────────────────
export type CrossSellConditions = {
  /** Identity must hold ALL of these shared traits. */
  requiredTraits?: string[];
  /** Minimum days since the identity started using the source product. */
  minDaysOnSource?: number;
  /** Only when the identity's status on the source product is one of these. */
  sourceStatuses?: ("TRIALING" | "ACTIVE" | "PAST_DUE" | "CANCELLED")[];
};

export const crossSellRules = pgTable("cross_sell_rules", {
  id: id(),
  organizationId: orgId(),
  sourceProductId: uuid("source_product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  destinationProductId: uuid("destination_product_id")
    .notNull()
    .references(() => products.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  conditions: jsonb("conditions").$type<CrossSellConditions>().notNull().default({}),
  message: text("message").notNull(),
  ctaLabel: text("cta_label").notNull().default("Learn more"),
  ctaUrl: text("cta_url").notNull(),
  frequencyCapDays: integer("frequency_cap_days").notNull().default(14),
  maxImpressions: integer("max_impressions").notNull().default(3),
  active: boolean("active").notNull().default(true),
  createdAt: createdAt(),
});

export const crossSellEvents = pgTable(
  "cross_sell_events",
  {
    id: id(),
    organizationId: orgId(),
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => crossSellRules.id, { onDelete: "cascade" }),
    identityId: uuid("identity_id")
      .notNull()
      .references(() => identities.id, { onDelete: "cascade" }),
    type: crossSellEventEnum("type").notNull(),
    revenueCents: bigint("revenue_cents", { mode: "number" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("cross_sell_events_rule_identity_idx").on(t.ruleId, t.identityId, t.occurredAt)],
);

// ─── Integrations & scores ──────────────────────────────────────────────
export const integrations = pgTable(
  "integrations",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id").references(() => products.id, { onDelete: "cascade" }),
    provider: integrationProviderEnum("provider").notNull(),
    /** Non-secret configuration only (site URL, property id…). Secrets live in provider_credentials. */
    config: jsonb("config").$type<Record<string, string>>().notNull().default({}),
    status: integrationStatusEnum("status").notNull().default("NOT_CONNECTED"),
    lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
    lastError: text("last_error"),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("integrations_uq").on(t.organizationId, t.provider, t.productId)],
);

export const providerCredentials = pgTable("provider_credentials", {
  id: id(),
  organizationId: orgId(),
  integrationId: uuid("integration_id")
    .notNull()
    .unique()
    .references(() => integrations.id, { onDelete: "cascade" }),
  /** AES-256-GCM envelope: v1:<iv>:<tag>:<ciphertext> (base64). */
  ciphertext: text("ciphertext").notNull(),
  keyVersion: integer("key_version").notNull().default(1),
  createdAt: createdAt(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
});

export const beaconScores = pgTable(
  "beacon_scores",
  {
    id: id(),
    organizationId: orgId(),
    productId: uuid("product_id")
      .notNull()
      .references(() => products.id, { onDelete: "cascade" }),
    total: doublePrecision("total").notNull(),
    components: jsonb("components").$type<unknown>().notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("beacon_scores_product_idx").on(t.productId, t.computedAt)],
);

// ─── Jobs ───────────────────────────────────────────────────────────────
export const jobs = pgTable(
  "jobs",
  {
    id: id(),
    organizationId: uuid("organization_id").references(() => organizations.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: jobStatusEnum("status").notNull().default("QUEUED"),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(5),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    idempotencyKey: text("idempotency_key").unique(),
    lastError: text("last_error"),
    result: jsonb("result").$type<unknown>(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [index("jobs_claim_idx").on(t.status, t.runAt), index("jobs_org_type_idx").on(t.organizationId, t.type, t.createdAt)],
);

// ─── Relations (for relational queries) ─────────────────────────────────
export const productsRelations = relations(products, ({ many }) => ({
  facets: many(productFacets),
  pricing: many(productPricing),
  faqs: many(productFaqs),
  proofs: many(productProofs),
  sources: many(productSources),
  changelog: many(productChangelog),
  competitors: many(productCompetitors),
}));
export const productFacetsRelations = relations(productFacets, ({ one }) => ({
  product: one(products, { fields: [productFacets.productId], references: [products.id] }),
  source: one(productSources, { fields: [productFacets.sourceId], references: [productSources.id] }),
}));
export const productPricingRelations = relations(productPricing, ({ one }) => ({
  product: one(products, { fields: [productPricing.productId], references: [products.id] }),
  source: one(productSources, { fields: [productPricing.sourceId], references: [productSources.id] }),
}));
export const productFaqsRelations = relations(productFaqs, ({ one }) => ({
  product: one(products, { fields: [productFaqs.productId], references: [products.id] }),
  source: one(productSources, { fields: [productFaqs.sourceId], references: [productSources.id] }),
}));
export const productProofsRelations = relations(productProofs, ({ one }) => ({
  product: one(products, { fields: [productProofs.productId], references: [products.id] }),
  source: one(productSources, { fields: [productProofs.sourceId], references: [productSources.id] }),
}));
export const productSourcesRelations = relations(productSources, ({ one }) => ({
  product: one(products, { fields: [productSources.productId], references: [products.id] }),
}));
export const productChangelogRelations = relations(productChangelog, ({ one }) => ({
  product: one(products, { fields: [productChangelog.productId], references: [products.id] }),
}));
export const productCompetitorsRelations = relations(productCompetitors, ({ one }) => ({
  product: one(products, { fields: [productCompetitors.productId], references: [products.id] }),
  competitor: one(competitors, { fields: [productCompetitors.competitorId], references: [competitors.id] }),
}));

/** Tables protected by RLS — kept in sync with migrations/0001_rls.sql by a test. */
export const TENANT_TABLES = [
  "memberships",
  "api_keys",
  "audit_logs",
  "products",
  "product_sources",
  "product_facets",
  "product_pricing",
  "product_faqs",
  "product_proofs",
  "product_changelog",
  "competitors",
  "product_competitors",
  "query_clusters",
  "queries",
  "pages",
  "content_assets",
  "content_versions",
  "seo_audits",
  "seo_issues",
  "crawled_pages",
  "visibility_metrics",
  "ai_visibility_prompts",
  "ai_visibility_tests",
  "ai_mentions",
  "opportunities",
  "growth_reports",
  "recommendations",
  "experiments",
  "ai_runs",
  "campaigns",
  "distribution_targets",
  "identities",
  "identity_products",
  "affiliates",
  "referral_codes",
  "attribution_events",
  "conversion_events",
  "subscriptions",
  "revenue_events",
  "commissions",
  "cross_sell_rules",
  "cross_sell_events",
  "integrations",
  "provider_credentials",
  "beacon_scores",
] as const;
