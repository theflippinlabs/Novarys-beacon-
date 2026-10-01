-- Phase 2 wave 2 migration slot: autopilot_experiments.
-- Autopilot loop (opportunity link, dedupe, execution, baseline, measurement, learning),
-- growth experiments (design, counts, statistics) and distribution intelligence
-- (category, relevance with reason, requirements, actions, UTM campaign, scoped approval).
DO $$ BEGIN
  CREATE TYPE "public"."recommendation_outcome" AS ENUM('IMPROVED', 'NO_CHANGE', 'DECLINED', 'INSUFFICIENT_DATA');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."experiment_winner" AS ENUM('CONTROL', 'VARIANT', 'INCONCLUSIVE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."distribution_category" AS ENUM('SOFTWARE_DIRECTORY', 'INDUSTRY_DIRECTORY', 'PRODUCT_DISCOVERY', 'REVIEW_PLATFORM', 'DEVELOPER_COMMUNITY', 'NEWSLETTER', 'PUBLICATION', 'PARTNER', 'CREATOR', 'AGENCY', 'COMMUNITY');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN IF NOT EXISTS "opportunity_id" uuid;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'ANALYST' NOT NULL;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN IF NOT EXISTS "dedupe_key" text;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN IF NOT EXISTS "target_ref" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN IF NOT EXISTS "baseline" jsonb;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN IF NOT EXISTS "execution_plan" jsonb;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN IF NOT EXISTS "execution_error" text;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN IF NOT EXISTS "executed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN IF NOT EXISTS "executed_ref" jsonb;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN IF NOT EXISTS "measure_after" date;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN IF NOT EXISTS "measured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN IF NOT EXISTS "outcome" jsonb;--> statement-breakpoint
ALTER TABLE "recommendations" ADD COLUMN IF NOT EXISTS "outcome_label" "recommendation_outcome";--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "recommendations" ADD CONSTRAINT "recommendations_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
-- Dedupe: the weekly analyst used to insert the same proposals every run. Keep the newest undecided copy.
ALTER TABLE "recommendations" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DELETE FROM "recommendations" r USING "recommendations" n
  WHERE r.status = 'PROPOSED' AND n.status = 'PROPOSED' AND r.organization_id = n.organization_id AND r.kind = n.kind AND r.title = n.title
    AND coalesce(r.product_id::text, '') = coalesce(n.product_id::text, '')
    AND (r.created_at < n.created_at OR (r.created_at = n.created_at AND r.id < n.id));--> statement-breakpoint
UPDATE "recommendations" SET "dedupe_key" = 'legacy:' || md5(kind || ':' || title || ':' || coalesce(product_id::text, '')) WHERE "dedupe_key" IS NULL AND status = 'PROPOSED';--> statement-breakpoint
ALTER TABLE "recommendations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recommendations_open_opportunity_uq" ON "recommendations" USING btree ("organization_id","opportunity_id") WHERE status IN ('PROPOSED', 'APPROVED') AND opportunity_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "recommendations_open_dedupe_uq" ON "recommendations" USING btree ("organization_id","dedupe_key") WHERE status IN ('PROPOSED', 'APPROVED') AND dedupe_key IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "recommendations_measure_idx" ON "recommendations" USING btree ("measure_after") WHERE executed_at IS NOT NULL AND outcome_label IS NULL;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "autopilot_learning" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"opportunity_type" text NOT NULL,
	"improved" integer DEFAULT 0 NOT NULL,
	"no_change" integer DEFAULT 0 NOT NULL,
	"declined" integer DEFAULT 0 NOT NULL,
	"insufficient" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "autopilot_learning" ADD CONSTRAINT "autopilot_learning_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "autopilot_learning_uq" ON "autopilot_learning" USING btree ("organization_id","opportunity_type");--> statement-breakpoint
ALTER TABLE "autopilot_learning" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "autopilot_learning" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "autopilot_learning_tenant_isolation" ON "autopilot_learning" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "recommendation_id" uuid;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "control" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "variant" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "metric_key" text;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "baseline_rate" double precision;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "min_detectable_effect" double precision;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "min_sample_size" integer;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "control_n" integer;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "control_conversions" integer;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "variant_n" integer;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "variant_conversions" integer;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "counts_source" text;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "counts_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "test_method" text;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "p_value" double precision;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "confidence" double precision;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "winner" "experiment_winner";--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "result_explanation" text;--> statement-breakpoint
ALTER TABLE "experiments" ADD COLUMN IF NOT EXISTS "result_computed_at" timestamp with time zone;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "experiments" ADD CONSTRAINT "experiments_recommendation_id_recommendations_id_fk" FOREIGN KEY ("recommendation_id") REFERENCES "public"."recommendations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "experiments" ADD CONSTRAINT "experiments_counts_ck" CHECK (
    (control_n IS NULL OR control_n >= 0) AND (variant_n IS NULL OR variant_n >= 0)
    AND (control_conversions IS NULL OR (control_conversions >= 0 AND (control_n IS NULL OR control_conversions <= control_n)))
    AND (variant_conversions IS NULL OR (variant_conversions >= 0 AND (variant_n IS NULL OR variant_conversions <= variant_n))));
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "experiments_org_status_idx" ON "experiments" USING btree ("organization_id","status");--> statement-breakpoint
ALTER TABLE "distribution_targets" ADD COLUMN IF NOT EXISTS "category" "distribution_category";--> statement-breakpoint
ALTER TABLE "distribution_targets" ADD COLUMN IF NOT EXISTS "relevance_reason" text;--> statement-breakpoint
ALTER TABLE "distribution_targets" ADD COLUMN IF NOT EXISTS "requirements" text;--> statement-breakpoint
ALTER TABLE "distribution_targets" ADD COLUMN IF NOT EXISTS "last_action" text;--> statement-breakpoint
ALTER TABLE "distribution_targets" ADD COLUMN IF NOT EXISTS "last_action_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "distribution_targets" ADD COLUMN IF NOT EXISTS "result" text;--> statement-breakpoint
ALTER TABLE "distribution_targets" ADD COLUMN IF NOT EXISTS "utm_campaign" text;--> statement-breakpoint
ALTER TABLE "distribution_targets" ADD COLUMN IF NOT EXISTS "catalog_key" text;--> statement-breakpoint
ALTER TABLE "distribution_targets" ADD COLUMN IF NOT EXISTS "approved_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "distribution_targets" ADD COLUMN IF NOT EXISTS "approved_version_id" uuid;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "distribution_targets" ADD CONSTRAINT "distribution_targets_approved_asset_id_content_assets_id_fk" FOREIGN KEY ("approved_asset_id") REFERENCES "public"."content_assets"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "distribution_targets" ADD CONSTRAINT "distribution_targets_approved_version_id_content_versions_id_fk" FOREIGN KEY ("approved_version_id") REFERENCES "public"."content_versions"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
-- Backfill: relevance moves from 1..5 to 0..100, a category is derived from the kind, and
-- approvals that are not tied to an approved listing asset are reset while not yet submitted.
ALTER TABLE "distribution_targets" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "distribution_targets" SET "relevance" = "relevance" * 20 WHERE "relevance" BETWEEN 1 AND 5;--> statement-breakpoint
UPDATE "distribution_targets" SET "category" = (CASE
    WHEN lower(name) IN ('g2', 'capterra', 'trustradius', 'getapp', 'software advice', 'trustpilot') THEN 'REVIEW_PLATFORM'
    WHEN lower(name) LIKE 'hacker news%' THEN 'DEVELOPER_COMMUNITY'
    WHEN kind = 'DIRECTORY' THEN 'SOFTWARE_DIRECTORY'
    WHEN kind = 'LAUNCH_PLATFORM' THEN 'PRODUCT_DISCOVERY'
    WHEN kind IN ('COMMUNITY', 'SOCIAL_CHANNEL') THEN 'COMMUNITY'
    WHEN kind = 'NEWSLETTER' THEN 'NEWSLETTER'
    WHEN kind IN ('PARTNER', 'AFFILIATE') THEN 'PARTNER'
    WHEN kind = 'INFLUENCER' THEN 'CREATOR'
    WHEN kind = 'AGENCY' THEN 'AGENCY'
    ELSE 'PUBLICATION' END)::distribution_category
  WHERE "category" IS NULL;--> statement-breakpoint
UPDATE "distribution_targets" SET "submission_approved_by" = NULL, "submission_approved_at" = NULL WHERE "submission_approved_at" IS NOT NULL AND "approved_asset_id" IS NULL AND status IN ('DISCOVERED', 'QUALIFIED', 'PREPARED');--> statement-breakpoint
ALTER TABLE "distribution_targets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "distribution_targets" ADD CONSTRAINT "distribution_targets_relevance_ck" CHECK (relevance IS NULL OR (relevance >= 0 AND relevance <= 100));
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "distribution_targets_utm_uq" ON "distribution_targets" USING btree ("organization_id","utm_campaign") WHERE utm_campaign IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "distribution_targets_org_category_idx" ON "distribution_targets" USING btree ("organization_id","category");
