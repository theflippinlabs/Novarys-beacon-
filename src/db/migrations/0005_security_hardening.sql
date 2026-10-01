-- Phase 2 security hardening.
-- NOTE for later migrations: migrations run as the application role, and FORCE
-- RLS applies to it, so a data backfill on a tenant table must wrap itself in
--   ALTER TABLE "t" NO FORCE ROW LEVEL SECURITY; <UPDATE ...>; ALTER TABLE "t" FORCE ROW LEVEL SECURITY;
-- (the owner is exempt while not forced; the migration is one transaction).
-- 1. Row-level security no longer honours the `beacon.bypass_rls` session setting:
--    any SQL running as the application role could set it. Trusted system code now
--    connects as a separate BYPASSRLS role (created by `pnpm release`, see src/db/provision.ts).
--    Every existing and future tenant policy calls this function, so they all follow.
CREATE OR REPLACE FUNCTION beacon_rls_allows(org uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT org::text = current_setting('beacon.org_id', true)
$$;
--> statement-breakpoint
-- The no-op `metrics.rollup` job type is gone: cancel any queued instances
-- (before RLS on jobs applies to the migrating role).
UPDATE "jobs" SET "status" = 'CANCELLED', "finished_at" = now() WHERE "type" = 'metrics.rollup' AND "status" IN ('QUEUED','FAILED');--> statement-breakpoint
-- 2. Jobs: tenant jobs are visible to their organisation only; system jobs
--    (organization_id null) only to the system role (the worker).
ALTER TABLE "jobs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "jobs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "jobs_tenant_isolation" ON "jobs";--> statement-breakpoint
CREATE POLICY "jobs_tenant_isolation" ON "jobs" USING (organization_id IS NOT NULL AND beacon_rls_allows(organization_id)) WITH CHECK (organization_id IS NOT NULL AND beacon_rls_allows(organization_id));--> statement-breakpoint
-- 3. Organisations: a tenant scope only sees its own organisation row.
ALTER TABLE "organizations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "organizations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
DROP POLICY IF EXISTS "organizations_tenant_isolation" ON "organizations";--> statement-breakpoint
CREATE POLICY "organizations_tenant_isolation" ON "organizations" USING (beacon_rls_allows(id)) WITH CHECK (beacon_rls_allows(id));--> statement-breakpoint
-- 4. Job heartbeat (long handlers refresh it; stale recovery uses it instead of locked_at).
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "heartbeat_at" timestamp with time zone;--> statement-breakpoint
-- 5. Login back-off per (email, ip) with atomic counters (replaces the account-wide hard lockout).
CREATE TABLE IF NOT EXISTS "login_throttle" (
	"key" text PRIMARY KEY NOT NULL,
	"failures" integer DEFAULT 0 NOT NULL,
	"blocked_until" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "login_throttle_updated_idx" ON "login_throttle" USING btree ("updated_at");--> statement-breakpoint
-- 6. Missing indexes (audit #56).
CREATE INDEX IF NOT EXISTS "attribution_events_identity_idx" ON "attribution_events" USING btree ("organization_id","identity_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attribution_events_ip_hash_idx" ON "attribution_events" USING btree ("organization_id","ip_hash","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attribution_events_referral_idx" ON "attribution_events" USING btree ("referral_code_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversion_events_identity_idx" ON "conversion_events" USING btree ("organization_id","identity_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversion_events_referral_idx" ON "conversion_events" USING btree ("organization_id","referral_code_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cross_sell_events_identity_idx" ON "cross_sell_events" USING btree ("identity_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "cross_sell_events_org_type_idx" ON "cross_sell_events" USING btree ("organization_id","type","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_visibility_tests_org_ran_idx" ON "ai_visibility_tests" USING btree ("organization_id","ran_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_mentions_org_observed_idx" ON "ai_mentions" USING btree ("organization_id","observed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_mentions_test_idx" ON "ai_mentions" USING btree ("test_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opportunities_org_product_status_idx" ON "opportunities" USING btree ("organization_id","product_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_issues_audit_rule_status_idx" ON "seo_issues" USING btree ("audit_id","rule","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_audits_org_product_created_idx" ON "seo_audits" USING btree ("organization_id","product_id","created_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_pricing_product_idx" ON "product_pricing" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_faqs_product_idx" ON "product_faqs" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_proofs_product_idx" ON "product_proofs" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_changelog_product_idx" ON "product_changelog" USING btree ("product_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "jobs_status_finished_idx" ON "jobs" USING btree ("status","finished_at");
