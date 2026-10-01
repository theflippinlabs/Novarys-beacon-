-- Phase 2 migration slot: measurement (tracking API, attribution credits, Stripe inbox, GA4 analytics, ecosystem graph).
-- Enum values added here are NOT used anywhere in this migration: Postgres refuses to use a value added by
-- ALTER TYPE ... ADD VALUE inside the same transaction. Legacy event names stay valid (aliases, see core/conversions/events.ts).
ALTER TYPE "public"."conversion_event_type" ADD VALUE IF NOT EXISTS 'PRODUCT_VIEWED';--> statement-breakpoint
ALTER TYPE "public"."conversion_event_type" ADD VALUE IF NOT EXISTS 'SIGNUP_STARTED';--> statement-breakpoint
ALTER TYPE "public"."conversion_event_type" ADD VALUE IF NOT EXISTS 'SIGNUP_COMPLETED';--> statement-breakpoint
ALTER TYPE "public"."conversion_event_type" ADD VALUE IF NOT EXISTS 'ACTIVATION_COMPLETED';--> statement-breakpoint
ALTER TYPE "public"."conversion_event_type" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION_STARTED';--> statement-breakpoint
ALTER TYPE "public"."conversion_event_type" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION_UPGRADED';--> statement-breakpoint
ALTER TYPE "public"."conversion_event_type" ADD VALUE IF NOT EXISTS 'SUBSCRIPTION_CANCELLED';--> statement-breakpoint
ALTER TYPE "public"."acquisition_channel" ADD VALUE IF NOT EXISTS 'UNATTRIBUTED';--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."attribution_model" AS ENUM('FIRST_TOUCH', 'LAST_TOUCH', 'LINEAR', 'POSITION_BASED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."webhook_status" AS ENUM('RECEIVED', 'UNMAPPED', 'PROCESSED', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."product_relationship_type" AS ENUM('COMPLEMENTARY', 'SAME_AUDIENCE', 'WORKFLOW_EXTENSION', 'UPSELL', 'CROSS_SELL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;--> statement-breakpoint

-- Tracking: session, UTM, referrer, landing page and the persisted attribution decision on every conversion.
ALTER TABLE "attribution_events" ADD COLUMN IF NOT EXISTS "session_id" text;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD COLUMN IF NOT EXISTS "session_id" text;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD COLUMN IF NOT EXISTS "utm" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD COLUMN IF NOT EXISTS "referrer_host" text;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD COLUMN IF NOT EXISTS "landing_url" text;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD COLUMN IF NOT EXISTS "attribution_rule" text;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD COLUMN IF NOT EXISTS "attribution_touch_id" uuid;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD COLUMN IF NOT EXISTS "first_touch_id" uuid;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_attribution_touch_id_fk" FOREIGN KEY ("attribution_touch_id") REFERENCES "public"."attribution_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversion_events" ADD CONSTRAINT "conversion_events_first_touch_id_fk" FOREIGN KEY ("first_touch_id") REFERENCES "public"."attribution_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversion_events_landing_idx" ON "conversion_events" USING btree ("organization_id","landing_url");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attribution_events_identity_idx" ON "attribution_events" USING btree ("organization_id","identity_id","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attribution_events_session_idx" ON "attribution_events" USING btree ("organization_id","session_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attribution_events_ip_idx" ON "attribution_events" USING btree ("occurred_at") WHERE "ip_hash" IS NOT NULL;--> statement-breakpoint

-- Stripe: ordering guard (provider event time of the last change applied) and the source charge of refunds.
ALTER TABLE "subscriptions" ADD COLUMN IF NOT EXISTS "last_event_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "revenue_events" ADD COLUMN IF NOT EXISTS "source_ref" text;--> statement-breakpoint
-- No currency defaults: every revenue event and subscription carries the currency of its source.
ALTER TABLE "revenue_events" ALTER COLUMN "currency" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "subscriptions" ALTER COLUMN "currency" DROP DEFAULT;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "revenue_events_source_ref_idx" ON "revenue_events" USING btree ("organization_id","provider","source_ref");--> statement-breakpoint

-- Attribution credits: one row per (conversion or revenue event, touch, model); weights of one event and model sum to 1.
CREATE TABLE IF NOT EXISTS "attribution_credits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"conversion_event_id" uuid,
	"revenue_event_id" uuid,
	"touch_id" uuid,
	"model" "attribution_model" NOT NULL,
	"channel" "acquisition_channel",
	"campaign_id" uuid,
	"weight" double precision NOT NULL,
	"value_cents" bigint,
	"currency" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attribution_credits_target_ck" CHECK ("conversion_event_id" IS NOT NULL OR "revenue_event_id" IS NOT NULL),
	CONSTRAINT "attribution_credits_weight_ck" CHECK ("weight" >= 0 AND "weight" <= 1)
);
--> statement-breakpoint
ALTER TABLE "attribution_credits" ADD CONSTRAINT "attribution_credits_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_credits" ADD CONSTRAINT "attribution_credits_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_credits" ADD CONSTRAINT "attribution_credits_conversion_event_id_fk" FOREIGN KEY ("conversion_event_id") REFERENCES "public"."conversion_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_credits" ADD CONSTRAINT "attribution_credits_revenue_event_id_fk" FOREIGN KEY ("revenue_event_id") REFERENCES "public"."revenue_events"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_credits" ADD CONSTRAINT "attribution_credits_touch_id_fk" FOREIGN KEY ("touch_id") REFERENCES "public"."attribution_events"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attribution_credits" ADD CONSTRAINT "attribution_credits_campaign_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attribution_credits_org_model_idx" ON "attribution_credits" USING btree ("organization_id","model","occurred_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attribution_credits_conversion_idx" ON "attribution_credits" USING btree ("conversion_event_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "attribution_credits_revenue_idx" ON "attribution_credits" USING btree ("revenue_event_id");--> statement-breakpoint
ALTER TABLE "attribution_credits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attribution_credits" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "attribution_credits_tenant_isolation" ON "attribution_credits" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));
--> statement-breakpoint

-- Webhook inbox: every verified provider event is stored before processing; unmapped or failed events can be reprocessed.
CREATE TABLE IF NOT EXISTS "webhook_inbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"external_id" text NOT NULL,
	"event_type" text NOT NULL,
	"status" "webhook_status" DEFAULT 'RECEIVED' NOT NULL,
	"payload" jsonb NOT NULL,
	"error" text,
	"attempts" integer DEFAULT 0 NOT NULL,
	"event_created_at" timestamp with time zone,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD CONSTRAINT "webhook_inbox_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_inbox" ADD CONSTRAINT "webhook_inbox_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_inbox_event_uq" ON "webhook_inbox" USING btree ("integration_id","external_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_inbox_status_idx" ON "webhook_inbox" USING btree ("organization_id","status","received_at");--> statement-breakpoint
ALTER TABLE "webhook_inbox" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "webhook_inbox" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "webhook_inbox_tenant_isolation" ON "webhook_inbox" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));
--> statement-breakpoint

-- GA4: daily rows per report grain ('landing': page, source, medium, campaign; 'geo_device': country, device). Unused dimensions are ''.
CREATE TABLE IF NOT EXISTS "analytics_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"integration_id" uuid NOT NULL,
	"report" text NOT NULL,
	"day" date NOT NULL,
	"landing_page" text DEFAULT '' NOT NULL,
	"source" text DEFAULT '' NOT NULL,
	"medium" text DEFAULT '' NOT NULL,
	"campaign" text DEFAULT '' NOT NULL,
	"country" text DEFAULT '' NOT NULL,
	"device" text DEFAULT '' NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"users" integer DEFAULT 0 NOT NULL,
	"engaged_sessions" integer DEFAULT 0 NOT NULL,
	"key_events" double precision DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "analytics_daily" ADD CONSTRAINT "analytics_daily_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_daily" ADD CONSTRAINT "analytics_daily_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "analytics_daily" ADD CONSTRAINT "analytics_daily_integration_id_integrations_id_fk" FOREIGN KEY ("integration_id") REFERENCES "public"."integrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "analytics_daily_uq" ON "analytics_daily" USING btree ("integration_id","report","day","landing_page","source","medium","campaign","country","device");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "analytics_daily_product_idx" ON "analytics_daily" USING btree ("organization_id","product_id","report","day");--> statement-breakpoint
ALTER TABLE "analytics_daily" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "analytics_daily" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "analytics_daily_tenant_isolation" ON "analytics_daily" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));
--> statement-breakpoint

