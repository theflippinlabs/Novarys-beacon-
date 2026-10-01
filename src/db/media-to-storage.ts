/**
 * `pnpm media:migrate-to-storage [--batch=25] [--limit=N]`: moves media bytes
 * still stored in PostgreSQL to the configured object storage
 * (BEACON_MEDIA_S3_*). Uses the system role (it crosses tenants). Idempotent
 * and resumable: rows already moved are skipped, a failed row stays in
 * PostgreSQL (and is still served) and is retried on the next run. Never
 * prints image bytes or credentials.
 */
import { closeDb } from "./index";
import { migrateMediaToStorage } from "@/services/media-storage";

function flag(name: string): number | undefined {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return undefined;
  const n = Number(arg.slice(name.length + 3));
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
  return n;
}

async function main() {
  const res = await migrateMediaToStorage({
    batchSize: flag("batch"),
    limit: flag("limit"),
    onProgress: (p) => console.log(`media: ${p.moved} moved, ${p.failed} failed so far`),
  });
  await closeDb();
  if (!res.configured) {
    console.error(`media object storage is not configured (set BEACON_MEDIA_S3_*); ${res.remaining} image(s) stay in PostgreSQL`);
    process.exit(1);
  }
  console.log(`media: ${res.moved} moved to object storage, ${res.failed} failed, ${res.remaining} still in PostgreSQL`);
  if (res.failed) process.exit(1);
}

if (process.argv[1] && /media-to-storage\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
