import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import sharp from "sharp";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { asSystem, closeDb, withOrg } from "@/db";
import { contentAssets, conversionEvents, media, memberships, products, users } from "@/db/schema";
import { createSession } from "@/lib/auth/service";
import { hashPassword } from "@/lib/security/crypto";
import { env } from "@/lib/env";
import { ROLES } from "@/lib/auth/rbac";
import { loadProductGraph } from "@/core/knowledge/load";
import { verifiedOnly } from "@/core/knowledge/types";
import { PAGE_SIZE, decodeCursor, pageOf } from "@/core/util/cursor";
import { afterCursor, msKey, tsCursor } from "@/lib/paginate";
import { publicGraphs } from "@/services/public";
import { dailySeries } from "@/services/metrics";
import { insertImage, prepareImage } from "@/services/media";
import { searchWorkspace } from "@/services/search";
import { newOrg, PASSWORD, seedCompleteProduct, uid } from "./helpers";

let session: string | null = null;
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: (name: string) => (name === "beacon_session" && session ? { value: session } : undefined), set: () => undefined, delete: () => undefined }),
  headers: async () => new Headers({ "x-forwarded-for": "10.7.7.7" }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`redirect ${url}`);
  },
  notFound: () => {
    throw new Error("404");
  },
}));

const { GET: searchGET } = await import("@/app/api/search/route");
const { POST: agentUploadPOST } = await import("@/app/api/agent/upload/route");

type Org = Awaited<ReturnType<typeof newOrg>>;
let A: Org;
let B: Org;
let nameA: string;
let nameB: string;
let productA: string;
let productB: string;

async function tokenFor(orgId: string, role: (typeof ROLES)[number]) {
  const [u] = await asSystem(async (tx) => tx.insert(users).values({ email: `${role.toLowerCase()}-${uid()}@example.test`, name: role, passwordHash: await hashPassword(PASSWORD) }).returning());
  await asSystem((tx) => tx.insert(memberships).values({ organizationId: orgId, userId: u.id, role }));
  return (await createSession(u.id)).token;
}

beforeAll(async () => {
  A = await newOrg("w2d-sp-a");
  B = await newOrg("w2d-sp-b");
  nameA = `Zephyr Moderation ${uid()}`;
  nameB = `Zephyr Rival ${uid()}`;
  productA = (await seedCompleteProduct(A.org.id, { name: nameA, onboarded: true })).product.id;
  await seedCompleteProduct(A.org.id, { name: `Second Live ${uid()}`, onboarded: true });
  productB = (await seedCompleteProduct(B.org.id, { name: nameB, onboarded: true })).product.id;
}, 120_000);
afterAll(closeDb);

const search = async (q: string, token: string | null) => {
  session = token;
  const res = await searchGET(new Request(`http://localhost/api/search?q=${encodeURIComponent(q)}`));
  session = null;
  return res;
};

describe("GET /api/search", () => {
  it("requires a signed-in member", async () => {
    expect((await search("zephyr", null)).status).toBe(401);
  });

  it("every role can search (read), results stay in the member's organisation", async () => {
    for (const role of ROLES) {
      const res = await search("zephyr", await tokenFor(A.org.id, role));
      expect(res.status).toBe(200);
      const { results } = (await res.json()) as { results: { kind: string; label: string; href: string }[] };
      expect(results.some((r) => r.kind === "product" && r.label === nameA)).toBe(true);
      expect(results.some((r) => r.label === nameB)).toBe(false);
    }
  });

  it("ranks, caps and escapes the query", async () => {
    await withOrg(A.org.id, (tx) => tx.insert(contentAssets).values(Array.from({ length: 12 }, (_, i) => ({ organizationId: A.org.id, productId: productA, type: "ARTICLE" as const, title: `Zephyr guide ${i}` }))));
    const hits = await withOrg(A.org.id, (tx) => searchWorkspace(tx, A.org.id, "zephyr"));
    expect(hits.filter((h) => h.kind === "content").length).toBeLessThanOrEqual(5);
    expect(hits.length).toBeLessThanOrEqual(25);
    expect(await withOrg(A.org.id, (tx) => searchWorkspace(tx, A.org.id, "%%"))).toEqual([]);
    expect(await withOrg(B.org.id, (tx) => searchWorkspace(tx, B.org.id, "guide"))).toEqual([]);
  });

  it("returns the palette context (crawlable products, permissions) for the caller's role", async () => {
    session = await tokenFor(A.org.id, "VIEWER");
    const res = await searchGET(new Request("http://localhost/api/search?context=1"));
    session = null;
    const body = (await res.json()) as { products: { name: string; crawlable: boolean }[]; can: Record<string, boolean> };
    expect(body.products.map((p) => p.name)).toContain(nameA);
    expect(body.products.every((p) => p.crawlable === false)).toBe(true);
    expect(body.can).toEqual({ productWrite: false, jobRun: false, contentWrite: false });
  });
});

