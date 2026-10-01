/**
 * S3-compatible object storage adapter (Railway Buckets in production; any
 * S3 API works). Used for uploaded media bytes. Never logs or returns the
 * credentials: errors carry the operation, the key and the provider's error
 * name or HTTP status only.
 *
 * Every call is network I/O: callers run it with no database transaction open.
 */
import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client, S3ServiceException } from "@aws-sdk/client-s3";
import type { MediaStorageConfig } from "@/lib/env";

/** Wall-clock deadline of one storage call (including SDK retries). */
export const STORAGE_TIMEOUT_MS = 20_000;
const CONNECT_TIMEOUT_MS = 5_000;
const SOCKET_TIMEOUT_MS = 15_000;

export type StoredObject = { key: string; lastModified: Date | null; size: number };

export interface ObjectStorage {
  readonly bucket: string;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** The object's bytes, or null when it does not exist. Refuses objects above `maxBytes`. */
  get(key: string, maxBytes: number): Promise<Buffer | null>;
  /** Idempotent: deleting a missing object succeeds. */
  delete(key: string): Promise<void>;
  /** One page (up to 1000 keys) of objects under `prefix`, in key order. */
  list(prefix: string, continuationToken?: string): Promise<{ objects: StoredObject[]; next: string | null }>;
}

export class ObjectStorageError extends Error {
  constructor(
    readonly operation: string,
    readonly key: string,
    readonly detail: string,
  ) {
    super(`Object storage ${operation} failed for ${key}: ${detail}`);
    this.name = "ObjectStorageError";
  }
}

function describe(e: unknown): string {
  if (e instanceof S3ServiceException) return `${e.name}${e.$metadata?.httpStatusCode ? ` (HTTP ${e.$metadata.httpStatusCode})` : ""}`;
  if (e instanceof Error) return e.name === "AbortError" || e.name === "TimeoutError" ? "timed out" : e.name;
  return "unknown error";
}

const isNotFound = (e: unknown) => e instanceof S3ServiceException && (e.name === "NoSuchKey" || e.name === "NotFound" || e.$metadata?.httpStatusCode === 404);

async function readCapped(body: AsyncIterable<Uint8Array>, maxBytes: number, key: string): Promise<Buffer> {
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > maxBytes) throw new ObjectStorageError("get", key, `object larger than ${maxBytes} bytes`);
    parts.push(Buffer.from(chunk));
  }
  return Buffer.concat(parts, size);
}

export function createObjectStorage(cfg: MediaStorageConfig, opts: { timeoutMs?: number } = {}): ObjectStorage {
  const timeoutMs = opts.timeoutMs ?? STORAGE_TIMEOUT_MS;
  const client = new S3Client({
    endpoint: cfg.endpoint,
    region: cfg.region,
    forcePathStyle: cfg.forcePathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    maxAttempts: 3,
    // S3-compatible providers differ in their support of the newer default checksums: only send them when required.
    requestChecksumCalculation: "WHEN_REQUIRED",
    responseChecksumValidation: "WHEN_REQUIRED",
    requestHandler: { connectionTimeout: CONNECT_TIMEOUT_MS, requestTimeout: SOCKET_TIMEOUT_MS },
  });
  const signal = () => AbortSignal.timeout(timeoutMs);

  return {
    bucket: cfg.bucket,
    async put(key, body, contentType) {
      try {
        await client.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, Body: body, ContentType: contentType, ContentLength: body.length }), { abortSignal: signal() });
      } catch (e) {
        throw new ObjectStorageError("put", key, describe(e));
      }
    },
    async get(key, maxBytes) {
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: cfg.bucket, Key: key }), { abortSignal: signal() });
        if (!res.Body) return Buffer.alloc(0);
        if (typeof res.ContentLength === "number" && res.ContentLength > maxBytes) {
          (res.Body as { destroy?: () => void }).destroy?.();
          throw new ObjectStorageError("get", key, `object larger than ${maxBytes} bytes`);
        }
        return await readCapped(res.Body as AsyncIterable<Uint8Array>, maxBytes, key);
      } catch (e) {
        if (e instanceof ObjectStorageError) throw e;
        if (isNotFound(e)) return null;
        throw new ObjectStorageError("get", key, describe(e));
      }
    },
    async delete(key) {
      try {
        await client.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: key }), { abortSignal: signal() });
      } catch (e) {
        if (isNotFound(e)) return;
        throw new ObjectStorageError("delete", key, describe(e));
      }
    },
    async list(prefix, continuationToken) {
      try {
        const res = await client.send(new ListObjectsV2Command({ Bucket: cfg.bucket, Prefix: prefix, ContinuationToken: continuationToken, MaxKeys: 1000 }), { abortSignal: signal() });
        return {
          objects: (res.Contents ?? []).filter((o) => o.Key).map((o) => ({ key: o.Key!, lastModified: o.LastModified ?? null, size: o.Size ?? 0 })),
          next: res.IsTruncated && res.NextContinuationToken ? res.NextContinuationToken : null,
        };
      } catch (e) {
        throw new ObjectStorageError("list", prefix, describe(e));
      }
    },
  };
}
