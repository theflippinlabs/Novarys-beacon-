-- Phase 2 migration slot: search_data (normalized search rows, integration health).
-- Note: the new integration_status value cannot be used inside this migration (same transaction).
ALTER TYPE "public"."integration_status" ADD VALUE IF NOT EXISTS 'EXPIRED';--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."search_provider" AS ENUM('GOOGLE_SEARCH_CONSOLE', 'BING_WEBMASTER');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "last_success_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "last_failure_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "integrations" ADD COLUMN IF NOT EXISTS "scopes" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- Backfill under NO FORCE: FORCE RLS would otherwise hide existing rows from the migrating role.
ALTER TABLE "integrations" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
UPDATE "integrations" SET "last_success_at" = "last_sync_at" WHERE "last_success_at" IS NULL AND "last_sync_at" IS NOT NULL AND "status" = 'CONNECTED';--> statement-breakpoint
ALTER TABLE "integrations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "search_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"integration_id" uuid NOT NULL,
	"provider" "search_provider" NOT NULL,
	"day" date NOT NULL,
	"query" text,
	"page" text,
	"country" text,
	"device" text,
	"clicks" integer DEFAULT 0 NOT NULL,
	"impressions" integer DEFAULT 0 NOT NULL,
	"ctr" double precision DEFAULT 0 NOT NULL,
	"position" double precision,
	"imported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_daily_uq" UNIQUE NULLS NOT DISTINCT("integration_id","day","query","page","country","device")
);
--> statement-breakpoint
ALTER TABLE "search_daily" ADD CONSTRAINT "search_daily_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_daily" ADD CONSTRAINT "search_daily_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "search_daily" ADD CONSTRAINT "search_daily_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_daily_org_product_day_idx" ON "search_daily" USING btree ("organization_id","product_id","day");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "search_daily_org_query_idx" ON "search_daily" USING btree ("organization_id","query");--> statement-breakpoint
ALTER TABLE "search_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "search_daily" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "search_daily_tenant_isolation" ON "search_daily" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));
