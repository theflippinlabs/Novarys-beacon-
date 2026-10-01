-- Wave 5a migration slot: media_object_storage (audit item #51).
-- Uploaded media bytes move to S3-compatible object storage when it is configured:
-- a row then records its object key in storage_key and keeps bytes NULL. Without
-- object storage the bytes stay in PostgreSQL as before. Exactly one of the two is set.
-- No data backfill: existing rows keep their bytes (see `pnpm media:migrate-to-storage`).
ALTER TABLE "media" ADD COLUMN IF NOT EXISTS "storage_key" text;--> statement-breakpoint
ALTER TABLE "media" ALTER COLUMN "bytes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "media" DROP CONSTRAINT IF EXISTS "media_bytes_or_storage_ck";--> statement-breakpoint
ALTER TABLE "media" ADD CONSTRAINT "media_bytes_or_storage_ck" CHECK (("bytes" IS NULL) <> ("storage_key" IS NULL));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "media_in_database_idx" ON "media" USING btree ("id") WHERE "storage_key" IS NULL;
