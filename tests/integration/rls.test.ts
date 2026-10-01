import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { asSystem, closeDb, db, withOrg } from "@/db";
import { memberships, products, TENANT_TABLES } from "@/db/schema";
import { newOrg, pgError, uid } from "./helpers";

type Org = Awaited<ReturnType<typeof newOrg>>;
let A: Org;
let B: Org;
let productA: typeof products.$inferSelect;
let productB: typeof products.$inferSelect;

beforeAll(async () => {
  A = await newOrg("rls-a");
  B = await newOrg("rls-b");
  productA = await withOrg(A.org.id, async (tx) => (await tx.insert(products).values({ organizationId: A.org.id, slug: `pa-${uid()}`, name: "Product A" }).returning())[0]);
  productB = await withOrg(B.org.id, async (tx) => (await tx.insert(products).values({ organizationId: B.org.id, slug: `pb-${uid()}`, name: "Product B" }).returning())[0]);
});
afterAll(closeDb);

describe("row level security", () => {
  it("runs as a non-superuser role (otherwise RLS would be bypassed)", async () => {
    const r = await db().execute<{ rolsuper: boolean; rolbypassrls: boolean }>(sql`select rolsuper, rolbypassrls from pg_roles where rolname = current_user`);
    expect(r.rows[0]).toEqual({ rolsuper: false, rolbypassrls: false });
  });

  it("rows of org A are invisible inside withOrg(orgB)", async () => {
    const seenByB = await withOrg(B.org.id, (tx) => tx.select().from(products));
    expect(seenByB.map((p) => p.id)).toContain(productB.id);
    expect(seenByB.map((p) => p.id)).not.toContain(productA.id);
    // Even an explicit filter on A's id returns nothing.
    const direct = await withOrg(B.org.id, (tx) => tx.select().from(products).where(eq(products.id, productA.id)));
    expect(direct).toHaveLength(0);
    // Updates/deletes against A's row from B's scope affect nothing.
    const upd = await withOrg(B.org.id, (tx) => tx.update(products).set({ name: "hijacked" }).where(eq(products.id, productA.id)).returning());
    expect(upd).toHaveLength(0);
    const del = await withOrg(B.org.id, (tx) => tx.delete(products).where(eq(products.id, productA.id)).returning());
    expect(del).toHaveLength(0);
    const stillThere = await withOrg(A.org.id, (tx) => tx.select().from(products).where(eq(products.id, productA.id)));
    expect(stillThere[0].name).toBe("Product A");
  });

  it("db() without tenant settings returns no tenant rows (fails closed)", async () => {
    const rows = await db().select().from(products);
    expect(rows).toHaveLength(0);
    const r = await db().execute<{ n: number }>(sql`select count(*)::int as n from products`);
    expect(r.rows[0].n).toBe(0);
  });

  it("settings do not leak out of a withOrg transaction onto the pooled connection", async () => {
    await withOrg(A.org.id, (tx) => tx.select().from(products));
    for (let i = 0; i < 5; i++) expect(await db().select().from(products)).toHaveLength(0);
  });

  it("inserting a row for org A while scoped to org B is rejected by WITH CHECK", async () => {
    const ins = await pgError(withOrg(B.org.id, (tx) => tx.insert(products).values({ organizationId: A.org.id, slug: `evil-${uid()}`, name: "Evil" })));
    expect(ins.code).toBe("42501");
    expect(ins.message).toMatch(/row-level security/i);
    // Moving a B row into org A is rejected too.
    const mv = await pgError(withOrg(B.org.id, (tx) => tx.update(products).set({ organizationId: A.org.id }).where(eq(products.id, productB.id))));
    expect(mv.code).toBe("42501");
    // Raw db() writes (no tenant) are rejected.
    const raw = await pgError(db().insert(products).values({ organizationId: A.org.id, slug: `raw-${uid()}`, name: "Raw" }));
    expect(raw.code).toBe("42501");
  });

  it("asSystem sees both organisations' rows", async () => {
    const ids = (await asSystem((tx) => tx.select({ id: products.id }).from(products))).map((r) => r.id);
    expect(ids).toEqual(expect.arrayContaining([productA.id, productB.id]));
  });

  it("withOrg rejects a malformed organization id", async () => {
    await expect(withOrg("' or 1=1 --", async () => 1)).rejects.toThrow("Invalid organization id");
  });

  it("every TENANT_TABLES entry has RLS enabled and forced, with a policy", async () => {
    const r = await db().execute<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; policies: number }>(sql`
      select c.relname, c.relrowsecurity, c.relforcerowsecurity, (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies
      from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'`);
    const byName = new Map(r.rows.map((x) => [x.relname, x]));
    for (const t of TENANT_TABLES) {
      const row = byName.get(t);
      expect(row, `table ${t} exists`).toBeDefined();
      expect({ t, enabled: row!.relrowsecurity, forced: row!.relforcerowsecurity, hasPolicy: row!.policies > 0 }).toEqual({ t, enabled: true, forced: true, hasPolicy: true });
    }
  });

  // BUG: `memberships` carries organization_id but is neither in TENANT_TABLES nor
  // protected by RLS (0001_rls.sql), contrary to the schema.ts convention
  // "Every tenant-owned table carries organization_id and is protected by RLS".
  it("every table with an organization_id column (except jobs, sessions) is in TENANT_TABLES", async () => {
    const r = await db().execute<{ table_name: string }>(sql`
      select distinct table_name from information_schema.columns
      where table_schema = 'public' and column_name = 'organization_id' order by table_name`);
    const withOrgCol = r.rows.map((x) => x.table_name).filter((t) => t !== "jobs" && t !== "sessions");
    const missing = withOrgCol.filter((t) => !(TENANT_TABLES as readonly string[]).includes(t));
    expect(missing).toEqual([]);
  });

  it("all organization_id tables other than memberships/jobs/sessions are covered (guards against new regressions)", async () => {
    const r = await db().execute<{ table_name: string }>(sql`
      select distinct table_name from information_schema.columns where table_schema = 'public' and column_name = 'organization_id'`);
    const missing = r.rows.map((x) => x.table_name).filter((t) => !["jobs", "sessions", "memberships"].includes(t) && !(TENANT_TABLES as readonly string[]).includes(t));
    expect(missing).toEqual([]);
  });

  // BUG (same root cause): org B's tenant scope can read org A's memberships (user ids + roles).
  it("memberships of org A are invisible inside withOrg(orgB)", async () => {
    const rows = await withOrg(B.org.id, (tx) => tx.select().from(memberships).where(eq(memberships.organizationId, A.org.id)));
    expect(rows).toHaveLength(0);
  });
});
