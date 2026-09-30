-- Row Level Security: tenant isolation (defence in depth).
-- The application sets `beacon.org_id` per transaction (SET LOCAL via set_config)
-- and only trusted system code (worker, auth) sets `beacon.bypass_rls`.
-- NOTE: Postgres superusers bypass RLS entirely; run the app as a non-superuser role.
CREATE OR REPLACE FUNCTION beacon_rls_allows(org uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT coalesce(current_setting('beacon.bypass_rls', true), '') = 'on'
      OR org::text = coalesce(current_setting('beacon.org_id', true), '')
$$;
--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "api_keys_tenant_isolation" ON "api_keys" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "audit_logs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "audit_logs_tenant_isolation" ON "audit_logs" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "products" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "products_tenant_isolation" ON "products" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "product_sources" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_sources" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "product_sources_tenant_isolation" ON "product_sources" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "product_facets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_facets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "product_facets_tenant_isolation" ON "product_facets" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "product_pricing" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_pricing" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "product_pricing_tenant_isolation" ON "product_pricing" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "product_faqs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_faqs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "product_faqs_tenant_isolation" ON "product_faqs" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "product_proofs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_proofs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "product_proofs_tenant_isolation" ON "product_proofs" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "product_changelog" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_changelog" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "product_changelog_tenant_isolation" ON "product_changelog" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "competitors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "competitors" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "competitors_tenant_isolation" ON "competitors" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "product_competitors" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "product_competitors" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "product_competitors_tenant_isolation" ON "product_competitors" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "query_clusters" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "query_clusters" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "query_clusters_tenant_isolation" ON "query_clusters" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "queries" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "queries" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "queries_tenant_isolation" ON "queries" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "pages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "pages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "pages_tenant_isolation" ON "pages" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "content_assets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "content_assets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "content_assets_tenant_isolation" ON "content_assets" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "content_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "content_versions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "content_versions_tenant_isolation" ON "content_versions" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "seo_audits" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "seo_audits" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "seo_audits_tenant_isolation" ON "seo_audits" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "seo_issues" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "seo_issues" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "seo_issues_tenant_isolation" ON "seo_issues" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "crawled_pages" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "crawled_pages" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "crawled_pages_tenant_isolation" ON "crawled_pages" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "visibility_metrics" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "visibility_metrics" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "visibility_metrics_tenant_isolation" ON "visibility_metrics" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "ai_visibility_prompts" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_visibility_prompts" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ai_visibility_prompts_tenant_isolation" ON "ai_visibility_prompts" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "ai_visibility_tests" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_visibility_tests" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ai_visibility_tests_tenant_isolation" ON "ai_visibility_tests" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "ai_mentions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_mentions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ai_mentions_tenant_isolation" ON "ai_mentions" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "opportunities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "opportunities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "opportunities_tenant_isolation" ON "opportunities" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "growth_reports" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "growth_reports" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "growth_reports_tenant_isolation" ON "growth_reports" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "recommendations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "recommendations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "recommendations_tenant_isolation" ON "recommendations" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "experiments" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "experiments" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "experiments_tenant_isolation" ON "experiments" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "ai_runs" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "ai_runs" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "ai_runs_tenant_isolation" ON "ai_runs" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "campaigns" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "campaigns" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "campaigns_tenant_isolation" ON "campaigns" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "distribution_targets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "distribution_targets" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "distribution_targets_tenant_isolation" ON "distribution_targets" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "identities" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "identities" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "identities_tenant_isolation" ON "identities" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "identity_products" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "identity_products" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "identity_products_tenant_isolation" ON "identity_products" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "affiliates" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "affiliates" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "affiliates_tenant_isolation" ON "affiliates" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "referral_codes" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "referral_codes" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "referral_codes_tenant_isolation" ON "referral_codes" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "attribution_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "attribution_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "attribution_events_tenant_isolation" ON "attribution_events" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "conversion_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "conversion_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "conversion_events_tenant_isolation" ON "conversion_events" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "subscriptions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "subscriptions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "subscriptions_tenant_isolation" ON "subscriptions" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "revenue_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "revenue_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "revenue_events_tenant_isolation" ON "revenue_events" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "commissions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "commissions" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "commissions_tenant_isolation" ON "commissions" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "cross_sell_rules" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cross_sell_rules" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cross_sell_rules_tenant_isolation" ON "cross_sell_rules" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "cross_sell_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cross_sell_events" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "cross_sell_events_tenant_isolation" ON "cross_sell_events" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "integrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "integrations" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "integrations_tenant_isolation" ON "integrations" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "provider_credentials" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "provider_credentials" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "provider_credentials_tenant_isolation" ON "provider_credentials" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));--> statement-breakpoint
ALTER TABLE "beacon_scores" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "beacon_scores" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "beacon_scores_tenant_isolation" ON "beacon_scores" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));
