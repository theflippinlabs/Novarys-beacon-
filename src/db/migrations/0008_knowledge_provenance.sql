-- Phase 2: knowledge provenance (per-claim verification, confidence, OUTDATED / CONFLICTING, source liveness).
-- New enum values are added here but never used in this file: Postgres forbids using a value added by
-- ALTER TYPE ... ADD VALUE inside the transaction that added it, and drizzle applies migrations in a transaction.
ALTER TYPE "public"."verification_status" ADD VALUE IF NOT EXISTS 'OUTDATED';--> statement-breakpoint
ALTER TYPE "public"."verification_status" ADD VALUE IF NOT EXISTS 'CONFLICTING';--> statement-breakpoint
ALTER TABLE "product_facets" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_facets" ADD COLUMN IF NOT EXISTS "verified_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "product_facets" ADD COLUMN IF NOT EXISTS "confidence" real;--> statement-breakpoint
ALTER TABLE "product_pricing" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_pricing" ADD COLUMN IF NOT EXISTS "verified_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "product_pricing" ADD COLUMN IF NOT EXISTS "confidence" real;--> statement-breakpoint
ALTER TABLE "product_faqs" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_faqs" ADD COLUMN IF NOT EXISTS "verified_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "product_faqs" ADD COLUMN IF NOT EXISTS "confidence" real;--> statement-breakpoint
ALTER TABLE "product_faqs" ADD COLUMN IF NOT EXISTS "suggested_from" text;--> statement-breakpoint
ALTER TABLE "product_proofs" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_proofs" ADD COLUMN IF NOT EXISTS "verified_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "product_proofs" ADD COLUMN IF NOT EXISTS "confidence" real;--> statement-breakpoint
ALTER TABLE "product_changelog" ADD COLUMN IF NOT EXISTS "verification" "verification_status" DEFAULT 'UNVERIFIED' NOT NULL;--> statement-breakpoint
ALTER TABLE "product_changelog" ADD COLUMN IF NOT EXISTS "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "product_changelog" ADD COLUMN IF NOT EXISTS "verified_by" uuid REFERENCES "users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "product_changelog" ADD COLUMN IF NOT EXISTS "confidence" real;--> statement-breakpoint
-- Prices are never defaulted: an unknown currency or billing interval stays unknown (NULL).
ALTER TABLE "product_pricing" ALTER COLUMN "currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "product_pricing" ALTER COLUMN "currency" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "product_pricing" ALTER COLUMN "interval" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "product_pricing" ALTER COLUMN "interval" DROP NOT NULL;--> statement-breakpoint
-- Source liveness: consecutive failed checks (2 = failing) and the last error.
ALTER TABLE "product_sources" ADD COLUMN IF NOT EXISTS "consecutive_failures" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "product_sources" ADD COLUMN IF NOT EXISTS "last_error" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "product_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
	"product_id" uuid NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
	"field" text NOT NULL,
	"value" text NOT NULL,
	"source_id" uuid REFERENCES "product_sources"("id") ON DELETE SET NULL,
	"verification" "verification_status" DEFAULT 'UNVERIFIED' NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
	"confidence" real,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_claims_product_field_idx" ON "product_claims" ("product_id", "field");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "product_claims_org_idx" ON "product_claims" ("organization_id");--> statement-breakpoint
ALTER TABLE "product_claims" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_claims" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "product_claims_tenant_isolation" ON "product_claims" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
-- Backfill scalar claims from existing products. Values use the same serialisation as
-- src/core/knowledge/provenance.ts (claimValue). Claims are VERIFIED only where a human
-- verified the product (last_verified_at), with that date; everything else is UNVERIFIED.
-- Confidence is left NULL and computed by the application (sources.check job, edits).
-- FORCE RLS applies to the migrating (owner) role, so both tables are unforced for the backfill only.
ALTER TABLE "products" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_claims" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
INSERT INTO "product_claims" ("organization_id", "product_id", "field", "value", "verification", "verified_at")
SELECT p."organization_id", p."id", v."field", v."value",
	CASE WHEN p."last_verified_at" IS NOT NULL THEN 'VERIFIED'::"verification_status" ELSE 'UNVERIFIED'::"verification_status" END,
	p."last_verified_at"
FROM "products" p
CROSS JOIN LATERAL (VALUES
	('category', NULLIF(btrim(p."category"), '')),
	('short_description', NULLIF(btrim(p."short_description"), '')),
	('full_description', NULLIF(btrim(p."full_description"), '')),
	('how_it_works', NULLIF(btrim(p."how_it_works"), '')),
	('status', CASE WHEN p."status" = 'UNKNOWN' THEN NULL ELSE p."status"::text END),
	('release_date', p."release_date"::text),
	('api_available', p."api_available"::text),
	('free_trial', p."free_trial"::text),
	('languages', NULLIF(array_to_string(p."languages", ', '), '')),
	('supported_countries', NULLIF(array_to_string(p."supported_countries", ', '), '')),
	('domain', NULLIF(btrim(p."domain"), '')),
	('documentation_url', NULLIF(btrim(p."documentation_url"), '')),
	('pricing_url', NULLIF(btrim(p."pricing_url"), ''))
) AS v("field", "value")
WHERE v."value" IS NOT NULL
	AND NOT EXISTS (SELECT 1 FROM "product_claims" c WHERE c."product_id" = p."id");--> statement-breakpoint
ALTER TABLE "product_claims" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;
