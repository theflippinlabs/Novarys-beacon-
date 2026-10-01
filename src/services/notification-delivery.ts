import { and, eq } from "drizzle-orm";
import { asSystem, withOrg } from "@/db";
import { notifications, notificationWebhooks, organizations, users } from "@/db/schema";
import { displayVars, KIND_LABELS, signWebhook, type DigestParams, type NotificationKind } from "@/core/notifications/notifications";
import { escapeHtml } from "@/core/util/text";
import { makeT, type T } from "@/i18n/core";
import { FR } from "@/i18n/fr";
import { emailConfig, EmailError, sendEmail, type EmailMessage } from "@/integrations/email";
import { env } from "@/lib/env";
import { decryptSecret } from "@/lib/security/crypto";
import { redactErrorText } from "@/lib/security/redact";
import { safeFetch, SsrfError, type SafeResponse } from "@/lib/security/ssrf";
import { webhookAad } from "./notifications";

export type Notification = typeof notifications.$inferSelect;
export type Fetcher = (url: string, opts: { method: "POST"; body: string; headers: Record<string, string>; timeoutMs: number; maxBytes: number; userAgent: string }) => Promise<Pick<SafeResponse, "status">>;

/** Raised for failures a retry cannot fix (blocked address, 4xx other than 408/429, missing rows). */
export class PermanentDeliveryError extends Error {}

const absolute = (link: string | null) => (link ? new URL(link, env().BEACON_BASE_URL).toString() : null);

/** Title and item lines of a digest in one language. */
export function renderNotification(n: Pick<Notification, "titleKey" | "params" | "kind">, t: T) {
  const p = n.params as DigestParams;
  return {
    kindLabel: t(KIND_LABELS[n.kind as NotificationKind]),
    title: t(n.titleKey, { n: p.n ?? p.items?.length ?? 0 }),
    items: (p.items ?? []).map((i) => ({ text: t(i.key, displayVars(t, i.vars)), href: i.href })),
  };
}

/** Webhook JSON body (English text; machine fields are stable). */
export function webhookPayload(n: Notification, org: { slug: string }, opts: { test?: boolean } = {}) {
  const en = renderNotification(n, makeT(null));
  return {
    id: n.id,
    type: opts.test ? "TEST" : n.kind,
    severity: n.severity,
    organization: org.slug,
    title: en.title,
    count: (n.params as DigestParams).n ?? en.items.length,
    items: en.items.map((i, k) => ({ text: i.text, url: absolute(i.href), fingerprint: (n.params as DigestParams).items[k]?.fp ?? null })),
    url: absolute(n.link),
    created_at: n.createdAt.toISOString(),
    updated_at: n.updatedAt.toISOString(),
  };
}

const defaultFetcher: Fetcher = (url, opts) => safeFetch(url, opts);

/**
 * POST a signed digest to one webhook. Reads in one transaction, calls the
 * endpoint with no transaction open (SSRF-safe: public addresses only, no
 * redirects), records the outcome in a second one. Throws on failure so the
 * job queue retries with back-off (PermanentDeliveryError: no retry).
 */
