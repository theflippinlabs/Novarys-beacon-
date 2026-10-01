import sharp from "sharp";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { asSystem, closeDb, withOrg } from "@/db";
import { media, memberships, products, users } from "@/db/schema";
import { createSession } from "@/lib/auth/service";
import { hashPassword } from "@/lib/security/crypto";
import type { Actor } from "@/lib/audit";
import { resetEnvCache } from "@/lib/env";
import { mediaStorageKey } from "@/core/media/image";
import { deleteMedia, insertImage, loadMedia, MEDIA_ERRORS, prepareImage, stageImages, type MediaInput } from "@/services/media";
import { discardMediaObjects, migrateMediaToStorage, readMediaBytes, setMediaStorageForTests, sweepOrphanMediaObjects } from "@/services/media-storage";
import { GET as mediaGET } from "@/app/api/media/[id]/route";
import { startFakeS3, type FakeS3 } from "../support/fake-s3";
import { newOrg, params, pgError, uid } from "./helpers";

let s3: FakeS3;
const clearFailures = () => {
  for (const k of Object.keys(s3.failing)) delete s3.failing[k as keyof FakeS3["failing"]];
};
let A: Awaited<ReturnType<typeof newOrg>>;
let B: Awaited<ReturnType<typeof newOrg>>;
let productA: string;
let productB: string;

const ENV_KEYS = ["BEACON_MEDIA_S3_ENDPOINT", "BEACON_MEDIA_S3_BUCKET", "BEACON_MEDIA_S3_REGION", "BEACON_MEDIA_S3_ACCESS_KEY_ID", "BEACON_MEDIA_S3_SECRET_ACCESS_KEY", "BEACON_MEDIA_S3_FORCE_PATH_STYLE"] as const;

const png = (color = "#336699") => sharp({ create: { width: 40, height: 20, channels: 3, background: color } }).png().toBuffer();

/** The production upload path: re-encode, upload (no transaction open), then record in the tenant transaction. */
const upload = async (actor: Actor, input: Omit<MediaInput, "data"> & { data?: Buffer }) => {
  const img = await prepareImage({ ...input, data: input.data ?? (await png()) });
  return stageImages(actor.organizationId, [img], ([staged]) => withOrg(actor.organizationId, (tx) => insertImage(tx, actor, staged)));
};
const row = (id: string) => asSystem(async (tx) => (await tx.select().from(media).where(eq(media.id, id)).limit(1))[0]);
const get = (id: string, cookie?: string) => mediaGET(new Request(`http://localhost/api/media/${id}`, { headers: cookie ? { cookie } : {} }), params({ id }));

beforeAll(async () => {
  s3 = await startFakeS3();
  // Configured through the environment exactly as in production (path-style for the local fake).
  Object.assign(process.env, {
    BEACON_MEDIA_S3_ENDPOINT: s3.endpoint,
    BEACON_MEDIA_S3_BUCKET: s3.bucket,
    BEACON_MEDIA_S3_REGION: "auto",
    BEACON_MEDIA_S3_ACCESS_KEY_ID: s3.accessKeyId,
    BEACON_MEDIA_S3_SECRET_ACCESS_KEY: "fake-secret-not-logged",
    BEACON_MEDIA_S3_FORCE_PATH_STYLE: "true",
  });
  resetEnvCache();
  A = await newOrg("w5a-a");
  B = await newOrg("w5a-b");
  productA = (await withOrg(A.org.id, (tx) => tx.insert(products).values({ organizationId: A.org.id, slug: `w5a-${uid()}`, name: "Stored A" }).returning()))[0].id;
  productB = (await withOrg(B.org.id, (tx) => tx.insert(products).values({ organizationId: B.org.id, slug: `w5b-${uid()}`, name: "Stored B" }).returning()))[0].id;
});
afterEach(() => {
  setMediaStorageForTests(undefined);
  clearFailures();
});
afterAll(async () => {
  for (const k of ENV_KEYS) delete process.env[k];
  resetEnvCache();
  await s3.close();
  await closeDb();
});

