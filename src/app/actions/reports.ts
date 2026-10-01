"use server";

import { z } from "zod";
import { act, zId, zCheckbox } from "@/lib/actions";
import { NOTIFICATION_KINDS, type NotificationKind } from "@/core/notifications/notifications";
import { generateBriefing } from "@/services/briefings";
import { generateWeeklyReport } from "@/services/reports";
import { addWebhook, markAllRead, markRead, removeWebhook, saveMemberPreferences, saveOrgNotificationSettings, setWebhookActive } from "@/services/notifications";
import { enqueue } from "@/jobs/queue";

/** "Generate now": the organisation briefing, computed in this request (deterministic, no provider call). */
export async function generateBriefingAction(fd: FormData) {
  return act(fd, "job:run", z.object({}), async ({ tx, actor }) => {
    await generateBriefing(tx, actor.organizationId, { actor });
    return { ok: "Briefing generated." };
  });
}

/** Generate (or regenerate) the weekly executive report of the last complete week. */
export async function generateReportAction(fd: FormData) {
  return act(fd, "job:run", z.object({}), async ({ tx, actor }) => {
    const r = await generateWeeklyReport(tx, actor.organizationId, { actor });
    return { ok: "Report generated.", redirect: `/reports/${r.id}` };
  });
}

/** Open a notification: mark it read, then go to its page. */
export async function openNotificationAction(fd: FormData) {
  return act(fd, "read", z.object({ id: zId }), async ({ tx, actor }, i) => {
    const link = await markRead(tx, actor, i.id);
    return { redirect: link ?? "/notifications" };
  });
}

export async function markNotificationReadAction(fd: FormData) {
  return act(fd, "read", z.object({ id: zId }), async ({ tx, actor }, i) => {
    await markRead(tx, actor, i.id);
    return { ok: "Marked as read." };
  });
}

export async function markAllNotificationsReadAction(fd: FormData) {
  return act(fd, "read", z.object({}), async ({ tx, actor }) => {
    const n = await markAllRead(tx, actor);
    return { ok: n ? "All notifications marked as read." : "No unread notifications." };
  });
}

/** A member's own channels: checkbox names are "<KIND>:<CHANNEL>". */
export async function saveNotificationPreferencesAction(fd: FormData) {
  return act(fd, "read", z.object({ on: z.array(z.string().max(80)).max(64).optional() }), async ({ tx, actor }, i) => {
    const allowed = new Set(NOTIFICATION_KINDS.flatMap((k) => [`${k}:IN_APP`, `${k}:EMAIL`]));
    await saveMemberPreferences(tx, actor, new Set((i.on ?? []).filter((v) => allowed.has(v))));
    return { ok: "Notification preferences saved." };
  });
}

const kindList = z
  .array(z.enum(NOTIFICATION_KINDS))
  .max(NOTIFICATION_KINDS.length)
  .optional()
  .transform((v) => v ?? []);

export async function saveNotificationSettingsAction(fd: FormData) {
  return act(
    fd,
    "settings:manage",
    z.object({
      dropPct: z.coerce.number().min(5).max(95),
      minClicks: z.coerce.number().int().min(1).max(100000),
      range: z.enum(["TOP_3", "TOP_10", "BOTH"]),
      minImpressions: z.coerce.number().int().min(1).max(100000),
      z: z.coerce.number().min(1.5).max(10),
      minDailyMean: z.coerce.number().min(1).max(100000),
      webhookKinds: kindList,
    }),
    async ({ tx, actor }, i) => {
      await saveOrgNotificationSettings(tx, actor, {
        thresholds: { TRAFFIC_DROP: { dropPct: i.dropPct, minClicks: i.minClicks }, QUERY_ENTERED_TOP: { range: i.range, minImpressions: i.minImpressions }, CONVERSION_ANOMALY: { z: i.z, minDailyMean: i.minDailyMean } },
        webhookKinds: new Set<NotificationKind>(i.webhookKinds),
      });
      return { ok: "Notification thresholds saved." };
    },
  );
}

export async function addWebhookAction(fd: FormData) {
  return act(fd, "settings:manage", z.object({ url: z.string().trim().min(8).max(2000), secret: z.string().min(16).max(200), kinds: kindList }), async ({ tx, actor }, i) => {
    await addWebhook(tx, actor, { url: i.url, secret: i.secret, kinds: i.kinds });
    return { ok: "Webhook added." };
  });
}

export async function toggleWebhookAction(fd: FormData) {
  return act(fd, "settings:manage", z.object({ id: zId, active: zCheckbox }), async ({ tx, actor }, i) => {
    await setWebhookActive(tx, actor, i.id, i.active);
    return { ok: i.active ? "Webhook enabled." : "Webhook disabled." };
  });
}

export async function removeWebhookAction(fd: FormData) {
  return act(fd, "settings:manage", z.object({ id: zId }), async ({ tx, actor }, i) => {
    await removeWebhook(tx, actor, i.id);
    return { ok: "Webhook removed." };
  });
}

/** Queue a signed test event to one webhook (delivered by the worker, SSRF-safe). */
export async function testWebhookAction(fd: FormData) {
  return act(fd, "settings:manage", z.object({ id: zId }), async ({ actor }, i) => {
    await enqueue("notifications.deliver", { channel: "WEBHOOK", webhookId: i.id, test: true }, { organizationId: actor.organizationId, idempotencyKey: `notif-test:${i.id}:${Date.now()}`, maxAttempts: 1 });
    return { ok: "Test event queued." };
  });
}
