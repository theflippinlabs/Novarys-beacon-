import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { asSystem, closeDb, db, systemDb, withOrg } from "@/db";
import { jobs, memberships, organizations, products, TENANT_TABLES } from "@/db/schema";
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

  it("memberships of org A are invisible inside withOrg(orgB)", async () => {
    const rows = await withOrg(B.org.id, (tx) => tx.select().from(memberships).where(eq(memberships.organizationId, A.org.id)));
    expect(rows).toHaveLength(0);
  });

  it("the application role cannot bypass RLS through session settings", async () => {
    // The pre-Phase-2 bypass setting is ignored, in a tenant scope and on a raw connection.
    const scoped = await withOrg(B.org.id, async (tx) => {
      await tx.execute(sql`select set_config('beacon.bypass_rls', 'on', true)`);
      return tx.select({ id: products.id }).from(products);
    });
    expect(scoped.map((r) => r.id)).not.toContain(productA.id);
    const raw = await db().transaction(async (tx) => {
      await tx.execute(sql`select set_config('beacon.bypass_rls', 'on', true)`);
      return tx.execute<{ n: number }>(sql`select count(*)::int as n from products`);
    });
    expect(raw.rows[0].n).toBe(0);
    // row_security = off does not bypass for a non-BYPASSRLS role: the query is refused.
    const off = await pgError(
      db().transaction(async (tx) => {
        await tx.execute(sql`set local row_security = off`);
        return tx.execute(sql`select count(*) from products`);
      }),
    );
    expect(off.message).toMatch(/row-level security/i);
    // An empty org id never matches.
    const empty = await db().transaction(async (tx) => {
      await tx.execute(sql`select set_config('beacon.org_id', '', true)`);
      return tx.select().from(products);
    });
    expect(empty).toHaveLength(0);
  });

  it("the application role is not a member of the system role and cannot assume it", async () => {
    const r = await db().execute<{ n: number }>(sql`select count(*)::int as n from pg_auth_members m join pg_roles r on r.oid = m.roleid join pg_roles u on u.oid = m.member where u.rolname = current_user and r.rolbypassrls`);
    expect(r.rows[0].n).toBe(0);
    const setRole = await pgError(db().execute(sql`set role beacon_system`));
    expect(setRole.code).toBe("42501");
  });

  it("asSystem runs as a separate BYPASSRLS role that is not a superuser", async () => {
    const r = await asSystem((tx) => tx.execute<{ user: string; rolsuper: boolean; rolbypassrls: boolean }>(sql`select current_user as user, rolsuper, rolbypassrls from pg_roles where rolname = current_user`));
    expect(r.rows[0]).toMatchObject({ rolsuper: false, rolbypassrls: true });
    const app = await db().execute<{ user: string }>(sql`select current_user as user`);
    expect(r.rows[0].user).not.toBe(app.rows[0].user);
  });

  it("organizations are RLS-protected: a tenant scope only sees its own organisation", async () => {
    const seen = await withOrg(B.org.id, (tx) => tx.select({ id: organizations.id }).from(organizations));
    expect(seen.map((o) => o.id)).toEqual([B.org.id]);
    const upd = await withOrg(B.org.id, (tx) => tx.update(organizations).set({ name: "hijacked" }).where(eq(organizations.id, A.org.id)).returning());
    expect(upd).toHaveLength(0);
    expect(await db().select().from(organizations)).toHaveLength(0);
    // Foreign keys to organizations still work inside a tenant scope (RI checks bypass RLS).
    const p = await withOrg(B.org.id, (tx) => tx.insert(products).values({ organizationId: B.org.id, slug: `fk-${uid()}`, name: "FK" }).returning());
    expect(p).toHaveLength(1);
  });

  it("jobs have RLS enabled and forced, with system jobs hidden from tenant scopes", async () => {
    const r = await db().execute<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(sql`select relrowsecurity, relforcerowsecurity from pg_class where relname = 'jobs' and relnamespace = 'public'::regnamespace`);
    expect(r.rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: true });
    const [sys] = await systemDb().insert(jobs).values({ type: "test.noop", organizationId: null, status: "CANCELLED" }).returning();
    const seen = await withOrg(A.org.id, (tx) => tx.select({ id: jobs.id }).from(jobs));
    expect(seen.map((j) => j.id)).not.toContain(sys.id);
    const ins = await pgError(withOrg(A.org.id, (tx) => tx.insert(jobs).values({ type: "test.noop", organizationId: null })));
    expect(ins.code).toBe("42501");
  });
});
