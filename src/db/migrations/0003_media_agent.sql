CREATE TYPE "public"."media_visibility" AS ENUM('PUBLIC', 'PRIVATE');--> statement-breakpoint
CREATE TABLE "agent_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "media" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"product_id" uuid,
	"content_asset_id" uuid,
	"visibility" "media_visibility" DEFAULT 'PUBLIC' NOT NULL,
	"filename" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"size_bytes" integer NOT NULL,
	"alt" text,
	"bytes" "bytea" NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_conversations" ADD CONSTRAINT "agent_conversations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_conversations" ADD CONSTRAINT "agent_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_messages" ADD CONSTRAINT "agent_messages_conversation_id_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."agent_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_content_asset_id_content_assets_id_fk" FOREIGN KEY ("content_asset_id") REFERENCES "public"."content_assets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_conversations_user_idx" ON "agent_conversations" USING btree ("organization_id","user_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_messages_seq_uq" ON "agent_messages" USING btree ("conversation_id","seq");--> statement-breakpoint
CREATE INDEX "media_org_idx" ON "media" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "media_product_idx" ON "media" USING btree ("product_id");--> statement-breakpoint
ALTER TABLE "media" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "media" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "media_tenant_isolation" ON "media" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));
--> statement-breakpoint
ALTER TABLE "agent_conversations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_conversations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "agent_conversations_tenant_isolation" ON "agent_conversations" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));
--> statement-breakpoint
ALTER TABLE "agent_messages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "agent_messages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "agent_messages_tenant_isolation" ON "agent_messages" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));
