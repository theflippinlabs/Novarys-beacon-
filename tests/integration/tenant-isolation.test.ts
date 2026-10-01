import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { asSystem, closeDb, withOrg } from "@/db";
import { TENANT_TABLES } from "@/db/schema";
import { newOrg, seedCompleteProduct } from "./helpers";

/**
 * Parameterised cross-tenant test over EVERY table of TENANT_TABLES: org B
 * gets at least one row in each table (built programmatically from the
 * catalog, so new tenant tables are covered automatically), and org A's
 * tenant scope can neither read, update nor delete any of them.
 */
type Col = { table: string; column: string; dataType: string; udt: string; nullable: boolean; hasDefault: boolean };
type Fk = { table: string; column: string; refTable: string; refColumn: string };

let A: Awaited<ReturnType<typeof newOrg>>;
let B: Awaited<ReturnType<typeof newOrg>>;
const failures: Record<string, string> = {};

async function catalog() {
  return asSystem(async (tx) => {
    const cols = await tx.execute<{ table_name: string; column_name: string; data_type: string; udt_name: string; is_nullable: string; column_default: string | null }>(sql`
      select table_name, column_name, data_type, udt_name, is_nullable, column_default from information_schema.columns
      where table_schema = 'public' order by table_name, ordinal_position`);
    const fks = await tx.execute<{ table_name: string; column_name: string; ref_table: string; ref_column: string }>(sql`
      select cl.relname as table_name, a.attname as column_name, rcl.relname as ref_table, ra.attname as ref_column
      from pg_constraint c
      join pg_class cl on cl.oid = c.conrelid join pg_namespace n on n.oid = cl.relnamespace
      join pg_class rcl on rcl.oid = c.confrelid
      join lateral unnest(c.conkey) with ordinality k(attnum, i) on true
      join lateral unnest(c.confkey) with ordinality rk(attnum, i) on rk.i = k.i
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      join pg_attribute ra on ra.attrelid = c.confrelid and ra.attnum = rk.attnum
      where c.contype = 'f' and n.nspname = 'public'`);
    const enums = await tx.execute<{ typname: string; label: string }>(sql`
      select t.typname, e.enumlabel as label from pg_type t join pg_enum e on e.enumtypid = t.oid order by t.typname, e.enumsortorder`);
    const enumFirst = new Map<string, string>();
    for (const e of enums.rows) if (!enumFirst.has(e.typname)) enumFirst.set(e.typname, e.label);
    return {
      cols: cols.rows.map((c): Col => ({ table: c.table_name, column: c.column_name, dataType: c.data_type, udt: c.udt_name, nullable: c.is_nullable === "YES", hasDefault: c.column_default !== null })),
      fks: fks.rows.map((f): Fk => ({ table: f.table_name, column: f.column_name, refTable: f.ref_table, refColumn: f.ref_column })),
      enumFirst,
    };
  });
}

function valueFor(c: Col, enumFirst: Map<string, string>): SQL {
  if (c.dataType === "USER-DEFINED") return sql`${enumFirst.get(c.udt) ?? null}`;
  if (c.dataType === "ARRAY") return sql`${"{}"}`;
  switch (c.udt) {
    case "uuid":
      return sql`${randomUUID()}`;
    case "int2":
    case "int4":
    case "int8":
    case "numeric":
    case "float4":
    case "float8":
      return sql`${1}`;
    case "bool":
      return sql`${false}`;
    case "jsonb":
    case "json":
      return sql`${"{}"}`;
    case "timestamptz":
    case "timestamp":
      return sql`now()`;
    case "date":
      return sql`${"2026-01-01"}`;
    case "bytea":
      return sql`${Buffer.from([0])}`;
    default:
      return sql`${`iso-${c.column}-${randomUUID().slice(0, 8)}`}`;
  }
}