describe("upload with object storage configured", () => {
  it("stores the WebP in the bucket under the tenant key and keeps no bytes in PostgreSQL", async () => {
    const r = await upload(A.actor, { filename: "shot.png", productId: productA, visibility: "PUBLIC" });
    const m = await row(r.id);
    expect(m.storageKey).toBe(mediaStorageKey(A.org.id, r.id));
    expect(m.storageKey).toBe(`media/${A.org.id}/${r.id}.webp`);
    expect(m.bytes).toBeNull();
    const obj = s3.objects.get(m.storageKey!)!;
    expect(obj.contentType).toBe("image/webp");
    expect(obj.body.length).toBe(m.sizeBytes);
    expect((await sharp(obj.body).metadata()).format).toBe("webp");
    expect((await readMediaBytes(m))!.equals(obj.body)).toBe(true);
  });

  it("serves stored images through /api/media/[id] with the same headers", async () => {
    const r = await upload(A.actor, { filename: "pub.png", visibility: "PUBLIC" });
    const res = await get(r.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(s3.objects.get(mediaStorageKey(A.org.id, r.id))!.body)).toBe(true);
    expect(res.headers.get("content-length")).toBe(String(body.length));
    // Conditional request: answered from the row, storage not read.
    const before = s3.requests.length;
    const cached = await mediaGET(new Request(`http://localhost/api/media/${r.id}`, { headers: { "if-none-match": `"${r.id}"` } }), params({ id: r.id }));
    expect(cached.status).toBe(304);
    expect(s3.requests.length).toBe(before);
  });

  it("keeps private media rules: only the uploader gets it, storage is not read otherwise", async () => {
    const r = await upload(A.actor, { filename: "chat.png", visibility: "PRIVATE" });
    const [colleague] = await asSystem(async (tx) => tx.insert(users).values({ email: `w5a-${uid()}@example.test`, name: "Colleague", passwordHash: await hashPassword("correct horse battery 42") }).returning());
    await asSystem((tx) => tx.insert(memberships).values({ organizationId: A.org.id, userId: colleague.id, role: "ADMIN" }));
    const before = s3.requests.filter((q) => q.method === "GET").length;
    expect((await get(r.id)).status).toBe(404);
    expect((await get(r.id, `beacon_session=${(await createSession(colleague.id)).token}`)).status).toBe(404);
    expect((await get(r.id, `beacon_session=${(await createSession(B.user.id)).token}`)).status).toBe(404);
    expect(s3.requests.filter((q) => q.method === "GET").length).toBe(before);
    const own = await get(r.id, `beacon_session=${(await createSession(A.user.id)).token}`);
    expect(own.status).toBe(200);
    expect(own.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(own.headers.get("vary")).toBe("Cookie");
  });

  it("answers 503 (not cached) when storage fails and 404 when the object is gone", async () => {
    const r = await upload(A.actor, { filename: "x.png", visibility: "PUBLIC" });
    s3.failing.GET = 500;
    const down = await get(r.id);
    expect(down.status).toBe(503);
    expect(down.headers.get("cache-control")).toBe("no-store");
    clearFailures();
    s3.objects.delete(mediaStorageKey(A.org.id, r.id));
    expect((await get(r.id)).status).toBe(404);
  });

  it("removes the uploaded object when the transaction fails, and fails cleanly when the upload fails", async () => {
    const keysBefore = s3.objects.size;
    const img = await prepareImage({ data: await png(), filename: "other.png", productId: productB, visibility: "PUBLIC" });
    // Organisation A cannot attach an image to organisation B's product: the insert throws after the upload.
    await expect(stageImages(A.org.id, [img], ([s]) => withOrg(A.org.id, (tx) => insertImage(tx, A.actor, s)))).rejects.toThrow("Product not found");
    expect(s3.objects.has(mediaStorageKey(A.org.id, img.id))).toBe(false);
    expect(s3.objects.size).toBe(keysBefore);
    expect(await row(img.id)).toBeUndefined();

    s3.failing.PUT = 500;
    const img2 = await prepareImage({ data: await png(), filename: "down.png", visibility: "PUBLIC" });
    await expect(stageImages(A.org.id, [img2], ([s]) => withOrg(A.org.id, (tx) => insertImage(tx, A.actor, s)))).rejects.toThrow(MEDIA_ERRORS.storageUnavailable);
    expect(await row(img2.id)).toBeUndefined();
  });

  it("never records another organisation's key, and RLS still isolates the rows", async () => {
    const img = await prepareImage({ data: await png(), filename: "spoof.png", visibility: "PUBLIC" });
    const spoofed = { ...img, storageKey: mediaStorageKey(B.org.id, img.id) };
    await expect(withOrg(A.org.id, (tx) => insertImage(tx, A.actor, spoofed))).rejects.toThrow("Invalid media storage key");
    const r = await upload(A.actor, { filename: "iso.png", visibility: "PUBLIC" });
    expect(await withOrg(B.org.id, (tx) => loadMedia(tx, B.org.id, r.id))).toBeNull();
    expect(await withOrg(B.org.id, (tx) => loadMedia(tx, A.org.id, r.id))).toBeNull();
    await expect(withOrg(B.org.id, (tx) => deleteMedia(tx, B.actor, r.id))).rejects.toThrow("Image not found");
    expect(s3.objects.has(mediaStorageKey(A.org.id, r.id))).toBe(true);
  });

  it("enforces exactly one of bytes / storage_key", async () => {
    const base = { organizationId: A.org.id, filename: "c.webp", mime: "image/webp", width: 1, height: 1, sizeBytes: 1 };
    expect((await pgError(withOrg(A.org.id, (tx) => tx.insert(media).values({ ...base, bytes: null, storageKey: null })))).message).toMatch(/media_bytes_or_storage_ck/);
    expect((await pgError(withOrg(A.org.id, (tx) => tx.insert(media).values({ ...base, bytes: Buffer.from("x"), storageKey: "media/x" })))).message).toMatch(/media_bytes_or_storage_ck/);
  });
});

describe("deletion", () => {
  it("deleteMedia returns the key; the object is removed after the transaction commits", async () => {
    const r = await upload(A.actor, { filename: "del.png", productId: productA, visibility: "PUBLIC" });
    const key = mediaStorageKey(A.org.id, r.id);
    const removed = await withOrg(A.org.id, (tx) => deleteMedia(tx, A.actor, r.id));
    expect(removed.storageKey).toBe(key);
    expect(s3.objects.has(key)).toBe(true); // nothing deleted inside the transaction
    expect(await discardMediaObjects([removed.storageKey], "test")).toBe(1);
    expect(s3.objects.has(key)).toBe(false);
    expect(await row(r.id)).toBeUndefined();
    // Best effort: a failing delete is logged, not thrown.
    s3.failing.DELETE = 500;
    expect(await discardMediaObjects(["media/whatever"], "test")).toBe(0);
  });

  it("the daily sweep removes old unreferenced objects only", async () => {
    const kept = await upload(A.actor, { filename: "kept.png", visibility: "PUBLIC" });
    const keptKey = mediaStorageKey(A.org.id, kept.id);
    const orphanOld = mediaStorageKey(A.org.id, crypto.randomUUID());
    const orphanYoung = mediaStorageKey(B.org.id, crypto.randomUUID());
    const foreign = "media/not-a-beacon-key.txt";
    const old = new Date(Date.now() - 2 * 86_400_000);
    for (const k of [orphanOld, foreign]) s3.objects.set(k, { body: Buffer.from("x"), contentType: "image/webp", lastModified: old });
    s3.objects.set(orphanYoung, { body: Buffer.from("y"), contentType: "image/webp", lastModified: new Date() });
    s3.objects.get(keptKey)!.lastModified = old;
    const res = await sweepOrphanMediaObjects();
    expect(res.configured).toBe(true);
    expect(res.deleted).toBeGreaterThanOrEqual(1);
    expect(s3.objects.has(orphanOld)).toBe(false);
    expect(s3.objects.has(keptKey)).toBe(true);
    expect(s3.objects.has(orphanYoung)).toBe(true);
    expect(s3.objects.has(foreign)).toBe(true);
  });
});

describe("PostgreSQL fallback and migration", () => {
  it("keeps the bytes in PostgreSQL when storage is not configured, exactly as before", async () => {
    setMediaStorageForTests(null);
    const puts = s3.requests.filter((q) => q.method === "PUT").length;
    const r = await upload(A.actor, { filename: "db.png", visibility: "PUBLIC" });
    const m = await row(r.id);
    expect(m.storageKey).toBeNull();
    expect(m.bytes!.length).toBe(m.sizeBytes);
    expect(s3.requests.filter((q) => q.method === "PUT").length).toBe(puts);
    const res = await get(r.id);
    expect(res.status).toBe(200);
    expect(Buffer.from(await res.arrayBuffer()).equals(m.bytes!)).toBe(true);
    const removed = await withOrg(A.org.id, (tx) => deleteMedia(tx, A.actor, r.id));
    expect(removed.storageKey).toBeNull();
    expect(await sweepOrphanMediaObjects()).toMatchObject({ configured: false });
  });

  it("migrates bytea rows to storage, idempotently and resumably", async () => {
    setMediaStorageForTests(null);
    const r1 = await upload(A.actor, { filename: "m1.png", visibility: "PUBLIC", data: await png("#aa0000") });
    const r2 = await upload(B.actor, { filename: "m2.png", visibility: "PRIVATE", data: await png("#00aa00") });
    const bytes1 = (await row(r1.id)).bytes!;
    const bytes2 = (await row(r2.id)).bytes!;
    setMediaStorageForTests(undefined);

    // Not configured: nothing moves, the count of rows left is reported.
    setMediaStorageForTests(null);
    expect(await migrateMediaToStorage()).toMatchObject({ configured: false, moved: 0 });
    setMediaStorageForTests(undefined);

    // A run interrupted after one row, then resumed.
    const first = await migrateMediaToStorage({ limit: 1, batchSize: 1 });
    expect(first).toMatchObject({ configured: true, moved: 1, failed: 0 });
    const rest = await migrateMediaToStorage({ batchSize: 2 });
    expect(rest.failed).toBe(0);
    expect(rest.remaining).toBe(0);
    for (const [r, org, bytes] of [[r1, A.org.id, bytes1], [r2, B.org.id, bytes2]] as const) {
      const m = await row(r.id);
      expect(m.bytes).toBeNull();
      expect(m.storageKey).toBe(mediaStorageKey(org, r.id));
      expect(s3.objects.get(m.storageKey!)!.body.equals(bytes)).toBe(true);
    }
    const served = await get(r1.id);
    expect(Buffer.from(await served.arrayBuffer()).equals(bytes1)).toBe(true);
    expect(await migrateMediaToStorage()).toMatchObject({ configured: true, moved: 0, failed: 0, remaining: 0 });
  });

  it("leaves a row in PostgreSQL when its upload fails, and moves it on the next run", async () => {
    setMediaStorageForTests(null);
    const r = await upload(A.actor, { filename: "retry.png", visibility: "PUBLIC" });
    setMediaStorageForTests(undefined);
    s3.failing.PUT = 503;
    const failed = await migrateMediaToStorage();
    expect(failed.failed).toBeGreaterThanOrEqual(1);
    expect((await row(r.id)).bytes).not.toBeNull();
    expect((await get(r.id)).status).toBe(200);
    clearFailures();
    expect(await migrateMediaToStorage()).toMatchObject({ failed: 0, remaining: 0 });
    expect((await row(r.id)).storageKey).toBe(mediaStorageKey(A.org.id, r.id));
  });
});
