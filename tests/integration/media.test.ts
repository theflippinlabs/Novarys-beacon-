import { deflateSync } from "node:zlib";
import sharp from "sharp";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { asSystem, closeDb, db, withOrg } from "@/db";
import { auditLogs, contentAssets, media, organizations, products } from "@/db/schema";
import { createSession } from "@/lib/auth/service";
import type { Actor } from "@/lib/audit";
import { deleteMedia, insertImage, loadMedia, prepareImage, MAX_UPLOAD_BYTES, MEDIA_ERRORS, mediaUrl, setOrgLogo, setProductLogo } from "@/services/media";
import { GET as mediaGET } from "@/app/api/media/[id]/route";
import { newOrg, params, uid } from "./helpers";

let a: { org: { id: string }; user: { id: string }; actor: Actor };
let b: { org: { id: string }; user: { id: string }; actor: Actor };
let productA: string;
let productB: string;
let assetA: string;

/** A 300×100 JPEG with camera EXIF, GPS and "rotate 90°" orientation, like a phone photo. */
const phonePhoto = () =>
  sharp({ create: { width: 300, height: 100, channels: 3, background: "#204080" } })
    .withExif({ IFD0: { Make: "Apple", Model: "iPhone 16", Copyright: "secret-owner" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "48/1 51/1 2400/100" } })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf: Buffer) => {
  let c = 0xffffffff;
  for (const x of buf) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
/** A tiny, valid-looking PNG whose header claims 20000×20000 pixels (a decompression bomb). */
const bombPng = () => {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(20000, 0);
  ihdr.writeUInt32BE(20000, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // greyscale
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.alloc(20001))), chunk("IEND", Buffer.alloc(0))]);
};

beforeAll(async () => {
  a = await newOrg("media-a");
  b = await newOrg("media-b");
  productA = (await withOrg(a.org.id, (tx) => tx.insert(products).values({ organizationId: a.org.id, slug: `pa-${uid()}`, name: "Photo A" }).returning()))[0].id;
  productB = (await withOrg(b.org.id, (tx) => tx.insert(products).values({ organizationId: b.org.id, slug: `pb-${uid()}`, name: "Photo B" }).returning()))[0].id;
  assetA = (await withOrg(a.org.id, (tx) => tx.insert(contentAssets).values({ organizationId: a.org.id, productId: productA, type: "ARTICLE", title: "With images" }).returning()))[0].id;
});
afterAll(closeDb);

/** Upload path: re-encode with no transaction open, then store inside the tenant transaction. */
const ingest = async (actor: Actor, input: Parameters<typeof prepareImage>[0]) => {
  const img = await prepareImage(input);
  return withOrg(actor.organizationId, (tx) => insertImage(tx, actor, img));
};
const rejects = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("Expected rejection");
};

