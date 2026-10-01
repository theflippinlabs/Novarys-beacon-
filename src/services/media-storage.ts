/**
 * Where uploaded media bytes live: S3-compatible object storage when
 * BEACON_MEDIA_S3_* is configured, otherwise the `media.bytes` column.
 *
 * Every function here that talks to object storage runs with NO database
 * transaction open (network I/O never holds a connection). Cross-tenant work
 * (the orphan sweep and the migration of existing rows) uses the system role.
 *
 * No "server-only" import: the worker and the `media:migrate-to-storage`
 * command run this module under plain Node.
 */
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { asSystem } from "@/db";
import { media } from "@/db/schema";
import { env, mediaStorageSettings } from "@/lib/env";
import { log } from "@/lib/logger";
import { createObjectStorage, type ObjectStorage } from "@/integrations/object-storage";
import { MEDIA_STORAGE_PREFIX, mediaStorageKey, parseMediaStorageKey } from "@/core/media/image";

/** Largest stored object read back (stored images are re-encoded WebP, far below this). */
export const MAX_STORED_BYTES = 15 * 1024 * 1024;
export const MEDIA_MIME = "image/webp";

let cached: { fingerprint: string; storage: ObjectStorage } | null = null;
let override: ObjectStorage | null | undefined;
let warnedPartial = false;

/**
 * The configured media object storage, or null when it is not configured
 * (PostgreSQL fallback). A partial configuration is a startup error in
 * production (see productionEnvProblems); elsewhere it is logged once and
 * treated as not configured.
 */
export function mediaStorage(): ObjectStorage | null {
  if (override !== undefined) return override;
  const { config, problems } = mediaStorageSettings(env());
  if (!config) {
    if (problems.length && !warnedPartial) {
      warnedPartial = true;
      log.warn("media.storage.misconfigured", { problems });
    }
    return null;
  }
  const fingerprint = JSON.stringify(config);
  if (cached?.fingerprint !== fingerprint) cached = { fingerprint, storage: createObjectStorage(config) };
  return cached.storage;
}

/** Tests only: force a storage (or null for the PostgreSQL fallback); `undefined` restores the environment's. */
export function setMediaStorageForTests(s: ObjectStorage | null | undefined) {
  override = s;
}

/** Uploads one image's bytes under its tenant-scoped key; returns the key. Outside any transaction. */
export async function uploadMediaObject(storage: ObjectStorage, organizationId: string, mediaId: string, bytes: Buffer): Promise<string> {
  const key = mediaStorageKey(organizationId, mediaId);
  await storage.put(key, bytes, MEDIA_MIME);
  return key;
}

/**
 * The bytes of a media row: from object storage when it has a storage key,
 * otherwise from the row. Null when the object is missing or storage is not
 * configured any more. Outside any transaction.
 */
export async function readMediaBytes(row: { bytes: Buffer | null; storageKey: string | null }): Promise<Buffer | null> {
  if (!row.storageKey) return row.bytes ?? null;
  const storage = mediaStorage();
  if (!storage) {
    log.error("media.storage.not_configured", { key: row.storageKey });
    return null;
  }
  return storage.get(row.storageKey, MAX_STORED_BYTES);
}

/**
 * Best-effort removal of stored objects after their rows are gone (or after
 * the transaction that would have recorded them failed). Failures are logged;
 * the daily orphan sweep retries them.
 */
export async function discardMediaObjects(keys: readonly (string | null | undefined)[], reason: string): Promise<number> {
  const list = [...new Set(keys.filter((k): k is string => Boolean(k)))];
  if (!list.length) return 0;
  const storage = mediaStorage();
  if (!storage) {
    log.warn("media.storage.discard_skipped", { reason, count: list.length });
    return 0;
  }
  let removed = 0;
  for (const key of list) {
    try {
      await storage.delete(key);
      removed++;
    } catch (e) {
      log.warn("media.storage.discard_failed", { reason, key, err: (e as Error).message });
    }
  }
  return removed;
}

/**
 * Daily maintenance: deletes stored objects that no media row references
 * (a delete whose object removal failed, an upload whose transaction never
 * committed, an organisation deleted with its rows). Objects younger than
 * `minAgeMs` are left alone so an upload in flight (object stored, row not
 * committed yet) is never removed.
 */
