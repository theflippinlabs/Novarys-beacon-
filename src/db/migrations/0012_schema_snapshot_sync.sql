-- Align hand-written constraint names with the Drizzle schema so future generated migrations match the database.
ALTER TABLE "attribution_credits" RENAME CONSTRAINT "attribution_credits_campaign_id_fk" TO "attribution_credits_campaign_id_campaigns_id_fk";
--> statement-breakpoint
ALTER TABLE "attribution_credits" RENAME CONSTRAINT "attribution_credits_conversion_event_id_fk" TO "attribution_credits_conversion_event_id_conversion_events_id_fk";
--> statement-breakpoint
ALTER TABLE "attribution_credits" RENAME CONSTRAINT "attribution_credits_revenue_event_id_fk" TO "attribution_credits_revenue_event_id_revenue_events_id_fk";
--> statement-breakpoint
ALTER TABLE "attribution_credits" RENAME CONSTRAINT "attribution_credits_touch_id_fk" TO "attribution_credits_touch_id_attribution_events_id_fk";
--> statement-breakpoint
ALTER TABLE "conversion_events" RENAME CONSTRAINT "conversion_events_attribution_touch_id_fk" TO "conversion_events_attribution_touch_id_attribution_events_id_fk";
--> statement-breakpoint
ALTER TABLE "conversion_events" RENAME CONSTRAINT "conversion_events_first_touch_id_fk" TO "conversion_events_first_touch_id_attribution_events_id_fk";
--> statement-breakpoint
ALTER TABLE "cross_sell_rules" RENAME CONSTRAINT "cross_sell_rules_relationship_id_fk" TO "cross_sell_rules_relationship_id_product_relationships_id_fk";
--> statement-breakpoint
ALTER TABLE "product_changelog" RENAME CONSTRAINT "product_changelog_verified_by_fkey" TO "product_changelog_verified_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "product_claims" RENAME CONSTRAINT "product_claims_organization_id_fkey" TO "product_claims_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "product_claims" RENAME CONSTRAINT "product_claims_product_id_fkey" TO "product_claims_product_id_products_id_fk";
--> statement-breakpoint
ALTER TABLE "product_claims" RENAME CONSTRAINT "product_claims_source_id_fkey" TO "product_claims_source_id_product_sources_id_fk";
--> statement-breakpoint
ALTER TABLE "product_claims" RENAME CONSTRAINT "product_claims_verified_by_fkey" TO "product_claims_verified_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "product_facets" RENAME CONSTRAINT "product_facets_verified_by_fkey" TO "product_facets_verified_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "product_faqs" RENAME CONSTRAINT "product_faqs_verified_by_fkey" TO "product_faqs_verified_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "product_pricing" RENAME CONSTRAINT "product_pricing_verified_by_fkey" TO "product_pricing_verified_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "product_proofs" RENAME CONSTRAINT "product_proofs_verified_by_fkey" TO "product_proofs_verified_by_users_id_fk";
--> statement-breakpoint
ALTER TABLE "product_relationships" RENAME CONSTRAINT "product_relationships_from_product_id_fk" TO "product_relationships_from_product_id_products_id_fk";
--> statement-breakpoint
ALTER TABLE "product_relationships" RENAME CONSTRAINT "product_relationships_source_id_fk" TO "product_relationships_source_id_product_sources_id_fk";
--> statement-breakpoint
ALTER TABLE "product_relationships" RENAME CONSTRAINT "product_relationships_to_product_id_fk" TO "product_relationships_to_product_id_products_id_fk";
