-- Phase 2: discovery intelligence (query universe, content gaps, AI visibility lab, citations, competitor intelligence, opportunity engine v2).
-- Backfills below run as the (non-bypass) app role, which owns these tables: FORCE RLS is lifted for the duration of
-- this migration (single transaction) so data migrations see every tenant's rows, and restored at the end.
ALTER TABLE "queries" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "query_clusters" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_visibility_prompts" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_visibility_tests" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "products" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "competitors" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "opportunities" NO FORCE ROW LEVEL SECURITY;--> statement-breakpoint
-- 1. Query universe: the uniqueness key now includes the product, so the same query can be tracked for several products.
--    The previous key (org, normalized, language, market) was stricter than the new one, so no existing row can collide;
--    the defensive de-duplication below keeps the oldest row of any duplicate group anyway.
DELETE FROM "queries" q USING (
  SELECT id, row_number() OVER (PARTITION BY organization_id, COALESCE(product_id, '00000000-0000-0000-0000-000000000000'::uuid), normalized, language, market ORDER BY created_at, id) AS rn
  FROM "queries"
) d WHERE d.id = q.id AND d.rn > 1;--> statement-breakpoint
DROP INDEX IF EXISTS "queries_uq";--> statement-breakpoint
CREATE UNIQUE INDEX "queries_uq" ON "queries" USING btree ("organization_id", COALESCE("product_id", '00000000-0000-0000-0000-000000000000'::uuid), "normalized", "language", "market");--> statement-breakpoint
CREATE TYPE "public"."query_topic_type" AS ENUM('FEATURE', 'INDUSTRY', 'AUDIENCE', 'USE_CASE', 'INTEGRATION', 'CATEGORY', 'BRAND', 'COMPETITOR', 'PROBLEM');--> statement-breakpoint
ALTER TABLE "queries" ADD COLUMN IF NOT EXISTS "branded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "queries" ADD COLUMN IF NOT EXISTS "topic_type" "query_topic_type";--> statement-breakpoint
ALTER TABLE "queries" ADD COLUMN IF NOT EXISTS "classification" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "queries" ADD COLUMN IF NOT EXISTS "coverage_reason" text;--> statement-breakpoint
ALTER TABLE "queries" ADD COLUMN IF NOT EXISTS "covered_by_url" text;--> statement-breakpoint
-- Existing NAVIGATIONAL queries were classified from the product name: mark them branded.
UPDATE "queries" SET "branded" = true, "topic_type" = 'BRAND' WHERE "intent" = 'NAVIGATIONAL';--> statement-breakpoint
ALTER TABLE "query_clusters" ADD COLUMN IF NOT EXISTS "origin" text DEFAULT 'MANUAL' NOT NULL;--> statement-breakpoint
ALTER TABLE "query_clusters" ADD COLUMN IF NOT EXISTS "intent" "query_intent";--> statement-breakpoint
ALTER TABLE "query_clusters" ADD COLUMN IF NOT EXISTS "topic_type" "query_topic_type";--> statement-breakpoint
ALTER TABLE "query_clusters" ADD COLUMN IF NOT EXISTS "branded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "query_clusters" ADD COLUMN IF NOT EXISTS "head_terms" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "query_clusters" ADD COLUMN IF NOT EXISTS "coverage" "coverage_status" DEFAULT 'NONE' NOT NULL;--> statement-breakpoint
ALTER TABLE "query_clusters" ADD COLUMN IF NOT EXISTS "coverage_reason" text;--> statement-breakpoint
ALTER TABLE "query_clusters" ADD COLUMN IF NOT EXISTS "covered_by_url" text;--> statement-breakpoint
ALTER TABLE "query_clusters" ADD COLUMN IF NOT EXISTS "recommended_asset" text;--> statement-breakpoint
ALTER TABLE "query_clusters" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Clusters that only hold generated or imported queries came from templates: semantic clustering may reassign them.
UPDATE "query_clusters" c SET "origin" = 'TEMPLATE'
WHERE NOT EXISTS (SELECT 1 FROM "queries" q WHERE q.cluster_id = c.id AND q.source = 'MANUAL');--> statement-breakpoint
-- 2. AI visibility lab: per-test provenance and per-mention snippets.
ALTER TABLE "ai_visibility_prompts" ADD COLUMN IF NOT EXISTS "locale" text DEFAULT 'en' NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_visibility_tests" ADD COLUMN IF NOT EXISTS "prompt_text" text;--> statement-breakpoint
ALTER TABLE "ai_visibility_tests" ADD COLUMN IF NOT EXISTS "served_model" text;--> statement-breakpoint
ALTER TABLE "ai_visibility_tests" ADD COLUMN IF NOT EXISTS "grounded" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_visibility_tests" ADD COLUMN IF NOT EXISTS "params" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "ai_visibility_tests" ADD COLUMN IF NOT EXISTS "locale" text;--> statement-breakpoint
ALTER TABLE "ai_visibility_tests" ADD COLUMN IF NOT EXISTS "citation_details" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
-- Prompts were never editable, so the current prompt text is the text that was sent.
UPDATE "ai_visibility_tests" t SET "prompt_text" = p.prompt, "locale" = 'en' FROM "ai_visibility_prompts" p WHERE p.id = t.prompt_id AND t.prompt_text IS NULL;--> statement-breakpoint
ALTER TABLE "ai_mentions" ADD COLUMN IF NOT EXISTS "snippet" text;--> statement-breakpoint
ALTER TABLE "ai_mentions" ADD COLUMN IF NOT EXISTS "mention_offset" integer;--> statement-breakpoint
ALTER TABLE "competitors" ADD COLUMN IF NOT EXISTS "aliases" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- 3. Citation analysis.
CREATE TABLE IF NOT EXISTS "ai_citations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "test_id" uuid NOT NULL,
  "prompt_id" uuid,
  "product_id" uuid,
  "competitor_id" uuid,
  "url" text NOT NULL,
  "host" text NOT NULL,
  "registrable_domain" text NOT NULL,
  "kind" text NOT NULL,
  "category" text NOT NULL,
  "position" integer NOT NULL,
  "title" text,
  "near_product_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "near_competitor_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "observed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