describe("prepareImage + insertImage", () => {
  it("auto-orients, downsizes, re-encodes to WebP and strips EXIF/GPS", async () => {
    const big = await sharp({ create: { width: 4000, height: 1000, channels: 4, background: { r: 10, g: 200, b: 30, alpha: 0.5 } } }).png().toBuffer();
    const r = await ingest(a.actor, { data: big, filename: "wide banner.png", productId: productA, alt: " Banner " });
    expect(r).toMatchObject({ url: `/api/media/${r.id}`, width: 2048, height: 512 });

    const photo = await ingest(a.actor, { data: await phonePhoto(), filename: "IMG_0042.JPG", productId: productA });
    expect([photo.width, photo.height]).toEqual([100, 300]); // orientation 6 applied
    const row = (await withOrg(a.org.id, (tx) => loadMedia(tx, a.org.id, photo.id)))!;
    expect(row).toMatchObject({ mime: "image/webp", filename: "IMG_0042.webp", visibility: "PUBLIC", productId: productA, createdBy: a.user.id, sizeBytes: photo.sizeBytes });
    expect(row.bytes.length).toBe(photo.sizeBytes);
    const meta = await sharp(row.bytes).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
    expect(meta.xmp).toBeUndefined();
    expect(meta.icc).toBeUndefined();
    expect(meta.orientation ?? 1).toBe(1);
    expect(row.bytes.includes("secret-owner")).toBe(false);
    expect(row.bytes.includes("iPhone")).toBe(false);

    const logged = await withOrg(a.org.id, (tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.action, "media.upload"), eq(auditLogs.entityId, photo.id))));
    expect(logged).toHaveLength(1);
  });

  it("does not enlarge small images", async () => {
    const small = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#fff" } }).gif().toBuffer();
    const r = await ingest(a.actor, { data: small, filename: "tiny.gif" });
    expect([r.width, r.height]).toEqual([40, 30]);
  });

  it("rejects SVG, non-images, empty and oversized files", async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    expect(await rejects(ingest(a.actor, { data: svg, filename: "x.svg" }))).toBe(MEDIA_ERRORS.unsupported);
    expect(await rejects(ingest(a.actor, { data: Buffer.from("%PDF-1.7 hello world"), filename: "x.pdf" }))).toBe(MEDIA_ERRORS.unsupported);
    expect(await rejects(ingest(a.actor, { data: Buffer.alloc(0), filename: "x.png" }))).toBe(MEDIA_ERRORS.empty);
    expect(await rejects(ingest(a.actor, { data: Buffer.alloc(MAX_UPLOAD_BYTES + 1), filename: "x.jpg" }))).toBe(MEDIA_ERRORS.tooLarge);
    // Correct magic bytes, garbage body.
    expect(await rejects(ingest(a.actor, { data: Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]), filename: "x.jpg" }))).toBe(MEDIA_ERRORS.unreadable);
  });

  it("guards against decompression bombs", async () => {
    expect(await rejects(ingest(a.actor, { data: bombPng(), filename: "bomb.png" }))).toMatch(/dimensions are too large|could not be read/);
  });

  it("refuses products and content assets of another organisation", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#000" } }).png().toBuffer();
    expect(await rejects(ingest(a.actor, { data: png, filename: "x.png", productId: productB }))).toBe("Product not found");
    expect(await rejects(ingest(b.actor, { data: png, filename: "x.png", contentAssetId: assetA }))).toBe("Content asset not found");
    expect(await rejects(ingest(a.actor, { data: png, filename: "x.png", productId: "not-a-uuid" }))).toBe("Product not found");
    const ok = await ingest(a.actor, { data: png, filename: "x.png", contentAssetId: assetA });
    expect(ok.id).toBeTruthy();
  });

  it("isolates media rows per organisation (RLS)", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#123" } }).png().toBuffer();
    const r = await ingest(a.actor, { data: png, filename: "secret.png" });
    expect(await withOrg(b.org.id, (tx) => loadMedia(tx, b.org.id, r.id))).toBeNull();
    expect(await withOrg(b.org.id, (tx) => loadMedia(tx, a.org.id, r.id))).toBeNull();
    expect(await withOrg(b.org.id, (tx) => tx.select({ id: media.id }).from(media).where(eq(media.id, r.id)))).toEqual([]);
    expect(await db().select({ id: media.id }).from(media).where(eq(media.id, r.id))).toEqual([]);
    expect(await withOrg(a.org.id, (tx) => loadMedia(tx, a.org.id, r.id))).not.toBeNull();
    // Another tenant cannot delete or use it.
    expect(await rejects(withOrg(b.org.id, (tx) => deleteMedia(tx, b.actor, r.id)))).toBe(MEDIA_ERRORS.notFound);
    expect(await rejects(withOrg(b.org.id, (tx) => setProductLogo(tx, b.actor, productB, r.id)))).toBe(MEDIA_ERRORS.notFound);
  });
});