-- Ecosystem graph: typed, explained relationships between products; cross-sell rules may point at one.
CREATE TABLE IF NOT EXISTS "product_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"from_product_id" uuid NOT NULL,
	"to_product_id" uuid NOT NULL,
	"type" "product_relationship_type" NOT NULL,
	"rationale" text NOT NULL,
	"source_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_relationships_distinct_ck" CHECK ("from_product_id" <> "to_product_id")
);
--> statement-breakpoint
ALTER TABLE "product_relationships" ADD CONSTRAINT "product_relationships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_relationships" ADD CONSTRAINT "product_relationships_from_product_id_fk" FOREIGN KEY ("from_product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_relationships" ADD CONSTRAINT "product_relationships_to_product_id_fk" FOREIGN KEY ("to_product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_relationships" ADD CONSTRAINT "product_relationships_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."product_sources"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_relationships" ADD CONSTRAINT "product_relationships_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "product_relationships_uq" ON "product_relationships" USING btree ("organization_id","from_product_id","to_product_id","type");--> statement-breakpoint
ALTER TABLE "product_relationships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_relationships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "product_relationships_tenant_isolation" ON "product_relationships" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));
--> statement-breakpoint
ALTER TABLE "cross_sell_rules" ADD COLUMN IF NOT EXISTS "relationship_id" uuid;--> statement-breakpoint
ALTER TABLE "cross_sell_rules" ADD CONSTRAINT "cross_sell_rules_relationship_id_fk" FOREIGN KEY ("relationship_id") REFERENCES "public"."product_relationships"("id") ON DELETE set null ON UPDATE no action;
