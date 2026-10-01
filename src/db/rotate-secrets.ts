/**
 * `pnpm secrets:rotate`: re-encrypt every provider credential with the current
 * primary key (the first entry of BEACON_ENCRYPTION_KEYS, or the legacy
 * BEACON_ENCRYPTION_KEY). Keep the old key in the ring until this has run;
 * then remove it. Idempotent: envelopes already on the primary key are skipped.
 * Never prints secret values.
 */
import { eq } from "drizzle-orm";
import { asSystem, closeDb } from "./index";
import { notificationWebhooks, providerCredentials } from "./schema";
import { decryptSecret, encryptSecret, needsReencryption } from "@/lib/security/crypto";

export async function rotateProviderCredentials(opts: { organizationId?: string } = {}): Promise<{ total: number; rotated: number; failed: string[] }> {
  const rows = await asSystem((tx) =>
    tx
      .select({ id: providerCredentials.id, integrationId: providerCredentials.integrationId, ciphertext: providerCredentials.ciphertext, keyVersion: providerCredentials.keyVersion })
      .from(providerCredentials)
      .where(opts.organizationId ? eq(providerCredentials.organizationId, opts.organizationId) : undefined),
  );
  let rotated = 0;
  const failed: string[] = [];
  for (const r of rows) {
    if (!needsReencryption(r.ciphertext)) continue;
    try {
      const plain = decryptSecret(r.ciphertext, r.integrationId);
      const next = encryptSecret(plain, r.integrationId);
      await asSystem((tx) => tx.update(providerCredentials).set({ ciphertext: next, keyVersion: r.keyVersion + 1, rotatedAt: new Date() }).where(eq(providerCredentials.id, r.id)));
      rotated++;
    } catch (e) {
      failed.push(`${r.id}: ${(e as Error).message}`);
    }
  }
  return { total: rows.length, rotated, failed };
}

/** Same for notification webhook signing secrets (AAD: "notification_webhook:<id>"). */
export async function rotateNotificationWebhookSecrets(opts: { organizationId?: string } = {}): Promise<{ total: number; rotated: number; failed: string[] }> {
  const rows = await asSystem((tx) =>
    tx
      .select({ id: notificationWebhooks.id, ciphertext: notificationWebhooks.secretCiphertext, keyVersion: notificationWebhooks.keyVersion })
      .from(notificationWebhooks)
      .where(opts.organizationId ? eq(notificationWebhooks.organizationId, opts.organizationId) : undefined),
  );
  let rotated = 0;
  const failed: string[] = [];
  for (const r of rows) {
    if (!needsReencryption(r.ciphertext)) continue;
    try {
      const aad = `notification_webhook:${r.id}`;
      const next = encryptSecret(decryptSecret(r.ciphertext, aad), aad);
      await asSystem((tx) => tx.update(notificationWebhooks).set({ secretCiphertext: next, keyVersion: r.keyVersion + 1 }).where(eq(notificationWebhooks.id, r.id)));
      rotated++;
    } catch (e) {
      failed.push(`${r.id}: ${(e as Error).message}`);
    }
  }
  return { total: rows.length, rotated, failed };
}

async function main() {
  const res = await rotateProviderCredentials();
  console.log(`provider credentials: ${res.total} total, ${res.rotated} re-encrypted, ${res.failed.length} failed`);
  for (const f of res.failed) console.error(`  ${f}`);
  const hooks = await rotateNotificationWebhookSecrets();
  console.log(`notification webhooks: ${hooks.total} total, ${hooks.rotated} re-encrypted, ${hooks.failed.length} failed`);
  for (const f of hooks.failed) console.error(`  ${f}`);
  await closeDb();
  if (res.failed.length || hooks.failed.length) process.exit(1);
}

if (process.argv[1] && /rotate-secrets\.ts$/.test(process.argv[1])) {
  main().catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
