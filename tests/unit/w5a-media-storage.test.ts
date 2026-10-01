import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mediaStorageSettings, parseEnv } from "@/lib/env";
import { MEDIA_STORAGE_PREFIX, mediaStorageKey, parseMediaStorageKey } from "@/core/media/image";

const key = () => randomBytes(32).toString("base64");
const prod = {
  NODE_ENV: "production",
  DATABASE_URL: "postgres://beacon_app:pw@db:5432/beacon",
  BEACON_BASE_URL: "https://beacon.example",
  BEACON_ENCRYPTION_KEY: key(),
  BEACON_HASH_SECRET: key(),
  BEACON_DB_SYSTEM_PASSWORD: "x".repeat(30),
};
const s3 = {
  BEACON_MEDIA_S3_ENDPOINT: "https://t3.storageapi.dev",
  BEACON_MEDIA_S3_BUCKET: "beacon-media-abc123",
  BEACON_MEDIA_S3_ACCESS_KEY_ID: "tid_access",
  BEACON_MEDIA_S3_SECRET_ACCESS_KEY: "tsec_super_secret_value",
};

describe("media object storage configuration", () => {
  it("is off (PostgreSQL fallback) when no variable is set", () => {
    const e = parseEnv({ NODE_ENV: "development" });
    expect(mediaStorageSettings(e)).toEqual({ config: null, problems: [] });
    expect(parseEnv(prod).BEACON_MEDIA_S3_REGION).toBe("auto");
  });

  it("builds the client settings with Railway defaults (region auto, virtual-hosted style)", () => {
    const { config, problems } = mediaStorageSettings(parseEnv({ ...prod, ...s3 }));
    expect(problems).toEqual([]);
    expect(config).toEqual({ endpoint: s3.BEACON_MEDIA_S3_ENDPOINT, bucket: s3.BEACON_MEDIA_S3_BUCKET, region: "auto", accessKeyId: "tid_access", secretAccessKey: "tsec_super_secret_value", forcePathStyle: false });
    const custom = mediaStorageSettings(parseEnv({ ...prod, ...s3, BEACON_MEDIA_S3_REGION: "eu-west-3", BEACON_MEDIA_S3_FORCE_PATH_STYLE: "true" })).config;
    expect(custom).toMatchObject({ region: "eu-west-3", forcePathStyle: true });
  });

  it("refuses a partial configuration at production startup, naming what is missing (never a secret)", () => {
    const partial = { ...prod, BEACON_MEDIA_S3_ENDPOINT: s3.BEACON_MEDIA_S3_ENDPOINT, BEACON_MEDIA_S3_SECRET_ACCESS_KEY: s3.BEACON_MEDIA_S3_SECRET_ACCESS_KEY };
    let message = "";
    try {
      parseEnv(partial);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/media object storage is partially configured: set BEACON_MEDIA_S3_BUCKET, BEACON_MEDIA_S3_ACCESS_KEY_ID/);
    expect(message).not.toContain("tsec_super_secret_value");
    for (const missing of Object.keys(s3)) {
      const env = { ...prod, ...s3 } as Record<string, string>;
      delete env[missing];
      expect(() => parseEnv(env)).toThrow(new RegExp(missing));
    }
  });

  it("outside production, a partial configuration does not stop the app and stays off", () => {
    const e = parseEnv({ NODE_ENV: "development", BEACON_MEDIA_S3_BUCKET: "beacon-media" });
    const res = mediaStorageSettings(e);
    expect(res.config).toBeNull();
    expect(res.problems[0]).toMatch(/partially configured/);
  });

  it("requires an https endpoint in production and a valid bucket name", () => {
    expect(() => parseEnv({ ...prod, ...s3, BEACON_MEDIA_S3_ENDPOINT: "http://storage.example" })).toThrow(/BEACON_MEDIA_S3_ENDPOINT must be an https/);
    expect(() => parseEnv({ ...prod, ...s3, BEACON_MEDIA_S3_ENDPOINT: "not a url" })).toThrow();
    expect(() => parseEnv({ ...prod, ...s3, BEACON_MEDIA_S3_BUCKET: "Bad_Bucket!" })).toThrow(/bucket name/);
    expect(() => parseEnv({ ...prod, ...s3, BEACON_MEDIA_S3_FORCE_PATH_STYLE: "yes" })).toThrow();
    // A local fake (tests, docker-compose MinIO) may use plain http outside production.
    expect(mediaStorageSettings(parseEnv({ NODE_ENV: "test", ...s3, BEACON_MEDIA_S3_ENDPOINT: "http://127.0.0.1:9000" })).config?.endpoint).toBe("http://127.0.0.1:9000");
  });
});

describe("media storage keys", () => {
  it("are tenant-scoped, lowercased and reversible", () => {
    const org = randomUUID().toUpperCase();
    const id = randomUUID();
    const k = mediaStorageKey(org, id);
    expect(k).toBe(`${MEDIA_STORAGE_PREFIX}${org.toLowerCase()}/${id}.webp`);
    expect(parseMediaStorageKey(k)).toEqual({ organizationId: org.toLowerCase(), mediaId: id });
  });

  it("refuse anything that is not a pair of UUIDs", () => {
    expect(() => mediaStorageKey("../other", randomUUID())).toThrow();
    expect(() => mediaStorageKey(randomUUID(), "x/../../y")).toThrow();
    for (const bad of ["media/x/y.webp", `media/${randomUUID()}/${randomUUID()}.png`, `other/${randomUUID()}/${randomUUID()}.webp`, `media/${randomUUID()}/${randomUUID()}.webp/extra`, ""]) expect(parseMediaStorageKey(bad)).toBeNull();
  });
});