describe("publicGraphs batch loading", () => {
  it("equals the per-product loader result", async () => {
    const prods = await withOrg(A.org.id, (tx) => tx.select().from(products).where(eq(products.organizationId, A.org.id)).orderBy(asc(products.name)));
    const expected = [];
    for (const p of prods) expected.push(verifiedOnly((await withOrg(A.org.id, (tx) => loadProductGraph(tx, A.org.id, p.id)))!));
    const batched = await withOrg(A.org.id, (tx) => publicGraphs(tx, A.org.id));
    const norm = (gs: typeof batched) =>
      gs.map((g) => ({ ...g, proofs: [...g.proofs].sort((a, b) => a.id.localeCompare(b.id)), sources: [...g.sources].sort((a, b) => a.id.localeCompare(b.id)), competitors: [...g.competitors].sort((a, b) => a.competitorId.localeCompare(b.competitorId)) }));
    expect(batched).toHaveLength(2);
    expect(norm(batched)).toEqual(norm(expected));
  });
});

describe("cursor pagination", () => {
  it("visits every row exactly once, with timestamp ties", async () => {
    const org = (await newOrg("w2d-page")).org.id;
    const stamps = [new Date("2026-01-01T00:00:00.123456Z"), new Date("2026-01-02T00:00:00Z"), new Date("2026-01-03T00:00:00Z")];
    await withOrg(org, (tx) => tx.insert(contentAssets).values(Array.from({ length: 123 }, (_, i) => ({ organizationId: org, type: "ARTICLE" as const, title: `Asset ${i}` }))));
    // Microsecond timestamps and ties: what a JS Date cannot hold must not skip rows.
    await withOrg(org, (tx) => tx.execute(sql`update content_assets set updated_at = (array[${stamps[0].toISOString()}::timestamptz + interval '7 microseconds', ${stamps[1].toISOString()}::timestamptz, ${stamps[2].toISOString()}::timestamptz])[1 + (abs(hashtext(id::text)) % 3)] where organization_id = ${org}`));
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const c = decodeCursor(cursor);
      const rows = await withOrg(org, (tx) =>
        tx
          .select()
          .from(contentAssets)
          .where(and(eq(contentAssets.organizationId, org), afterCursor(contentAssets.updatedAt, contentAssets.id, c, "desc", "timestamp")))
          .orderBy(desc(msKey(contentAssets.updatedAt)), desc(contentAssets.id))
          .limit(PAGE_SIZE + 1),
      );
      const page = pageOf(rows, PAGE_SIZE, (r) => tsCursor(r.updatedAt, r.id));
      seen.push(...page.items.map((r) => r.id));
      cursor = page.next;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(123);
    expect(new Set(seen).size).toBe(123);
  });
});