ALTER TABLE "ai_citations" ADD CONSTRAINT "ai_citations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_citations" ADD CONSTRAINT "ai_citations_test_id_ai_visibility_tests_id_fk" FOREIGN KEY ("test_id") REFERENCES "public"."ai_visibility_tests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_citations" ADD CONSTRAINT "ai_citations_prompt_id_ai_visibility_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."ai_visibility_prompts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_citations" ADD CONSTRAINT "ai_citations_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_citations" ADD CONSTRAINT "ai_citations_competitor_id_competitors_id_fk" FOREIGN KEY ("competitor_id") REFERENCES "public"."competitors"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_citations_org_domain_idx" ON "ai_citations" USING btree ("organization_id", "registrable_domain", "observed_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_citations_test_idx" ON "ai_citations" USING btree ("test_id");--> statement-breakpoint
ALTER TABLE "ai_citations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ai_citations_tenant_isolation" ON "ai_citations" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
-- Backfill from citations already stored on tests. Mirrors core/visibility/citations.ts (host, registrable domain,
-- OWN / COMPETITOR / THIRD_PARTY and the documented category heuristic). Proximity to mentions is unknown for old rows.
INSERT INTO "ai_citations" ("organization_id", "test_id", "prompt_id", "product_id", "competitor_id", "url", "host", "registrable_domain", "kind", "category", "position", "observed_at")
SELECT x.organization_id, x.test_id, x.prompt_id, x.product_id, x.competitor_id, x.url, x.host, x.reg, x.kind,
  CASE
    WHEN x.kind <> 'THIRD_PARTY' AND (x.host ~ '^(docs|developers?|help|support|kb|learn)\.' OR x.url ~* '/(docs|documentation|help)(/|$|\?|#)') THEN 'DOCUMENTATION'
    WHEN x.kind <> 'THIRD_PARTY' THEN 'OFFICIAL_SITE'
    WHEN x.reg IN ('g2.com','capterra.com','trustpilot.com','getapp.com','softwareadvice.com','trustradius.com','gartner.com','peerspot.com','sitejabber.com') THEN 'REVIEW_SITE'
    WHEN x.reg IN ('producthunt.com','alternativeto.net','saashub.com','crunchbase.com','sourceforge.net','slant.co','stackshare.io','futurepedia.io','theresanaiforthat.com','toolify.ai')
      OR x.host IN ('apps.apple.com','play.google.com','chromewebstore.google.com','marketplace.visualstudio.com') THEN 'DIRECTORY'
    WHEN x.reg IN ('reddit.com','quora.com','stackoverflow.com','stackexchange.com','ycombinator.com','medium.com','dev.to','github.com','youtube.com','x.com','twitter.com','linkedin.com','facebook.com','discord.com','indiehackers.com','substack.com') THEN 'COMMUNITY'
    WHEN x.reg IN ('techcrunch.com','theverge.com','forbes.com','reuters.com','bloomberg.com','wired.com','venturebeat.com','businessinsider.com','zdnet.com','cnet.com','engadget.com','bbc.co.uk','bbc.com','nytimes.com','theguardian.com','lemonde.fr','lesechos.fr')
      OR x.host ~ '^news\.' THEN 'NEWS'
    WHEN lower(x.url) ~ '(-vs-|/vs/|[-/_]versus[-/_]|alternative|compare|comparison|/best-)' THEN 'COMPARISON'
    WHEN x.host ~ '^(docs|developers?|help|support|kb|learn)\.' THEN 'DOCUMENTATION'
    ELSE 'OTHER'
  END,
  x.ord, x.ran_at
FROM (
  SELECT t.organization_id, t.id AS test_id, t.prompt_id, p.product_id, t.ran_at, c.url, c.ord::int AS ord, h.host,
    COALESCE(substring(h.host from '([^.]+\.(?:co|com|org|net|gov|ac|edu)\.[a-z]{2})$'), substring(h.host from '([^.]+\.[^.]+)$'), h.host) AS reg,
    own.id AS own_id, comp.id AS competitor_id,
    CASE WHEN own.id IS NOT NULL THEN 'OWN' WHEN comp.id IS NOT NULL THEN 'COMPETITOR' ELSE 'THIRD_PARTY' END AS kind
  FROM "ai_visibility_tests" t
  JOIN "ai_visibility_prompts" p ON p.id = t.prompt_id
  CROSS JOIN LATERAL jsonb_array_elements_text(t.citations) WITH ORDINALITY AS c(url, ord)
  CROSS JOIN LATERAL (SELECT regexp_replace(lower(substring(c.url from '^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^@/]*@)?([^:/?#]+)')), '^www\.', '') AS host) h
  LEFT JOIN LATERAL (
    SELECT pr.id FROM "products" pr
    WHERE pr.organization_id = t.organization_id AND pr.domain IS NOT NULL
      AND (h.host = regexp_replace(regexp_replace(regexp_replace(lower(pr.domain), '^https?://', ''), '/.*$', ''), '^www\.', '')
        OR h.host LIKE '%.' || regexp_replace(regexp_replace(regexp_replace(lower(pr.domain), '^https?://', ''), '/.*$', ''), '^www\.', ''))
    LIMIT 1
  ) own ON true
  LEFT JOIN LATERAL (
    SELECT co.id FROM "competitors" co
    WHERE co.organization_id = t.organization_id AND co.domain IS NOT NULL
      AND (h.host = regexp_replace(regexp_replace(regexp_replace(lower(co.domain), '^https?://', ''), '/.*$', ''), '^www\.', '')
        OR h.host LIKE '%.' || regexp_replace(regexp_replace(regexp_replace(lower(co.domain), '^https?://', ''), '/.*$', ''), '^www\.', ''))
    LIMIT 1
  ) comp ON true
  WHERE h.host IS NOT NULL AND h.host <> ''
) x
WHERE NOT EXISTS (SELECT 1 FROM "ai_citations" a WHERE a.test_id = x.test_id);--> statement-breakpoint
-- 4. Opportunity engine v2: category taxonomy, per-factor rationale, next action, sources, OBSOLETE status.
ALTER TYPE "public"."opportunity_status" ADD VALUE IF NOT EXISTS 'OBSOLETE';--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN IF NOT EXISTS "category" text DEFAULT 'CONTENT' NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN IF NOT EXISTS "scoring_rationale" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN IF NOT EXISTS "next_action" jsonb;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN IF NOT EXISTS "sources" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "opportunities" ADD COLUMN IF NOT EXISTS "obsoleted_at" timestamp with time zone;--> statement-breakpoint
UPDATE "opportunities" SET "type" = 'PRODUCT_KNOWLEDGE' WHERE "type" = 'ENTITY_COMPLETENESS';--> statement-breakpoint
UPDATE "opportunities" SET "category" = CASE
  WHEN "type" IN ('STRIKING_DISTANCE', 'LOW_CTR', 'VISIBILITY_DROP') THEN 'QUERY'
  WHEN "type" IN ('AI_VISIBILITY_GAP') THEN 'AI_VISIBILITY'
  WHEN "type" IN ('TECHNICAL', 'INTERNAL_LINKING') THEN 'TECHNICAL'
  WHEN "type" IN ('PRODUCT_KNOWLEDGE', 'COMPARISON_FACTS') THEN 'PRODUCT_KNOWLEDGE'
  WHEN "type" = 'CONVERSION' THEN 'CONVERSION'
  ELSE 'CONTENT'
END;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "opportunities_org_category_idx" ON "opportunities" USING btree ("organization_id", "category", "status");--> statement-breakpoint
ALTER TABLE "ai_citations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "queries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "query_clusters" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_visibility_prompts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_visibility_tests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "competitors" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "opportunities" FORCE ROW LEVEL SECURITY;
