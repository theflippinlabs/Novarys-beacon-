-- Wave 4a migration slot: competitor_watch (robots-compliant watch of competitor pages, change snapshots, notification kind).
-- The enum value added here is NOT used in this migration: Postgres refuses to use a value added by
-- ALTER TYPE ... ADD VALUE inside the same transaction.
ALTER TYPE "public"."notification_kind" ADD VALUE IF NOT EXISTS 'COMPETITOR_PAGE_CHANGED';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "competitor_watches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"competitor_id" uuid NOT NULL,
	"url" text NOT NULL,
	"kind" text DEFAULT 'PRICING' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"http_status" integer,
	"last_fetched_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_changed_at" timestamp with time zone,
	"content_hash" text,
	"excerpt" text,
	"last_text" text,
	"final_url" text,
	"error" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "competitor_watches_kind_ck" CHECK ("kind" IN ('PRICING', 'FEATURES', 'HOME', 'OTHER')),
	CONSTRAINT "competitor_watches_status_ck" CHECK ("status" IN ('PENDING', 'OK', 'BLOCKED_BY_ROBOTS', 'HTTP_ERROR', 'NOT_HTML', 'FETCH_ERROR'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "competitor_watches" ADD CONSTRAINT "competitor_watches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "competitor_watches" ADD CONSTRAINT "competitor_watches_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "competitor_watches" ADD CONSTRAINT "competitor_watches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "competitor_watches_org_url_uq" ON "competitor_watches" USING btree ("organization_id","url");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "competitor_watches_due_idx" ON "competitor_watches" USING btree ("organization_id","active","last_fetched_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "competitor_watches_competitor_idx" ON "competitor_watches" USING btree ("competitor_id");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "competitor_watch_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"watch_id" uuid NOT NULL,
	"kind" text DEFAULT 'CHANGED' NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL,
	"content_hash" text NOT NULL,
	"previous_hash" text,
	"excerpt" text DEFAULT '' NOT NULL,
	"diff" jsonb,
	"http_status" integer,
	"final_url" text,
	CONSTRAINT "competitor_watch_snapshots_kind_ck" CHECK ("kind" IN ('BASELINE', 'CHANGED'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "competitor_watch_snapshots" ADD CONSTRAINT "competitor_watch_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "competitor_watch_snapshots" ADD CONSTRAINT "competitor_watch_snapshots_watch_id_competitor_watches_id_fk" FOREIGN KEY ("watch_id") REFERENCES "public"."competitor_watches"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "competitor_watch_snapshots_watch_idx" ON "competitor_watch_snapshots" USING btree ("watch_id","fetched_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "competitor_watch_snapshots_org_idx" ON "competitor_watch_snapshots" USING btree ("organization_id","fetched_at");--> statement-breakpoint
ALTER TABLE "competitor_watches" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "competitor_watches" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "competitor_watches_tenant_isolation" ON "competitor_watches" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "competitor_watch_snapshots" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "competitor_watch_snapshots" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "competitor_watch_snapshots_tenant_isolation" ON "competitor_watch_snapshots" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));