describe("logos and deletion", () => {
  it("sets the product and organisation logo to the absolute URL, and deleting clears them", async () => {
    const png = await sharp({ create: { width: 64, height: 64, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).png().toBuffer();
    const r = await ingest(a.actor, { data: png, filename: "logo.png" });
    const { logoUrl } = await withOrg(a.org.id, (tx) => setProductLogo(tx, a.actor, productA, r.id));
    expect(logoUrl).toBe(mediaUrl(r.id, true));
    expect(logoUrl).toMatch(/^https?:\/\/.+\/api\/media\/[0-9a-f-]{36}$/);
    await withOrg(a.org.id, (tx) => setOrgLogo(tx, a.actor, r.id));
    const before = await withOrg(a.org.id, async (tx) => ({ p: await tx.query.products.findFirst({ where: eq(products.id, productA) }), o: await tx.query.organizations.findFirst({ where: eq(organizations.id, a.org.id) }) }));
    expect(before.p?.logoUrl).toBe(logoUrl);
    expect(before.o?.branding.logoUrl).toBe(logoUrl);
    expect((await withOrg(a.org.id, (tx) => loadMedia(tx, a.org.id, r.id)))?.productId).toBe(productA);

    await withOrg(a.org.id, (tx) => deleteMedia(tx, a.actor, r.id));
    const after = await withOrg(a.org.id, async (tx) => ({ p: await tx.query.products.findFirst({ where: eq(products.id, productA) }), o: await tx.query.organizations.findFirst({ where: eq(organizations.id, a.org.id) }), m: await loadMedia(tx, a.org.id, r.id) }));
    expect(after.p?.logoUrl).toBeNull();
    expect(after.o?.branding.logoUrl).toBeUndefined();
    expect(after.m).toBeNull();
  });

  it("refuses private images as logos", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#456" } }).png().toBuffer();
    const r = await ingest(a.actor, { data: png, filename: "p.png", visibility: "PRIVATE" });
    expect(await rejects(withOrg(a.org.id, (tx) => setProductLogo(tx, a.actor, productA, r.id)))).toBe(MEDIA_ERRORS.notPublic);
  });
});

describe("GET /api/media/[id]", () => {
  const get = (id: string, headers: Record<string, string> = {}) => mediaGET(new Request(`http://localhost/api/media/${id}`, { headers }), params({ id }));

  it("serves public media to anyone with strict headers and an ETag", async () => {
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#789" } }).png().toBuffer();
    const r = await ingest(a.actor, { data: png, filename: "pub.png" });
    const res = await get(r.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
    const etag = res.headers.get("etag")!;
    expect(etag).toBe(`"${r.id}"`);
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length).toBe(r.sizeBytes);
    expect((await sharp(body).metadata()).format).toBe("webp");
    expect((await get(r.id, { "if-none-match": etag })).status).toBe(304);
  });

  it("serves private media only to members of the owning organisation", async () => {
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#abc" } }).png().toBuffer();
    const r = await ingest(a.actor, { data: png, filename: "priv.png", visibility: "PRIVATE" });
    expect((await get(r.id)).status).toBe(404);
    const { token: tokenA } = await createSession(a.user.id);
    const { token: tokenB } = await createSession(b.user.id);
    expect((await get(r.id, { cookie: "beacon_session=garbage-token-value-xxxxxxxx" })).status).toBe(404);
    expect((await get(r.id, { cookie: `other=1; beacon_session=${tokenB}` })).status).toBe(404);
    const ok = await get(r.id, { cookie: `other=1; beacon_session=${tokenA}` });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("private, max-age=3600");
  });

  it("returns 404 for malformed and unknown ids", async () => {
    expect((await get("not-a-uuid")).status).toBe(404);
    expect((await get("../../etc/passwd")).status).toBe(404);
    expect((await get("00000000-0000-4000-8000-000000000000")).status).toBe(404);
  });

  it("finds media regardless of tenant context (system lookup by id)", async () => {
    const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "#def" } }).png().toBuffer();
    const r = await ingest(b.actor, { data: png, filename: "b.png" });
    expect(await asSystem((tx) => tx.select({ id: media.id }).from(media).where(eq(media.id, r.id)))).toHaveLength(1);
    expect((await get(r.id)).status).toBe(200);
  });
});
