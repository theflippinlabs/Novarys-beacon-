-- Beacon Brain (docs/BEACON_BRAIN.md): runs of the orchestrator and their findings, and the notification kind for new critical findings.
-- The enum value added here is NOT used in this migration: Postgres refuses to use a value added by
-- ALTER TYPE ... ADD VALUE inside the same transaction.
ALTER TYPE "public"."notification_kind" ADD VALUE IF NOT EXISTS 'BRAIN_CRITICAL';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brain_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"status" text DEFAULT 'QUEUED' NOT NULL,
	"trigger" text DEFAULT 'SCHEDULED' NOT NULL,
	"requested_by" uuid,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"coverage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"executive_summary" jsonb,
	"summary_source" text DEFAULT 'DETERMINISTIC' NOT NULL,
	"narratives" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"estimation_power" jsonb,
	"llm_usage" jsonb,
	"ranked_count" integer DEFAULT 0 NOT NULL,
	"unestimated_count" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_runs_status_ck" CHECK ("status" IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED')),
	CONSTRAINT "brain_runs_trigger_ck" CHECK ("trigger" IN ('SCHEDULED', 'MANUAL', 'AGENT')),
	CONSTRAINT "brain_runs_summary_source_ck" CHECK ("summary_source" IN ('LLM', 'DETERMINISTIC'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "brain_runs" ADD CONSTRAINT "brain_runs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "brain_runs" ADD CONSTRAINT "brain_runs_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_runs_org_created_idx" ON "brain_runs" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "brain_findings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"specialist" text NOT NULL,
	"rank" integer NOT NULL,
	"estimable" boolean NOT NULL,
	"severity" text DEFAULT 'MEDIUM' NOT NULL,
	"finding_key" text NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"vars" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"effort" integer DEFAULT 3 NOT NULL,
	"evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"estimate" jsonb,
	"target" jsonb,
	"action" jsonb NOT NULL,
	"also_from" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"opportunity_id" uuid,
	"product_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brain_findings_severity_ck" CHECK ("severity" IN ('CRITICAL', 'HIGH', 'MEDIUM', 'LOW'))
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "brain_findings" ADD CONSTRAINT "brain_findings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "brain_findings" ADD CONSTRAINT "brain_findings_run_id_brain_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."brain_runs"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "brain_findings" ADD CONSTRAINT "brain_findings_opportunity_id_opportunities_id_fk" FOREIGN KEY ("opportunity_id") REFERENCES "public"."opportunities"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "brain_findings" ADD CONSTRAINT "brain_findings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_findings_run_idx" ON "brain_findings" USING btree ("run_id","estimable","rank");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "brain_findings_org_key_idx" ON "brain_findings" USING btree ("organization_id","finding_key");--> statement-breakpoint
ALTER TABLE "brain_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "brain_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "brain_runs_tenant_isolation" ON "brain_runs" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "brain_findings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "brain_findings" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "brain_findings_tenant_isolation" ON "brain_findings" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));
