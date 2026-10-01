-- Memberships carry organization_id and reveal who belongs to which tenant:
-- protect them with the same tenant-isolation policy as other tenant tables.
ALTER TABLE "memberships" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "memberships" FORCE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "memberships_tenant_isolation" ON "memberships" USING (beacon_rls_allows(organization_id)) WITH CHECK (beacon_rls_allows(organization_id));
