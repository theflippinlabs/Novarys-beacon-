-- Phase 2: content integrity (audit #33 to #36).
-- 1. Approved and published versions: the public site serves `published_version_id`
--    while newer drafts are edited; publishing a newer version needs a new approval.
-- 2. Repurposing: derivatives remember their source asset and version, and are
--    flagged stale when the source publishes a newer version.
-- 3. Body-based quality gate stored per version.
ALTER TABLE "content_assets" ADD COLUMN IF NOT EXISTS "approved_version_id" uuid;--> statement-breakpoint
ALTER TABLE "content_assets" ADD COLUMN IF NOT EXISTS "published_version_id" uuid;--> statement-breakpoint
ALTER TABLE "content_assets" ADD COLUMN IF NOT EXISTS "source_asset_id" uuid;--> statement-breakpoint
ALTER TABLE "content_assets" ADD COLUMN IF NOT EXISTS "source_version_id" uuid;--> statement-breakpoint
ALTER TABLE "content_assets" ADD COLUMN IF NOT EXISTS "source_stale_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "content_versions" ADD COLUMN IF NOT EXISTS "quality_check" jsonb;--> statement-breakpoint
ALTER TABLE "content_assets" DROP CONSTRAINT IF EXISTS "content_assets_approved_version_id_content_versions_id_fk";--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_approved_version_id_content_versions_id_fk" FOREIGN KEY ("approved_version_id") REFERENCES "public"."content_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_assets" DROP CONSTRAINT IF EXISTS "content_assets_published_version_id_content_versions_id_fk";--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_published_version_id_content_versions_id_fk" FOREIGN KEY ("published_version_id") REFERENCES "public"."content_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_assets" DROP CONSTRAINT IF EXISTS "content_assets_source_asset_id_content_assets_id_fk";--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_source_asset_id_content_assets_id_fk" FOREIGN KEY ("source_asset_id") REFERENCES "public"."content_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "content_assets" DROP CONSTRAINT IF EXISTS "content_assets_source_version_id_content_versions_id_fk";--> statement-breakpoint
ALTER TABLE "content_assets" ADD CONSTRAINT "content_assets_source_version_id_content_versions_id_fk" FOREIGN KEY ("source_version_id") REFERENCES "public"."content_versions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "content_assets_source_idx" ON "content_assets" USING btree ("source_asset_id");--> statement-breakpoint
-- Backfill existing data: approved and published assets point at their current version.
-- FORCE RLS applies to the migrating (owner) role, so the tables are unforced for the backfill only.
ALTER TABLE "content_assets" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "content_versions" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "content_assets" a SET "approved_version_id" = v."id"
FROM "content_versions" v
WHERE v."asset_id" = a."id" AND v."version" = a."current_version" AND a."status" IN ('APPROVED', 'PUBLISHED') AND a."approved_version_id" IS NULL;--> statement-breakpoint
UPDATE "content_assets" a SET "published_version_id" = v."id"
FROM "content_versions" v
WHERE v."asset_id" = a."id" AND v."version" = a."current_version" AND a."status" = 'PUBLISHED' AND a."published_version_id" IS NULL;--> statement-breakpoint
ALTER TABLE "content_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "content_assets" FORCE ROW LEVEL SECURITY;
