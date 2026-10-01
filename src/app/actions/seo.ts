"use server";

import { z } from "zod";
import { withOrg } from "@/db";
import { act, zId } from "@/lib/actions";
import { requirePermission } from "@/lib/auth/session";
import { ForbiddenError } from "@/lib/auth/rbac";
import { addDomain, getDomain, probeDomain, recordVerification, removeDomain, type DomainProbe } from "@/services/domains";
import { setIssueStatus } from "@/services/seo";

const BACK = "/discovery/domains";

export async function addDomainAction(fd: FormData) {
  return act(fd, "settings:manage", z.object({ domain: z.string().trim().min(3).max(253) }), async ({ tx, actor }, i) => {
    const row = await addDomain(tx, actor, i.domain);
    return { ok: row.verifiedAt ? "Domain already verified." : "Domain added. Publish the token, then choose Verify now.", redirect: `${BACK}#d-${row.id}` };
  });
}

/**
 * The ownership check (DNS + HTTPS file) runs before the database
 * transaction; act() then records the result.
 */
export async function verifyDomainAction(fd: FormData) {
  const id = String(fd.get("id") ?? "");
  let probe: DomainProbe | null = null;
  const ctx = await requirePermission("settings:manage").catch((e) => {
    if (e instanceof ForbiddenError) return null;
    throw e;
  });
  if (ctx && zId.safeParse(id).success) {
    const row = await withOrg(ctx.org.id, (tx) => getDomain(tx, ctx.org.id, id));
    if (row) probe = await probeDomain(row.domain, row.token);
  }
  return act(fd, "settings:manage", z.object({ id: zId }), async ({ tx, actor }) => {
    if (!probe) throw new Error("Domain not found");
    const row = await recordVerification(tx, actor, id, probe);
    // A failed check is still recorded (last checked, last error), so it is reported without throwing.
    if (!probe.ok) return { redirect: `${BACK}?error=${encodeURIComponent(`Verification failed for ${row.domain}: ${probe.error}`.slice(0, 280))}#d-${id}` };
    return { ok: `${row.domain} is verified.`, redirect: `${BACK}#d-${id}` };
  });
}

export async function removeDomainAction(fd: FormData) {
  return act(fd, "settings:manage", z.object({ id: zId }), async ({ tx, actor }, i) => {
    await removeDomain(tx, actor, i.id);
    return { ok: "Domain removed." };
  });
}

export async function bulkIssueStatusAction(fd: FormData) {
  return act(fd, "query:write", z.object({ ids: z.array(zId).min(1).max(200), status: z.enum(["OPEN", "RESOLVED", "IGNORED"]) }), async ({ tx, actor }, i) => {
    const n = await setIssueStatus(tx, actor.organizationId, i.ids, i.status);
    return { ok: `${n} issue(s) updated.` };
  });
}
