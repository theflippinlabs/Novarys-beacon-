import { randomBytes } from "node:crypto";
import { resolveTxt } from "node:dns/promises";
import { and, asc, eq } from "drizzle-orm";
import type { Tx } from "@/db";
import { verifiedDomains } from "@/db/schema";
import { withDeadline } from "@/core/seo/crawl";
import { domainFromSearchConsoleProperty, fileBodyMatches, isVerifiableDomain, normalizeDomain, SEARCH_CONSOLE_OWNER_LEVELS, txtRecordsMatch, VERIFICATION_FILE_PATH } from "@/core/seo/domains";
import { safeFetch } from "@/lib/security/ssrf";
import { audit, type Actor } from "@/lib/audit";

export type DomainProbe = { ok: boolean; method: "DNS_TXT" | "WELL_KNOWN_FILE" | "SEARCH_CONSOLE" | null; error: string | null; checkedAt: Date };

export async function listDomains(tx: Tx, organizationId: string) {
  return tx.select().from(verifiedDomains).where(eq(verifiedDomains.organizationId, organizationId)).orderBy(asc(verifiedDomains.domain));
}

export async function getDomain(tx: Tx, organizationId: string, id: string) {
  return tx.query.verifiedDomains.findFirst({ where: and(eq(verifiedDomains.id, id), eq(verifiedDomains.organizationId, organizationId)) });
}

/** Register a domain to verify; returns the existing row when it was already added. */
export async function addDomain(tx: Tx, actor: Actor, input: string) {
  const domain = normalizeDomain(input);
  if (!domain || !isVerifiableDomain(domain)) throw new Error("Enter a domain name you control, such as example.com.");
  const token = randomBytes(16).toString("hex");
  const [row] = await tx.insert(verifiedDomains).values({ organizationId: actor.organizationId, domain, token, createdBy: actor.userId ?? null }).onConflictDoNothing().returning();
  if (!row) return (await tx.query.verifiedDomains.findFirst({ where: and(eq(verifiedDomains.organizationId, actor.organizationId), eq(verifiedDomains.domain, domain)) }))!;
  await audit(tx, actor, "domain.add", "verified_domain", row.id, { domain });
  return row;
}

export async function removeDomain(tx: Tx, actor: Actor, id: string) {
  const [row] = await tx.delete(verifiedDomains).where(and(eq(verifiedDomains.id, id), eq(verifiedDomains.organizationId, actor.organizationId))).returning();
  if (row) await audit(tx, actor, "domain.remove", "verified_domain", row.id, { domain: row.domain });
  return Boolean(row);
}

/**
 * Check ownership over the network (never inside a DB transaction): a DNS TXT
 * record "beacon-verification=<token>" on the domain, or the token in
 * https://<domain>/.well-known/beacon-verification.txt (SSRF-safe fetch).
 */
export async function probeDomain(
  domain: string,
  token: string,
  deps: { resolveTxt?: (d: string) => Promise<string[][]>; fetchFile?: (url: string) => Promise<{ status: number; body: string }> } = {},
): Promise<DomainProbe> {
  const errors: string[] = [];
  try {
    const records = await withDeadline((deps.resolveTxt ?? resolveTxt)(domain), 5000, "DNS lookup");
    if (txtRecordsMatch(records, token)) return { ok: true, method: "DNS_TXT", error: null, checkedAt: new Date() };
    errors.push("DNS: no matching TXT record");
  } catch (e) {
    errors.push(`DNS: ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}`);
  }
  try {
    const url = `https://${domain}${VERIFICATION_FILE_PATH}`;
    const res = await (deps.fetchFile ?? ((u: string) => safeFetch(u, { maxBytes: 4096, timeoutMs: 8000, maxRedirects: 2 })))(url);
    if (res.status === 200 && fileBodyMatches(res.body, token)) return { ok: true, method: "WELL_KNOWN_FILE", error: null, checkedAt: new Date() };
    errors.push(res.status === 200 ? "File: token not found" : `File: HTTP ${res.status}`);
  } catch (e) {
    errors.push(`File: ${(e as Error).message}`);
  }
  return { ok: false, method: null, error: errors.join("; ").slice(0, 500), checkedAt: new Date() };
}

/** Persist the result of a probe. A failed re-check keeps an earlier verification but records the error. */
export async function recordVerification(tx: Tx, actor: Actor, id: string, probe: DomainProbe) {
  const row = await getDomain(tx, actor.organizationId, id);
  if (!row) throw new Error("Domain not found");
  const [updated] = await tx
    .update(verifiedDomains)
    .set(probe.ok ? { verifiedAt: row.verifiedAt ?? probe.checkedAt, method: probe.method, lastCheckedAt: probe.checkedAt, lastError: null } : { lastCheckedAt: probe.checkedAt, lastError: probe.error })
    .where(and(eq(verifiedDomains.id, id), eq(verifiedDomains.organizationId, actor.organizationId)))
    .returning();
  await audit(tx, actor, probe.ok ? "domain.verify" : "domain.verify_failed", "verified_domain", id, { domain: row.domain, method: probe.method, error: probe.error });
  return updated;
}

/**
 * A Search Console connection that Google confirmed with owner or full access
 * proves the property's domain the same way a DNS record does (only a verified
 * owner can grant that access), so the domain is marked verified without a
 * second DNS step. Runs inside the caller's tenant transaction; returns the
 * domain when it was verified now.
 */
export async function verifyFromSearchConsole(tx: Tx, organizationId: string, siteUrl: string | undefined, scopes: string[] | null | undefined): Promise<string | null> {
  if (!siteUrl) return null;
  const level = (scopes ?? []).find((s) => s.startsWith("property:"))?.slice("property:".length);
  if (!level || !(SEARCH_CONSOLE_OWNER_LEVELS as readonly string[]).includes(level)) return null;
  const domain = domainFromSearchConsoleProperty(siteUrl);
  if (!domain || !isVerifiableDomain(domain)) return null;
  const existing = await tx.query.verifiedDomains.findFirst({ where: and(eq(verifiedDomains.organizationId, organizationId), eq(verifiedDomains.domain, domain)) });
  if (existing?.verifiedAt) return null;
  const now = new Date();
  const actor: Actor = { organizationId, userId: null, actorType: "SYSTEM" };
  let id = existing?.id;
  if (existing) {
    await tx.update(verifiedDomains).set({ verifiedAt: now, method: "SEARCH_CONSOLE", lastCheckedAt: now, lastError: null }).where(and(eq(verifiedDomains.id, existing.id), eq(verifiedDomains.organizationId, organizationId)));
  } else {
    const [row] = await tx
      .insert(verifiedDomains)
      .values({ organizationId, domain, token: randomBytes(16).toString("hex"), method: "SEARCH_CONSOLE", verifiedAt: now, lastCheckedAt: now })
      .onConflictDoNothing()
      .returning();
    id = row?.id;
  }
  if (!id) return null;
  await audit(tx, actor, "domain.verify", "verified_domain", id, { domain, method: "SEARCH_CONSOLE", property: siteUrl, permission: level });
  return domain;
}