describe("dailySeries as one grouped query", () => {
  it("matches the per-day subquery result", async () => {
    const org = (await newOrg("w2d-series")).org.id;
    const productId = (await seedCompleteProduct(org, { name: `Series ${uid()}` })).product.id;
    const day = (n: number) => new Date(Date.now() - n * 86_400_000);
    await withOrg(org, (tx) =>
      tx.insert(conversionEvents).values([
        { organizationId: org, productId, type: "PAGE_VIEW", visitorId: "v1", occurredAt: day(0) },
        { organizationId: org, productId, type: "PAGE_VIEW", visitorId: "v1", occurredAt: day(0) },
        { organizationId: org, productId, type: "PAGE_VIEW", visitorId: "v2", channel: "AI_REFERRAL", occurredAt: day(1) },
        { organizationId: org, productId, type: "SIGNUP_COMPLETED", visitorId: "v2", occurredAt: day(1) },
        { organizationId: org, productId, type: "SUBSCRIPTION_STARTED", visitorId: "v2", occurredAt: day(3) },
        { organizationId: org, productId, type: "PAGE_VIEW", visitorId: "v9", occurredAt: day(40) },
      ]),
    );
    const got = await withOrg(org, (tx) => dailySeries(tx, org, 7));
    const old = await withOrg(org, (tx) =>
      tx.execute<{ day: string; visitors: number; signups: number; subs: number; ai: number }>(sql`
        select to_char(d, 'YYYY-MM-DD') as day,
          (select count(distinct visitor_id) from conversion_events where organization_id = ${org} and type = 'PAGE_VIEW' and occurred_at >= d and occurred_at < d + interval '1 day')::int as visitors,
          (select count(*) from conversion_events where organization_id = ${org} and type::text in ('SIGNUP_COMPLETED', 'SIGNUP') and occurred_at >= d and occurred_at < d + interval '1 day')::int as signups,
          (select count(*) from conversion_events where organization_id = ${org} and type::text in ('SUBSCRIPTION_STARTED', 'SUBSCRIBED') and occurred_at >= d and occurred_at < d + interval '1 day')::int as subs,
          (select count(distinct visitor_id) from conversion_events where organization_id = ${org} and type = 'PAGE_VIEW' and channel = 'AI_REFERRAL' and occurred_at >= d and occurred_at < d + interval '1 day')::int as ai
        from generate_series(current_date - 6, current_date, interval '1 day') d`),
    );
    expect(got).toEqual(old.rows.map((x) => ({ day: x.day, visitors: Number(x.visitors), signups: Number(x.signups), subs: Number(x.subs), ai: Number(x.ai) })));
    expect(got).toHaveLength(7);
    expect(got.reduce((s, d) => s + d.visitors + d.signups + d.subs, 0)).toBe(4);
  });
});

describe("media: re-encode before the transaction", () => {
  it("prepareImage needs no transaction; insertImage checks the product's organisation", async () => {
    const png = await sharp({ create: { width: 64, height: 32, channels: 3, background: "#456" } }).png().toBuffer();
    expect(prepareImage.length).toBe(1);
    const img = await prepareImage({ data: png, filename: "logo.png", productId: productB, visibility: "PUBLIC" });
    expect(img).toMatchObject({ width: 64, height: 32, filename: "logo.webp" });
    expect(img.bytes.subarray(8, 12).toString()).toBe("WEBP");
    await expect(withOrg(A.org.id, (tx) => insertImage(tx, A.actor, img))).rejects.toThrow("Product not found");
    const ok = await withOrg(A.org.id, (tx) => insertImage(tx, A.actor, { ...img, productId: productA }));
    expect((await withOrg(A.org.id, (tx) => tx.query.media.findFirst({ where: eq(media.id, ok.id) })))!.productId).toBe(productA);
  });

  it("the agent upload route stores a private, re-encoded photo", async () => {
    session = await tokenFor(A.org.id, "VIEWER");
    const jpeg = await sharp({ create: { width: 40, height: 40, channels: 3, background: "#abc" } }).jpeg().toBuffer();
    const fd = new FormData();
    fd.set("file", new File([new Uint8Array(jpeg)], "chat.jpg", { type: "image/jpeg" }));
    const res = await agentUploadPOST(new Request("http://localhost/api/agent/upload", { method: "POST", body: fd, headers: { origin: new URL(env().BEACON_BASE_URL).origin } }));
    session = null;
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };
    const row = await withOrg(A.org.id, (tx) => tx.query.media.findFirst({ where: eq(media.id, id) }));
    expect(row).toMatchObject({ visibility: "PRIVATE", mime: "image/webp" });
  });
});
