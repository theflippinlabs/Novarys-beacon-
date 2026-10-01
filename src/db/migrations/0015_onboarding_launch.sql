-- Phase 2 wave 2 migration slot: onboarding_launch (per-step onboarding status, website extraction proposals, launch mode).
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "onboarding_steps" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "launch_date" date;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "launch_mode" text DEFAULT 'OFF' NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "launched_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN IF NOT EXISTS "launch_baseline" jsonb;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "products" ADD CONSTRAINT "products_launch_mode_ck" CHECK ("launch_mode" IN ('PRE_LAUNCH', 'LAUNCH', 'POST_LAUNCH', 'OFF'));
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."knowledge_proposal_kind" AS ENUM('CLAIM', 'FACET', 'PRICING', 'SOCIAL', 'LOGO');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"kind" "knowledge_proposal_kind" NOT NULL,
	"field" text NOT NULL,
	"value" text NOT NULL,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"origin" text NOT NULL,
	"source_url" text NOT NULL,
	"status" text DEFAULT 'PROPOSED' NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "knowledge_proposals_status_ck" CHECK ("status" IN ('PROPOSED', 'ACCEPTED', 'REJECTED'))
);
--> statement-breakpoint
ALTER TABLE "knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_proposals" ADD CONSTRAINT "knowledge_proposals_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_proposals_uq" ON "knowledge_proposals" USING btree ("product_id","kind","field","value");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "knowledge_proposals_org_product_idx" ON "knowledge_proposals" USING btree ("organization_id","product_id","status");--> statement-breakpoint
ALTER TABLE "knowledge_proposals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "knowledge_proposals" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "knowledge_proposals_tenant_isolation" ON "knowledge_proposals" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));
