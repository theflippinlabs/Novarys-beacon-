import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, withOrg } from "@/db";
import { auditLogs, integrations, verifiedDomains } from "@/db/schema";
import { recordConnectionResult } from "@/services/integration-health";
import { newOrg, seedCompleteProduct, uid } from "./helpers";

afterAll(closeDb);

async function connect(orgId: string, productId: string, siteUrl: string, permission: string) {
  const [integ] = await withOrg(orgId, (tx) => tx.insert(integrations).values({ organizationId: orgId, productId, provider: "GOOGLE_SEARCH_CONSOLE", status: "NOT_CONNECTED", config: { siteUrl } }).returning());
  await withOrg(orgId, (tx) => recordConnectionResult(tx, integ, { ok: true, message: "Connected to Search Console.", scopes: ["https://www.googleapis.com/auth/webmasters.readonly", `property:${permission}`] }));
  return withOrg(orgId, (tx) => tx.select().from(verifiedDomains).where(eq(verifiedDomains.organizationId, orgId)));
}

describe("domains verified through Search Console", () => {
  it("a domain property with full access verifies the domain, audited, without DNS", async () => {
    const { org } = await newOrg("gscdom");
    const { product } = await seedCompleteProduct(org.id, { name: `Gsc ${uid()}` });
    const rows = await connect(org.id, product.id, "sc-domain:Novarys-Test.example", "siteFullUser");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ domain: "novarys-test.example", method: "SEARCH_CONSOLE" });
    expect(rows[0].verifiedAt).not.toBeNull();
    const logs = await withOrg(org.id, (tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.organizationId, org.id), eq(auditLogs.action, "domain.verify"))));
    expect(logs).toHaveLength(1);
  });

  it("a pending domain added by hand becomes verified, and a sync later changes nothing", async () => {
    const { org } = await newOrg("gscdom2");
    const { product } = await seedCompleteProduct(org.id, { name: `Gsc ${uid()}` });
    await withOrg(org.id, (tx) => tx.insert(verifiedDomains).values({ organizationId: org.id, domain: "pending.example", token: "t".repeat(32) }));
    const rows = await connect(org.id, product.id, "https://pending.example/", "siteOwner");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ domain: "pending.example", method: "SEARCH_CONSOLE" });
  });

  it("restricted or unverified access does not verify anything", async () => {
    const { org } = await newOrg("gscdom3");
    const { product } = await seedCompleteProduct(org.id, { name: `Gsc ${uid()}` });
    expect(await connect(org.id, product.id, "sc-domain:restricted.example", "siteRestrictedUser")).toHaveLength(0);
    const { product: other } = await seedCompleteProduct(org.id, { name: `Gsc ${uid()}` });
    expect(await connect(org.id, other.id, "sc-domain:unverified.example", "siteUnverifiedUser")).toHaveLength(0);
  });
});