export async function deliverWebhook(organizationId: string, webhookId: string, notificationId: string | null, deps: { fetcher?: Fetcher; now?: Date } = {}) {
  const now = deps.now ?? new Date();
  const loaded = await withOrg(organizationId, async (tx) => {
    const hook = await tx.query.notificationWebhooks.findFirst({ where: and(eq(notificationWebhooks.organizationId, organizationId), eq(notificationWebhooks.id, webhookId)) });
    const org = await tx.query.organizations.findFirst({ where: eq(organizations.id, organizationId), columns: { slug: true } });
    const n = notificationId ? await tx.query.notifications.findFirst({ where: and(eq(notifications.organizationId, organizationId), eq(notifications.id, notificationId)) }) : null;
    return { hook, org, n };
  });
  if (!loaded.hook || !loaded.org) throw new PermanentDeliveryError("Webhook not found");
  if (!loaded.hook.active) return { skipped: "inactive" };
  const n: Notification =
    loaded.n ??
    ({ id: "test", organizationId, userId: null, kind: "HIGH_PRIORITY_OPPORTUNITY", severity: "INFO", titleKey: "Test event from Beacon", params: { n: 0, items: [], signals: [] }, link: "/notifications", dedupeKey: "test", createdAt: now, updatedAt: now, readAt: null, emailedAt: null } as Notification);
  if (notificationId && !loaded.n) throw new PermanentDeliveryError("Notification not found");
  const body = JSON.stringify(webhookPayload(n, loaded.org, { test: !notificationId }));
  const ts = Math.floor(now.getTime() / 1000);
  const secret = decryptSecret(loaded.hook.secretCiphertext, webhookAad(loaded.hook.id));
  let status = 0;
  let error: string | null = null;
  try {
    const res = await (deps.fetcher ?? defaultFetcher)(loaded.hook.url, {
      method: "POST",
      body,
      headers: { "content-type": "application/json", "x-beacon-signature": signWebhook(secret, ts, body), "x-beacon-timestamp": String(ts), "x-beacon-event": n.kind, "x-beacon-delivery": `${n.id}:${webhookId}` },
      timeoutMs: 10_000,
      maxBytes: 16 * 1024,
      userAgent: "NovarysBeacon/1.0 (+notifications)",
    });
    status = res.status;
    if (status < 200 || status >= 300) error = `HTTP ${status}`;
  } catch (e) {
    error = e instanceof SsrfError ? `Blocked: ${e.message}` : redactErrorText((e as Error).message, 300);
  }
  await withOrg(organizationId, (tx) =>
    tx
      .update(notificationWebhooks)
      .set(error ? { lastError: error, lastStatus: status || null } : { lastDeliveryAt: now, lastStatus: status, lastError: null })
      .where(eq(notificationWebhooks.id, webhookId)),
  );
  if (error) {
    const permanent = error.startsWith("Blocked") || (status >= 400 && status < 500 && status !== 408 && status !== 429);
    throw permanent ? new PermanentDeliveryError(error) : new Error(error);
  }
  return { status };
}

/** Bilingual email body (English then French): no stored member language exists. */
export function emailFor(n: Notification): Omit<EmailMessage, "to"> {
  const en = renderNotification(n, makeT(null));
  const fr = renderNotification(n, makeT(FR));
  const url = absolute(n.link) ?? absolute("/notifications")!;
  const block = (r: typeof en) => [r.title, "", ...r.items.map((i) => `- ${i.text}`)].join("\n");
  const htmlBlock = (r: typeof en, lang: string) =>
    `<div lang="${lang}"><h2 style="font-size:16px">${escapeHtml(r.title)}</h2><ul>${r.items.map((i) => `<li><a href="${escapeHtml(absolute(i.href) ?? url)}">${escapeHtml(i.text)}</a></li>`).join("")}</ul></div>`;
  return {
    subject: `Beacon: ${en.title}`,
    text: `${block(en)}\n\n${url}\n\n---\n\n${block(fr)}\n\n${url}\n`,
    html: `${htmlBlock(en, "en")}<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p><hr>${htmlBlock(fr, "fr")}`,
  };
}

/** Email one member's digest (once: `emailed_at` makes retries idempotent). */
export async function deliverEmail(organizationId: string, notificationId: string, deps: { send?: typeof sendEmail } = {}) {
  if (!emailConfig().configured && !deps.send) return { skipped: "not_connected" };
  const n = await withOrg(organizationId, (tx) => tx.query.notifications.findFirst({ where: and(eq(notifications.organizationId, organizationId), eq(notifications.id, notificationId)) }));
  if (!n || !n.userId) throw new PermanentDeliveryError("Notification not found");
  if (n.emailedAt) return { skipped: "already_sent" };
  // Users are global identities: the address is read on the system path (trusted worker).
  const user = await asSystem((tx) => tx.query.users.findFirst({ where: eq(users.id, n.userId!), columns: { email: true } }));
  if (!user) throw new PermanentDeliveryError("Recipient not found");
  try {
    await (deps.send ?? sendEmail)({ to: user.email, ...emailFor(n) });
  } catch (e) {
    if (e instanceof EmailError && !e.retryable) throw new PermanentDeliveryError(e.message);
    throw e;
  }
  await withOrg(organizationId, (tx) => tx.update(notifications).set({ emailedAt: new Date() }).where(eq(notifications.id, notificationId)));
  return { sent: true };
}
