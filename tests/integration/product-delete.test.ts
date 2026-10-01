import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { closeDb, withOrg } from "@/db";
import { auditLogs, productFacets, products, queries } from "@/db/schema";
import { can } from "@/lib/auth/rbac";
import { createProduct, deleteProduct, syncFacets } from "@/services/products";
import { newOrg } from "./helpers";

let a: Awaited<ReturnType<typeof newOrg>>;
let b: Awaited<ReturnType<typeof newOrg>>;

beforeAll(async () => {
  a = await newOrg("del-a");
  b = await newOrg("del-b");
});
afterAll(closeDb);

describe("deleteProduct", () => {
  it("is reserved for owners and admins", () => {
    expect(can("OWNER", "product:delete")).toBe(true);
    expect(can("ADMIN", "product:delete")).toBe(true);
    expect(can("EDITOR", "product:delete")).toBe(false);
    expect(can("VIEWER", "product:delete")).toBe(false);
  });

  it("removes the product and its knowledge graph, and audits the deletion", async () => {
    const p = await withOrg(a.org.id, (tx) => createProduct(tx, a.actor, { name: "Doomed App" }));
    await withOrg(a.org.id, (tx) => syncFacets(tx, a.actor, p.id, "FEATURE", [{ name: "Exports", slug: "exports", description: null }]));
    await withOrg(a.org.id, (tx) => tx.insert(queries).values({ organizationId: a.org.id, productId: p.id, query: "doomed app exports", normalized: "doomed app exports", intent: "INFORMATIONAL", funnelStage: "AWARENESS" }));

    await withOrg(a.org.id, (tx) => deleteProduct(tx, a.actor, p.id));

    const left = await withOrg(a.org.id, async (tx) => ({
      product: await tx.select().from(products).where(eq(products.id, p.id)),
      facets: await tx.select().from(productFacets).where(eq(productFacets.productId, p.id)),
      queries: await tx.select().from(queries).where(eq(queries.productId, p.id)),
      log: await tx.select().from(auditLogs).where(and(eq(auditLogs.action, "product.delete"), eq(auditLogs.entityId, p.id))),
    }));
    expect(left.product).toEqual([]);
    expect(left.facets).toEqual([]);
    expect(left.queries).toEqual([]);
    expect(left.log).toEqual([expect.objectContaining({ metadata: expect.objectContaining({ name: "Doomed App" }) })]);
  });

  it("cannot delete another organisation's product", async () => {
    const other = await withOrg(b.org.id, (tx) => createProduct(tx, b.actor, { name: "Safe App" }));
    await expect(withOrg(a.org.id, (tx) => deleteProduct(tx, a.actor, other.id))).rejects.toThrow(/not found/);
    const still = await withOrg(b.org.id, (tx) => tx.select().from(products).where(eq(products.id, other.id)));
    expect(still).toHaveLength(1);
  });
});