export async function sweepOrphanMediaObjects(opts: { minAgeMs?: number; maxObjects?: number; now?: Date } = {}): Promise<{ configured: boolean; scanned: number; deleted: number; failed: number }> {
  const storage = mediaStorage();
  if (!storage) return { configured: false, scanned: 0, deleted: 0, failed: 0 };
  const minAgeMs = opts.minAgeMs ?? 6 * 3600_000;
  const maxObjects = opts.maxObjects ?? 20_000;
  const cutoff = (opts.now ?? new Date()).getTime() - minAgeMs;
  let scanned = 0;
  let deleted = 0;
  let failed = 0;
  let token: string | undefined;
  do {
    const page = await storage.list(MEDIA_STORAGE_PREFIX, token);
    token = page.next ?? undefined;
    scanned += page.objects.length;
    const old = page.objects.filter((o) => o.lastModified && o.lastModified.getTime() < cutoff).map((o) => o.key);
    // Keys Beacon did not build are left alone (never delete what we cannot attribute).
    const ours = old.filter((k) => parseMediaStorageKey(k));
    if (ours.length) {
      const referenced = new Set((await asSystem((tx) => tx.select({ key: media.storageKey }).from(media).where(inArray(media.storageKey, ours)))).map((r) => r.key));
      for (const key of ours) {
        if (referenced.has(key)) continue;
        try {
          await storage.delete(key);
          deleted++;
        } catch (e) {
          failed++;
          log.warn("media.storage.sweep_delete_failed", { key, err: (e as Error).message });
        }
      }
    }
  } while (token && scanned < maxObjects);
  if (deleted || failed) log.info("media.storage.sweep", { scanned, deleted, failed });
  return { configured: true, scanned, deleted, failed };
}

export type MigrationResult = { configured: boolean; moved: number; failed: number; remaining: number };

/**
 * Moves media rows still stored in PostgreSQL to object storage, in
 * batches. Per row: upload (no transaction open), then one system
 * transaction sets storage_key and clears bytes, only if the row is still in
 * the database. Idempotent and resumable: rows already moved are skipped (in id order), a
 * failed row is reported and left in PostgreSQL (still served), and a run can
 * be interrupted at any point.
 */
export async function migrateMediaToStorage(opts: { batchSize?: number; limit?: number; onProgress?: (r: { moved: number; failed: number }) => void } = {}): Promise<MigrationResult> {
  const storage = mediaStorage();
  const remaining = async () => Number((await asSystem((tx) => tx.select({ n: sql<number>`count(*)::int` }).from(media).where(isNull(media.storageKey))))[0]?.n ?? 0);
  if (!storage) return { configured: false, moved: 0, failed: 0, remaining: await remaining() };
  const batchSize = Math.max(1, Math.min(opts.batchSize ?? 25, 200));
  const limit = opts.limit ?? Number.POSITIVE_INFINITY;
  let moved = 0;
  let failed = 0;
  // Keyset on the id (a timestamp cursor would lose PostgreSQL's microseconds in a JS Date).
  let cursor: string | null = null;
  while (moved + failed < limit) {
    const after: string | null = cursor;
    // Ids only: the bytes of each row are read one at a time below.
    const batch: { id: string; organizationId: string }[] = await asSystem((tx) =>
      tx
        .select({ id: media.id, organizationId: media.organizationId })
        .from(media)
        .where(and(isNull(media.storageKey), after ? gt(media.id, after) : undefined))
        .orderBy(asc(media.id))
        .limit(Math.min(batchSize, limit - moved - failed)),
    );
    if (!batch.length) break;
    for (const r of batch) {
      cursor = r.id;
      try {
        const [row] = await asSystem((tx) => tx.select({ bytes: media.bytes }).from(media).where(and(eq(media.id, r.id), isNull(media.storageKey))).limit(1));
        if (!row?.bytes) continue;
        const key = await uploadMediaObject(storage, r.organizationId, r.id, row.bytes);
        const updated = await asSystem((tx) =>
          tx.update(media).set({ storageKey: key, bytes: null }).where(and(eq(media.id, r.id), isNull(media.storageKey))).returning({ id: media.id }),
        );
        if (updated.length) moved++;
        else {
          // The row was deleted meanwhile (or moved by a concurrent run, which recorded this same key).
          const [still] = await asSystem((tx) => tx.select({ key: media.storageKey }).from(media).where(eq(media.id, r.id)).limit(1));
          if (!still) await discardMediaObjects([key], "migration_row_deleted");
        }
      } catch (e) {
        failed++;
        log.warn("media.storage.migrate_failed", { mediaId: r.id, err: (e as Error).message });
      }
    }
    opts.onProgress?.({ moved, failed });
  }
  return { configured: true, moved, failed, remaining: await remaining() };
}