/** Insert one row for org B into `table`, resolving foreign keys to org B's existing rows. */
async function seedRow(table: string, cols: Col[], fks: Fk[], enumFirst: Map<string, string>, withOptionalRefs = false): Promise<boolean> {
  const own = cols.filter((c) => c.table === table);
  const fkOf = new Map(fks.filter((f) => f.table === table).map((f) => [f.column, f]));
  const names: SQL[] = [];
  const values: SQL[] = [];
  // Several references to the same table (from/to product) get distinct rows.
  const used = new Map<string, number>();
  for (const c of own) {
    const fk = fkOf.get(c.column);
    if (c.column === "organization_id") {
      names.push(sql`${sql.identifier(c.column)}`);
      values.push(sql`${B.org.id}`);
      continue;
    }
    if (fk) {
      if (c.nullable && !withOptionalRefs) continue;
      const offset = used.get(fk.refTable) ?? 0;
      used.set(fk.refTable, offset + 1);
      const ref = await asSystem(async (tx) => {
        const refCols = cols.filter((x) => x.table === fk.refTable).map((x) => x.column);
        const filter = fk.refTable === "users" ? sql`${sql.identifier(fk.refColumn)} = ${B.user.id}` : refCols.includes("organization_id") ? sql`organization_id = ${B.org.id}` : fk.refTable === "organizations" ? sql`id = ${B.org.id}` : sql`true`;
        const r = await tx.execute<{ v: string }>(sql`select ${sql.identifier(fk.refColumn)}::text as v from ${sql.identifier(fk.refTable)} where ${filter} order by 1 limit 1 offset ${offset}`);
        return r.rows[0]?.v;
      });
      if (!ref) {
        if (c.nullable) continue;
        return false;
      }
      names.push(sql`${sql.identifier(c.column)}`);
      values.push(sql`${ref}`);
      continue;
    }
    if (c.nullable || c.hasDefault) continue;
    names.push(sql`${sql.identifier(c.column)}`);
    values.push(valueFor(c, enumFirst));
  }
  try {
    await asSystem((tx) => tx.execute(sql`insert into ${sql.identifier(table)} (${sql.join(names, sql`, `)}) values (${sql.join(values, sql`, `)})`));
    return true;
  } catch (e) {
    const cause = (e as { cause?: { message?: string } }).cause;
    failures[table] = cause?.message ?? (e as Error).message;
    return false;
  }
}

const countFor = (table: string, orgId: string) =>
  asSystem(async (tx) => Number((await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${sql.identifier(table)} where organization_id = ${orgId}`)).rows[0].n));

beforeAll(async () => {
  A = await newOrg("iso-a");
  B = await newOrg("iso-b");
  // A realistic graph first (products, sources, facets, pricing, FAQs, proofs, changelog, competitors).
  await seedCompleteProduct(B.org.id, { name: "Isolated Product" });
  await seedCompleteProduct(B.org.id, { name: "Second Isolated Product" });
  const { cols, fks, enumFirst } = await catalog();
  // Fill every other tenant table, in passes, so rows that reference other tenant rows find them.
  let pending = (TENANT_TABLES as readonly string[]).slice();
  for (let pass = 0; pass < 6 && pending.length; pass++) {
    const next: string[] = [];
    for (const t of pending) {
      if ((await countFor(t, B.org.id)) > 0) continue;
      // Check constraints (e.g. "one of these references is required") need the optional references too.
      if (!(await seedRow(t, cols, fks, enumFirst)) && !(await seedRow(t, cols, fks, enumFirst, true))) next.push(t);
    }
    pending = next;
  }
}, 120_000);
afterAll(closeDb);

describe("tenant isolation over every TENANT_TABLES entry", () => {
  it("seeded at least one org-B row in every tenant table", async () => {
    const empty: string[] = [];
    for (const t of TENANT_TABLES) if ((await countFor(t, B.org.id)) === 0) empty.push(`${t}${failures[t] ? ` (${failures[t]})` : ""}`);
    expect(empty).toEqual([]);
  });

  it.each([...TENANT_TABLES])("%s: org A cannot read, update or delete org B's rows", async (table) => {
    const t = sql.identifier(table);
    const seenByB = await withOrg(B.org.id, async (tx) => Number((await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${t} where organization_id = ${B.org.id}`)).rows[0].n));
    expect(seenByB).toBeGreaterThan(0);
    const result = await withOrg(A.org.id, async (tx) => {
      const read = Number((await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${t} where organization_id = ${B.org.id}`)).rows[0].n);
      const readAll = Number((await tx.execute<{ n: number }>(sql`select count(*)::int as n from ${t} where organization_id <> ${A.org.id}`)).rows[0].n);
      const upd = (await tx.execute(sql`update ${t} set organization_id = organization_id where organization_id = ${B.org.id}`)).rowCount ?? 0;
      const del = (await tx.execute(sql`delete from ${t} where organization_id = ${B.org.id}`)).rowCount ?? 0;
      return { read, readAll, upd, del };
    });
    expect(result).toEqual({ read: 0, readAll: 0, upd: 0, del: 0 });
    expect(await countFor(table, B.org.id)).toBe(seenByB);
  });

  it("org A cannot move its own rows into org B (WITH CHECK)", async () => {
    await seedCompleteProduct(A.org.id, { name: "Org A Product" });
    const err = await withOrg(A.org.id, (tx) => tx.execute(sql`update products set organization_id = ${B.org.id} where organization_id = ${A.org.id}`)).catch((e: { cause?: { code?: string } }) => e.cause?.code);
    expect(err).toBe("42501");
  });
});
