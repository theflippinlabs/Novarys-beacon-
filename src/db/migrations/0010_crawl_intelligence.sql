-- Phase 2 migration slot: crawl_intelligence (full page facts, link graph, sitemap snapshots, domain verification, audit diffs).
DO $$ BEGIN
  CREATE TYPE "public"."domain_verification_method" AS ENUM('DNS_TXT', 'WELL_KNOWN_FILE');
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
ALTER TABLE "seo_audits" ADD COLUMN IF NOT EXISTS "diff" jsonb;--> statement-breakpoint
ALTER TABLE "seo_issues" ADD COLUMN IF NOT EXISTS "params" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "seo_issues" ADD COLUMN IF NOT EXISTS "fingerprint" text;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "seo_issues_fingerprint_idx" ON "seo_issues" USING btree ("audit_id","fingerprint");--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD COLUMN IF NOT EXISTS "final_url" text;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD COLUMN IF NOT EXISTS "redirect_chain" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD COLUMN IF NOT EXISTS "robots_meta" text;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD COLUMN IF NOT EXISTS "x_robots_tag" text;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD COLUMN IF NOT EXISTS "indexability" text;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD COLUMN IF NOT EXISTS "h1" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD COLUMN IF NOT EXISTS "headings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD COLUMN IF NOT EXISTS "outlinks_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD COLUMN IF NOT EXISTS "external_links" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD COLUMN IF NOT EXISTS "json_ld" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD COLUMN IF NOT EXISTS "hreflang" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD COLUMN IF NOT EXISTS "open_graph" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD COLUMN IF NOT EXISTS "twitter" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD COLUMN IF NOT EXISTS "images" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD COLUMN IF NOT EXISTS "content_hash" text;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD COLUMN IF NOT EXISTS "text_sample" text;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD COLUMN IF NOT EXISTS "depth" integer;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD COLUMN IF NOT EXISTS "last_modified" text;--> statement-breakpoint
ALTER TABLE "crawled_pages" ADD COLUMN IF NOT EXISTS "fetched_at" timestamp with time zone;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "crawl_links" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"audit_id" uuid NOT NULL,
	"from_url" text NOT NULL,
	"to_url" text NOT NULL,
	"anchor" text DEFAULT '' NOT NULL,
	"nofollow" boolean DEFAULT false NOT NULL,
	"is_internal" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "sitemap_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"audit_id" uuid NOT NULL,
	"sitemap_url" text NOT NULL,
	"parent_url" text,
	"kind" text NOT NULL,
	"status" integer,
	"url_count" integer DEFAULT 0 NOT NULL,
	"compressed" boolean DEFAULT false NOT NULL,
	"lastmod_max" timestamp with time zone,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "verified_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"token" text NOT NULL,
	"method" "domain_verification_method",
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"last_error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "crawl_links" ADD CONSTRAINT "crawl_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crawl_links" ADD CONSTRAINT "crawl_links_audit_id_seo_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."seo_audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitemap_snapshots" ADD CONSTRAINT "sitemap_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sitemap_snapshots" ADD CONSTRAINT "sitemap_snapshots_audit_id_seo_audits_id_fk" FOREIGN KEY ("audit_id") REFERENCES "public"."seo_audits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_domains" ADD CONSTRAINT "verified_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "verified_domains" ADD CONSTRAINT "verified_domains_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crawl_links_to_idx" ON "crawl_links" USING btree ("audit_id","to_url");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "crawl_links_from_idx" ON "crawl_links" USING btree ("audit_id","from_url");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "sitemap_snapshots_audit_idx" ON "sitemap_snapshots" USING btree ("audit_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "verified_domains_uq" ON "verified_domains" USING btree ("organization_id","domain");--> statement-breakpoint
ALTER TABLE "crawl_links" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crawl_links" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "crawl_links_tenant_isolation" ON "crawl_links" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "sitemap_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "sitemap_snapshots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "sitemap_snapshots_tenant_isolation" ON "sitemap_snapshots" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "verified_domains" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "verified_domains" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "verified_domains_tenant_isolation" ON "verified_domains" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));
