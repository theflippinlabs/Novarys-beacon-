CREATE TYPE "public"."affiliate_status" AS ENUM('PENDING', 'ACTIVE', 'SUSPENDED');--> statement-breakpoint
CREATE TYPE "public"."api_key_kind" AS ENUM('PUBLISHABLE', 'SECRET');--> statement-breakpoint
CREATE TYPE "public"."billing_interval" AS ENUM('ONE_TIME', 'MONTH', 'YEAR', 'USAGE', 'CUSTOM');--> statement-breakpoint
CREATE TYPE "public"."campaign_status" AS ENUM('DRAFT', 'ACTIVE', 'PAUSED', 'ENDED');--> statement-breakpoint
CREATE TYPE "public"."acquisition_channel" AS ENUM('ORGANIC_SEARCH', 'AI_REFERRAL', 'REFERRAL', 'AFFILIATE', 'SOCIAL', 'EMAIL', 'PAID', 'DIRECT', 'CROSS_SELL', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."commission_status" AS ENUM('PENDING', 'APPROVED', 'PAID', 'VOID', 'ON_HOLD');--> statement-breakpoint
CREATE TYPE "public"."content_status" AS ENUM('IDEA', 'GENERATED', 'FACT_CHECK', 'SEO_CHECK', 'HUMAN_APPROVAL', 'APPROVED', 'PUBLISHED', 'REJECTED');--> statement-breakpoint
CREATE TYPE "public"."content_type" AS ENUM('LANDING_PAGE', 'ARTICLE', 'FAQ', 'TUTORIAL', 'COMPARISON', 'RELEASE_ANNOUNCEMENT', 'X_POST', 'LINKEDIN_POST', 'TIKTOK_SCRIPT', 'SHORT_VIDEO_SCRIPT', 'NEWSLETTER', 'DIRECTORY_DESCRIPTION', 'OUTREACH');--> statement-breakpoint
CREATE TYPE "public"."conversion_event_type" AS ENUM('PAGE_VIEW', 'CTA_CLICK', 'SIGNUP', 'TRIAL_STARTED', 'ACTIVATED', 'CHECKOUT_STARTED', 'SUBSCRIBED', 'UPGRADED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."coverage_status" AS ENUM('NONE', 'PARTIAL', 'COVERED');--> statement-breakpoint
CREATE TYPE "public"."cross_sell_event_type" AS ENUM('IMPRESSION', 'CLICK', 'CONVERSION', 'DISMISS');--> statement-breakpoint
CREATE TYPE "public"."distribution_kind" AS ENUM('DIRECTORY', 'LAUNCH_PLATFORM', 'COMMUNITY', 'SOCIAL_CHANNEL', 'NEWSLETTER', 'PARTNER', 'AFFILIATE', 'INFLUENCER', 'AGENCY', 'MEDIA', 'BACKLINK');--> statement-breakpoint
CREATE TYPE "public"."distribution_status" AS ENUM('DISCOVERED', 'QUALIFIED', 'PREPARED', 'SUBMITTED', 'PUBLISHED', 'REJECTED', 'FOLLOW_UP', 'PERFORMING');--> statement-breakpoint
CREATE TYPE "public"."experiment_status" AS ENUM('DRAFT', 'RUNNING', 'READY_FOR_REVIEW', 'CONCLUDED', 'ABANDONED');--> statement-breakpoint
CREATE TYPE "public"."facet_kind" AS ENUM('FEATURE', 'USE_CASE', 'AUDIENCE', 'INDUSTRY', 'PROBLEM', 'INTEGRATION', 'DIFFERENTIATOR');--> statement-breakpoint
CREATE TYPE "public"."funnel_stage" AS ENUM('AWARENESS', 'CONSIDERATION', 'DECISION', 'RETENTION');--> statement-breakpoint
CREATE TYPE "public"."integration_provider" AS ENUM('GOOGLE_SEARCH_CONSOLE', 'GOOGLE_ANALYTICS', 'BING_WEBMASTER', 'STRIPE', 'ANTHROPIC', 'OPENAI', 'PERPLEXITY');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('NOT_CONNECTED', 'CONNECTED', 'ERROR', 'DISABLED');--> statement-breakpoint
CREATE TYPE "public"."issue_status" AS ENUM('OPEN', 'RESOLVED', 'IGNORED');--> statement-breakpoint
CREATE TYPE "public"."job_status" AS ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'DEAD', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."opportunity_status" AS ENUM('OPEN', 'ACCEPTED', 'IN_PROGRESS', 'DONE', 'DISMISSED');--> statement-breakpoint
CREATE TYPE "public"."page_origin" AS ENUM('PLANNED', 'INVENTORY');--> statement-breakpoint
CREATE TYPE "public"."page_status" AS ENUM('PLANNED', 'DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."page_type" AS ENUM('PRODUCT', 'FEATURE', 'USE_CASE', 'INDUSTRY', 'AUDIENCE', 'INTEGRATION', 'COMPARISON', 'ALTERNATIVE', 'GUIDE', 'ANSWER', 'DOCS', 'CHANGELOG', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."potential" AS ENUM('LOW', 'MEDIUM', 'HIGH');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('UNKNOWN', 'IN_DEVELOPMENT', 'BETA', 'LIVE', 'DEPRECATED');--> statement-breakpoint
CREATE TYPE "public"."proof_kind" AS ENUM('TESTIMONIAL', 'CASE_STUDY', 'METRIC', 'AWARD', 'REVIEW', 'CERTIFICATION');--> statement-breakpoint
CREATE TYPE "public"."query_intent" AS ENUM('INFORMATIONAL', 'COMMERCIAL', 'TRANSACTIONAL', 'NAVIGATIONAL', 'COMPARISON', 'PROBLEM', 'ALTERNATIVE');--> statement-breakpoint
CREATE TYPE "public"."query_source" AS ENUM('MANUAL', 'GENERATED', 'IMPORTED', 'SEARCH_CONSOLE');--> statement-breakpoint
CREATE TYPE "public"."query_status" AS ENUM('CANDIDATE', 'ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."recommendation_status" AS ENUM('PROPOSED', 'APPROVED', 'REJECTED', 'DONE');--> statement-breakpoint
CREATE TYPE "public"."revenue_event_type" AS ENUM('NEW', 'RENEWAL', 'UPGRADE', 'DOWNGRADE', 'CHURN', 'ONE_TIME', 'REFUND');--> statement-breakpoint
CREATE TYPE "public"."member_role" AS ENUM('OWNER', 'ADMIN', 'EDITOR', 'ANALYST', 'VIEWER');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED');--> statement-breakpoint
CREATE TYPE "public"."severity" AS ENUM('CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO');--> statement-breakpoint
CREATE TYPE "public"."source_kind" AS ENUM('WEBSITE', 'DOCUMENTATION', 'PRICING', 'CHANGELOG', 'CASE_STUDY', 'PRESS', 'REPOSITORY', 'LEGAL', 'OTHER');--> statement-breakpoint
CREATE TYPE "public"."subscription_status" AS ENUM('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('UNVERIFIED', 'NEEDS_REVIEW', 'VERIFIED', 'REJECTED');--> statement-breakpoint
CREATE TABLE "affiliates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"contact_email_hash" text,
	"status" "affiliate_status" DEFAULT 'PENDING' NOT NULL,
	"commission_bps" integer DEFAULT 2000 NOT NULL,
	"commission_months" integer DEFAULT 12 NOT NULL,
	"hold_days" integer DEFAULT 30 NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_mentions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"test_id" uuid,
	"engine" text NOT NULL,
	"source" text NOT NULL,
	"url" text,
	"context" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"task" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"prompt_version" text NOT NULL,
	"input_hash" text NOT NULL,
	"output" jsonb,
	"confidence" double precision,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"latency_ms" integer,
	"status" text NOT NULL,
	"error" text,
	"reviewed_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_visibility_prompts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"prompt" text NOT NULL,
	"category" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_visibility_tests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"prompt_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"ran_at" timestamp with time zone DEFAULT now() NOT NULL,
	"response" text NOT NULL,
	"products_mentioned" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"competitors_mentioned" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"own_domain_cited" boolean DEFAULT false NOT NULL,
	"org_mentioned" boolean DEFAULT false NOT NULL,
	"position" integer,
	"label" text DEFAULT 'SAMPLED_OBSERVATION' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"name" text NOT NULL,
	"kind" "api_key_kind" NOT NULL,
	"prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"allowed_origins" text[] DEFAULT '{}'::text[] NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "attribution_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"visitor_id" text NOT NULL,
	"identity_id" uuid,
	"channel" "acquisition_channel" NOT NULL,
	"referral_code_id" uuid,
	"campaign_id" uuid,
	"utm" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"referrer_host" text,
	"landing_url" text,
	"ip_hash" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_type" text DEFAULT 'USER' NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "beacon_scores" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"total" double precision NOT NULL,
	"components" jsonb NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"name" text NOT NULL,
	"channel" "acquisition_channel" NOT NULL,
	"utm_source" text NOT NULL,
	"utm_medium" text NOT NULL,
	"utm_campaign" text NOT NULL,
	"status" "campaign_status" DEFAULT 'DRAFT' NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"budget_cents" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"affiliate_id" uuid NOT NULL,
	"revenue_event_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"status" "commission_status" DEFAULT 'PENDING' NOT NULL,
	"fraud_flags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payable_after" timestamp with time zone NOT NULL,
	"paid_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "competitors" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"domain" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_assets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"page_id" uuid,
	"target_query_id" uuid,
	"type" "content_type" NOT NULL,
	"title" text NOT NULL,
	"brief" text,
	"status" "content_status" DEFAULT 'IDEA' NOT NULL,
	"current_version" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"approved_by" uuid,
	"approved_at" timestamp with time zone,
	"published_at" timestamp with time zone,
	"rejection_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "content_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"asset_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"body" text NOT NULL,
	"meta_title" text,
	"meta_description" text,
	"structured_data" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fact_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fact_check" jsonb,
	"seo_check" jsonb,
	"ai_run_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conversion_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"type" "conversion_event_type" NOT NULL,
	"visitor_id" text,
	"identity_id" uuid,
	"page_url" text,
	"page_path" text,
	"cta_id" text,
	"channel" "acquisition_channel",
	"referral_code_id" uuid,
	"campaign_id" uuid,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"idempotency_key" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "crawled_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"audit_id" uuid NOT NULL,
	"url" text NOT NULL,
	"status" integer,
	"title" text,
	"meta_description" text,
	"canonical" text,
	"indexable" boolean,
	"word_count" integer,
	"load_ms" integer,
	"bytes" integer,
	"inlinks" integer DEFAULT 0 NOT NULL,
	"outlinks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"structured_data_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cross_sell_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"rule_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"type" "cross_sell_event_type" NOT NULL,
	"revenue_cents" bigint,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cross_sell_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_product_id" uuid NOT NULL,
	"destination_product_id" uuid NOT NULL,
	"name" text NOT NULL,
	"conditions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"message" text NOT NULL,
	"cta_label" text DEFAULT 'Learn more' NOT NULL,
	"cta_url" text NOT NULL,
	"frequency_cap_days" integer DEFAULT 14 NOT NULL,
	"max_impressions" integer DEFAULT 3 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "distribution_targets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"kind" "distribution_kind" NOT NULL,
	"name" text NOT NULL,
	"url" text,
	"status" "distribution_status" DEFAULT 'DISCOVERED' NOT NULL,
	"relevance" integer,
	"notes" text,
	"content_asset_id" uuid,
	"campaign_id" uuid,
	"submission_approved_by" uuid,
	"submission_approved_at" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"published_url" text,
	"follow_up_on" date,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "experiments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"name" text NOT NULL,
	"hypothesis" text NOT NULL,
	"primary_metric" text NOT NULL,
	"signal_to_monitor" text,
	"status" "experiment_status" DEFAULT 'DRAFT' NOT NULL,
	"starts_on" date,
	"ends_on" date,
	"result" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "growth_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"sections" jsonb NOT NULL,
	"generated_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"external_ref" text NOT NULL,
	"email_hash" text,
	"consent" jsonb DEFAULT '{"analytics":false,"marketing":false,"crossProduct":false,"updatedAt":"1970-01-01T00:00:00.000Z"}'::jsonb NOT NULL,
	"preferences" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"acquisition" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "identity_products" (
	"organization_id" uuid NOT NULL,
	"identity_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"plan" text,
	"status" "subscription_status",
	"trial_ends_at" timestamp with time zone,
	"shared_traits" text[] DEFAULT '{}'::text[] NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_products_identity_id_product_id_pk" PRIMARY KEY("identity_id","product_id")
);
--> statement-breakpoint
CREATE TABLE "integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"provider" "integration_provider" NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "integration_status" DEFAULT 'NOT_CONNECTED' NOT NULL,
	"last_sync_at" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "job_status" DEFAULT 'QUEUED' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"locked_by" text,
	"idempotency_key" text,
	"last_error" text,
	"result" jsonb,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "jobs_idempotency_key_unique" UNIQUE("idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" "member_role" DEFAULT 'VIEWER' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_organization_id_user_id_pk" PRIMARY KEY("organization_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"query_id" uuid,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"problem" text NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"competitors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"actions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"potential" "potential" NOT NULL,
	"impact" integer NOT NULL,
	"confidence" integer NOT NULL,
	"effort" integer NOT NULL,
	"urgency" integer NOT NULL,
	"priority_score" double precision NOT NULL,
	"status" "opportunity_status" DEFAULT 'OPEN' NOT NULL,
	"fingerprint" text NOT NULL,
	"generated_by" text DEFAULT 'rules' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"branding" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"type" "page_type" NOT NULL,
	"path" text NOT NULL,
	"title" text NOT NULL,
	"status" "page_status" DEFAULT 'PLANNED' NOT NULL,
	"origin" "page_origin" DEFAULT 'PLANNED' NOT NULL,
	"facet_id" uuid,
	"competitor_id" uuid,
	"target_query_id" uuid,
	"content_asset_id" uuid,
	"quality" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"quality_score" double precision,
	"last_crawled_at" timestamp with time zone,
	"http_status" integer,
	"indexable" boolean,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_changelog" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"version" text,
	"released_on" date NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"source_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_competitors" (
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"competitor_id" uuid NOT NULL,
	"comparison_facts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_competitors_product_id_competitor_id_pk" PRIMARY KEY("product_id","competitor_id")
);
--> statement-breakpoint
CREATE TABLE "product_facets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"kind" "facet_kind" NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"source_id" uuid,
	"verification" "verification_status" DEFAULT 'UNVERIFIED' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_faqs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"source_id" uuid,
	"verification" "verification_status" DEFAULT 'UNVERIFIED' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_pricing" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"plan_name" text NOT NULL,
	"price_cents" bigint,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"interval" "billing_interval" DEFAULT 'MONTH' NOT NULL,
	"description" text,
	"included_features" text[] DEFAULT '{}'::text[] NOT NULL,
	"trial_days" integer,
	"source_id" uuid,
	"verification" "verification_status" DEFAULT 'UNVERIFIED' NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_proofs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"kind" "proof_kind" NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"attribution" text,
	"source_id" uuid,
	"verification" "verification_status" DEFAULT 'UNVERIFIED' NOT NULL,
	"publishable" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "product_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text NOT NULL,
	"kind" "source_kind" DEFAULT 'WEBSITE' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"http_status" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"logo_url" text,
	"screenshots" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"short_description" text,
	"full_description" text,
	"how_it_works" text,
	"category" text,
	"status" "product_status" DEFAULT 'UNKNOWN' NOT NULL,
	"release_date" date,
	"languages" text[] DEFAULT '{}'::text[] NOT NULL,
	"supported_countries" text[] DEFAULT '{}'::text[] NOT NULL,
	"documentation_url" text,
	"api_available" boolean,
	"free_trial" boolean,
	"pricing_url" text,
	"social_accounts" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"conversion_urls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tracking_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"keywords" text[] DEFAULT '{}'::text[] NOT NULL,
	"semantic_entities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"onboarding_step" integer DEFAULT 0 NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provider_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"ciphertext" text NOT NULL,
	"key_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone,
	CONSTRAINT "provider_credentials_integration_id_unique" UNIQUE("integration_id")
);
--> statement-breakpoint
CREATE TABLE "queries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"cluster_id" uuid,
	"query" text NOT NULL,
	"normalized" text NOT NULL,
	"intent" "query_intent" NOT NULL,
	"intent_confidence" double precision DEFAULT 0.5 NOT NULL,
	"market" text DEFAULT 'global' NOT NULL,
	"language" text DEFAULT 'en' NOT NULL,
	"funnel_stage" "funnel_stage" NOT NULL,
	"importance" integer DEFAULT 3 NOT NULL,
	"coverage" "coverage_status" DEFAULT 'NONE' NOT NULL,
	"page_id" uuid,
	"status" "query_status" DEFAULT 'ACTIVE' NOT NULL,
	"source" "query_source" DEFAULT 'MANUAL' NOT NULL,
	"last_checked_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "query_clusters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"pillar_page_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rate_limit_buckets" (
	"key" text NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "rate_limit_buckets_key_window_start_pk" PRIMARY KEY("key","window_start")
);
--> statement-breakpoint
CREATE TABLE "recommendations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"report_id" uuid,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"requires_approval" boolean DEFAULT true NOT NULL,
	"status" "recommendation_status" DEFAULT 'PROPOSED' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "referral_codes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"code" text NOT NULL,
	"product_id" uuid,
	"affiliate_id" uuid,
	"referrer_identity_id" uuid,
	"campaign_id" uuid,
	"destination_url" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "revenue_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"subscription_id" uuid,
	"identity_id" uuid,
	"type" "revenue_event_type" NOT NULL,
	"amount_cents" bigint NOT NULL,
	"mrr_delta_cents" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"channel" "acquisition_channel" DEFAULT 'DIRECT' NOT NULL,
	"campaign_id" uuid,
	"referral_code_id" uuid,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seo_audits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"status" "run_status" DEFAULT 'QUEUED' NOT NULL,
	"start_url" text NOT NULL,
	"max_pages" integer DEFAULT 50 NOT NULL,
	"pages_crawled" integer DEFAULT 0 NOT NULL,
	"summary" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "seo_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"audit_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"url" text NOT NULL,
	"rule" text NOT NULL,
	"severity" "severity" NOT NULL,
	"message" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "issue_status" DEFAULT 'OPEN' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"organization_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_hash" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"identity_id" uuid,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"plan" text,
	"status" "subscription_status" NOT NULL,
	"mrr_cents" bigint DEFAULT 0 NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"channel" "acquisition_channel",
	"referral_code_id" uuid,
	"campaign_id" uuid,
	"started_at" timestamp with time zone NOT NULL,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text NOT NULL,
	"last_login_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "visibility_metrics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"metric" text NOT NULL,
	"day" date NOT NULL,
	"dimension" text DEFAULT '' NOT NULL,
	"value" double precision NOT NULL,
	"weight" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "affiliates" ADD CONSTRAINT "affiliates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_mentions" ADD CONSTRAINT "ai_mentions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_mentions" ADD CONSTRAINT "ai_mentions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_mentions" ADD CONSTRAINT "ai_mentions_test_id_ai_visibility_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."ai_visibility_tests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_runs" ADD CONSTRAINT "ai_runs_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_prompts" ADD CONSTRAINT "ai_visibility_prompts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_prompts" ADD CONSTRAINT "ai_visibility_prompts_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_tests" ADD CONSTRAINT "ai_visibility_tests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_visibility_tests" ADD CONSTRAINT "ai_visibility_tests_prompt_id_ai_visibility_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."ai_visibility_prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_events" ADD CONSTRAINT "attribution_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_events" ADD CONSTRAINT "attribution_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_events" ADD CONSTRAINT "attribution_events_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_events" ADD CONSTRAINT "attribution_events_referral_code_id_referral_codes_id_fk" FOREIGN KEY ("referral_code_id") REFERENCES "public"."referral_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_events" ADD CONSTRAINT "attribution_events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beacon_scores" ADD CONSTRAINT "beacon_scores_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "beacon_scores" ADD CONSTRAINT "beacon_scores_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_affiliate_id_affiliates_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commissions" ADD CONSTRAINT "commissions_revenue_event_id_revenue_events_id_fk" FOREIGN KEY ("revenue_event_id") REFERENCES "public"."revenue_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "competitors" ADD CONSTRAINT "competitors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_target_query_id_queries_id_fk" FOREIGN KEY ("target_query_id") REFERENCES "public"."queries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_asset_id_content_assets_id_fk" FOREIGN KEY ("asset_id") REFERENCES "public"."content_assets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_versions" ADD CONSTRAINT "content_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_referral_code_id_referral_codes_id_fk" FOREIGN KEY ("referral_code_id") REFERENCES "public"."referral_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD CONSTRAINT "crawled_pages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD CONSTRAINT "crawled_pages_audit_id_seo_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."seo_audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_sell_events" ADD CONSTRAINT "cross_sell_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_sell_events" ADD CONSTRAINT "cross_sell_events_rule_id_cross_sell_rules_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."cross_sell_rules"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_sell_events" ADD CONSTRAINT "cross_sell_events_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_sell_rules" ADD CONSTRAINT "cross_sell_rules_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_sell_rules" ADD CONSTRAINT "cross_sell_rules_source_product_id_products_id_fk" FOREIGN KEY ("source_product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cross_sell_rules" ADD CONSTRAINT "cross_sell_rules_destination_product_id_products_id_fk" FOREIGN KEY ("destination_product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_targets" ADD CONSTRAINT "distribution_targets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_targets" ADD CONSTRAINT "distribution_targets_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_targets" ADD CONSTRAINT "distribution_targets_content_asset_id_content_assets_id_fk" FOREIGN KEY ("content_asset_id") REFERENCES "public"."content_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_targets" ADD CONSTRAINT "distribution_targets_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "distribution_targets" ADD CONSTRAINT "distribution_targets_submission_approved_by_users_id_fk" FOREIGN KEY ("submission_approved_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "experiments" ADD CONSTRAINT "experiments_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_reports" ADD CONSTRAINT "growth_reports_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "growth_reports" ADD CONSTRAINT "growth_reports_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_products" ADD CONSTRAINT "identity_products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_products" ADD CONSTRAINT "identity_products_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_products" ADD CONSTRAINT "identity_products_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integrations" ADD CONSTRAINT "integrations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "opportunities" ADD CONSTRAINT "opportunities_query_id_queries_id_fk" FOREIGN KEY ("query_id") REFERENCES "public"."queries"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_facet_id_product_facets_id_fk" FOREIGN KEY ("facet_id") REFERENCES "public"."product_facets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pages" ADD CONSTRAINT "pages_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_changelog" ADD CONSTRAINT "product_changelog_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_changelog" ADD CONSTRAINT "product_changelog_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_changelog" ADD CONSTRAINT "product_changelog_source_id_product_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."product_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_competitors" ADD CONSTRAINT "product_competitors_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_competitors" ADD CONSTRAINT "product_competitors_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_competitors" ADD CONSTRAINT "product_competitors_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_facets" ADD CONSTRAINT "product_facets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_facets" ADD CONSTRAINT "product_facets_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_facets" ADD CONSTRAINT "product_facets_source_id_product_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."product_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_faqs" ADD CONSTRAINT "product_faqs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_faqs" ADD CONSTRAINT "product_faqs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_faqs" ADD CONSTRAINT "product_faqs_source_id_product_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."product_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_pricing" ADD CONSTRAINT "product_pricing_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_pricing" ADD CONSTRAINT "product_pricing_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_pricing" ADD CONSTRAINT "product_pricing_source_id_product_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."product_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_proofs" ADD CONSTRAINT "product_proofs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_proofs" ADD CONSTRAINT "product_proofs_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_proofs" ADD CONSTRAINT "product_proofs_source_id_product_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."product_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_sources" ADD CONSTRAINT "product_sources_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_sources" ADD CONSTRAINT "product_sources_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_credentials" ADD CONSTRAINT "provider_credentials_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queries" ADD CONSTRAINT "queries_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queries" ADD CONSTRAINT "queries_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queries" ADD CONSTRAINT "queries_cluster_id_query_clusters_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."query_clusters"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queries" ADD CONSTRAINT "queries_page_id_pages_id_fk" FOREIGN KEY ("page_id") REFERENCES "public"."pages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_clusters" ADD CONSTRAINT "query_clusters_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "query_clusters" ADD CONSTRAINT "query_clusters_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_report_id_growth_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."growth_reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_affiliate_id_affiliates_id_fk" FOREIGN KEY ("affiliate_id") REFERENCES "public"."affiliates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_referrer_identity_id_identities_id_fk" FOREIGN KEY ("referrer_identity_id") REFERENCES "public"."identities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_subscription_id_subscriptions_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."subscriptions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_events" ADD CONSTRAINT "revenue_events_referral_code_id_referral_codes_id_fk" FOREIGN KEY ("referral_code_id") REFERENCES "public"."referral_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_audits" ADD CONSTRAINT "seo_audits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_audits" ADD CONSTRAINT "seo_audits_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_issues" ADD CONSTRAINT "seo_issues_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_issues" ADD CONSTRAINT "seo_issues_audit_id_seo_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."seo_audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "seo_issues" ADD CONSTRAINT "seo_issues_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_identity_id_identities_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_referral_code_id_referral_codes_id_fk" FOREIGN KEY ("referral_code_id") REFERENCES "public"."referral_codes"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_metrics" ADD CONSTRAINT "visibility_metrics_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visibility_metrics" ADD CONSTRAINT "visibility_metrics_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_runs_org_task_idx" ON "ai_runs" USING btree ("organization_id","task","created_at");--> statement-breakpoint
CREATE INDEX "ai_visibility_tests_prompt_idx" ON "ai_visibility_tests" USING btree ("prompt_id","ran_at");--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "attribution_events_visitor_idx" ON "attribution_events" USING btree ("organization_id","visitor_id","occurred_at");--> statement-breakpoint
CREATE INDEX "audit_logs_org_created_idx" ON "audit_logs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "beacon_scores_product_idx" ON "beacon_scores" USING btree ("product_id","computed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_utm_uq" ON "campaigns" USING btree ("organization_id","utm_source","utm_medium","utm_campaign");--> statement-breakpoint
CREATE UNIQUE INDEX "commissions_uq" ON "commissions" USING btree ("affiliate_id","revenue_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "competitors_org_slug_uq" ON "competitors" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "content_assets_org_status_idx" ON "content_assets" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "content_versions_uq" ON "content_versions" USING btree ("asset_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "conversion_events_idem_uq" ON "conversion_events" USING btree ("organization_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "conversion_events_org_type_idx" ON "conversion_events" USING btree ("organization_id","type","occurred_at");--> statement-breakpoint
CREATE INDEX "conversion_events_product_idx" ON "conversion_events" USING btree ("product_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "crawled_pages_uq" ON "crawled_pages" USING btree ("audit_id","url");--> statement-breakpoint
CREATE INDEX "cross_sell_events_rule_identity_idx" ON "cross_sell_events" USING btree ("rule_id","identity_id","occurred_at");--> statement-breakpoint
CREATE INDEX "distribution_targets_org_status_idx" ON "distribution_targets" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "identities_ref_uq" ON "identities" USING btree ("organization_id","external_ref");--> statement-breakpoint
CREATE INDEX "identities_email_idx" ON "identities" USING btree ("organization_id","email_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "integrations_uq" ON "integrations" USING btree ("organization_id","provider","product_id");--> statement-breakpoint
CREATE INDEX "jobs_claim_idx" ON "jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "jobs_org_type_idx" ON "jobs" USING btree ("organization_id","type","created_at");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_fingerprint_uq" ON "opportunities" USING btree ("organization_id","fingerprint");--> statement-breakpoint
CREATE INDEX "opportunities_org_status_idx" ON "opportunities" USING btree ("organization_id","status","priority_score");--> statement-breakpoint
CREATE UNIQUE INDEX "pages_org_product_path_uq" ON "pages" USING btree ("organization_id","product_id","path");--> statement-breakpoint
CREATE INDEX "pages_org_status_idx" ON "pages" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "product_facets_uq" ON "product_facets" USING btree ("product_id","kind","slug");--> statement-breakpoint
CREATE INDEX "product_facets_org_kind_idx" ON "product_facets" USING btree ("organization_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "product_sources_uq" ON "product_sources" USING btree ("product_id","url");--> statement-breakpoint
CREATE UNIQUE INDEX "products_org_slug_uq" ON "products" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "products_org_idx" ON "products" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "queries_uq" ON "queries" USING btree ("organization_id","normalized","language","market");--> statement-breakpoint
CREATE INDEX "queries_product_idx" ON "queries" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX "queries_org_status_idx" ON "queries" USING btree ("organization_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "query_clusters_uq" ON "query_clusters" USING btree ("organization_id","product_id","slug");--> statement-breakpoint
CREATE INDEX "recommendations_org_status_idx" ON "recommendations" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "referral_codes_org_idx" ON "referral_codes" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "revenue_events_ext_uq" ON "revenue_events" USING btree ("organization_id","provider","external_id");--> statement-breakpoint
CREATE INDEX "revenue_events_org_time_idx" ON "revenue_events" USING btree ("organization_id","occurred_at");--> statement-breakpoint
CREATE INDEX "seo_audits_product_idx" ON "seo_audits" USING btree ("product_id","created_at");--> statement-breakpoint
CREATE INDEX "seo_issues_audit_idx" ON "seo_issues" USING btree ("audit_id");--> statement-breakpoint
CREATE INDEX "seo_issues_org_sev_idx" ON "seo_issues" USING btree ("organization_id","severity","status");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_ext_uq" ON "subscriptions" USING btree ("organization_id","provider","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "visibility_metrics_uq" ON "visibility_metrics" USING btree ("product_id","provider","metric","day","dimension");--> statement-breakpoint
CREATE INDEX "visibility_metrics_org_day_idx" ON "visibility_metrics" USING btree ("organization_id","metric","day");