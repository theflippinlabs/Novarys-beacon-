import Link from "next/link";
import type { Metadata } from "next";
import { Badge, EmptyState, Flash, HiddenBack, PageHeader, StatusBadge, cx } from "@/components/ui";
import { markAllNotificationsReadAction, markNotificationReadAction, openNotificationAction } from "@/app/actions/reports";
import { displayVars, KIND_LABELS, type DigestParams, type NotificationKind } from "@/core/notifications/notifications";
import { pageData, sp1, type SP } from "@/lib/page";
import { getI18n, getT } from "@/i18n/server";
import { inbox, unreadCount } from "@/services/notifications";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Notifications") };
}

export default async function NotificationsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const unreadOnly = sp1(sp, "filter") === "unread";
  const { data } = await pageData(async (tx, ctx) => ({ list: await inbox(tx, ctx.org.id, ctx.user.id, { unreadOnly }), unread: await unreadCount(tx, ctx.org.id, ctx.user.id) }));
  const { t, intl } = await getI18n();
  const back = unreadOnly ? "/notifications?filter=unread" : "/notifications";
  return (
    <>
      <PageHeader
        eyebrow={t("Notifications")}
        title={t("Inbox")}
        description={t("One digest per kind and per day, built from measured events only. Choose channels and thresholds in Settings.")}
        actions={
          <>
            <Link href="/settings/notifications" className="eyebrow hover:text-chrome">
              {t("Preferences")}
            </Link>
            {data.unread > 0 && (
              <form action={markAllNotificationsReadAction}>
                <HiddenBack path={back} />
                <button className="inline-flex items-center gap-2 border border-line-strong px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-platinum hover:border-blue-bright">{t("Mark all as read")}</button>
              </form>
            )}
          </>
        }
      />
      <Flash searchParams={sp} />
      <nav className="mb-4 flex gap-2 text-xs" aria-label={t("Filter")}>
        <Link href="/notifications" aria-current={!unreadOnly ? "page" : undefined} className={cx("rounded-full border px-3 py-1", !unreadOnly ? "border-blue-bright text-platinum" : "border-line-strong text-muted")}>
          {t("All")}
        </Link>
        <Link href="/notifications?filter=unread" aria-current={unreadOnly ? "page" : undefined} className={cx("rounded-full border px-3 py-1", unreadOnly ? "border-blue-bright text-platinum" : "border-line-strong text-muted")}>
          {t("Unread ({n})", { n: data.unread })}
        </Link>
      </nav>
      {!data.list.length ? (
        <EmptyState
          variant={unreadOnly ? "filtered" : "no_data_yet"}
          what={unreadOnly ? t("No unread notifications") : t("No notifications yet")}
          why={t("Beacon notifies you about critical SEO issues, traffic drops, queries entering the top positions, disconnected integrations, failed crawls, drafts awaiting approval, conversion anomalies and high-priority opportunities.")}
          action={unreadOnly ? { label: t("All"), href: "/notifications" } : { label: t("Preferences"), href: "/settings/notifications" }}
        />
      ) : (
        <ul className="flex flex-col gap-3">
          {data.list.map((n) => {
            const p = n.params as DigestParams;
            const unread = !n.readAt;
            return (
              <li key={n.id} className={cx("border bg-panel/90 p-4", unread ? "border-blue/60" : "border-line")} data-unread={unread ? "true" : "false"}>
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      {unread && <span className="h-2 w-2 rounded-full bg-blue-bright" aria-label={t("Unread")} />}
                      <StatusBadge status={n.severity} />
                      <Badge tone="muted">{t(KIND_LABELS[n.kind as NotificationKind])}</Badge>
                      <span className="num text-[11px] text-muted">{n.updatedAt.toLocaleString(intl, { dateStyle: "medium", timeStyle: "short" })}</span>
                    </div>
                    <form action={openNotificationAction} className="mt-2">
                      <HiddenBack path={back} />
                      <input type="hidden" name="id" value={n.id} />
                      <button className="text-left text-sm font-medium text-platinum hover:text-blue-bright">{t(n.titleKey, { n: p.n ?? p.items?.length ?? 0 })}</button>
                    </form>
                  </div>
                  {unread && (
                    <form action={markNotificationReadAction}>
                      <HiddenBack path={back} />
                      <input type="hidden" name="id" value={n.id} />
                      <button className="eyebrow hover:text-chrome">{t("Mark as read")}</button>
                    </form>
                  )}
                </div>
                {p.items?.length > 0 && (
                  <ul className="mt-2 flex flex-col gap-1 text-xs">
                    {p.items.slice(0, 8).map((i) => (
                      <li key={i.fp} className="min-w-0 truncate">
                        <Link href={i.href} className="text-chrome hover:text-blue-bright">
                          {t(i.key, displayVars(t, i.vars))}
                        </Link>
                      </li>
                    ))}
                    {p.items.length > 8 && <li className="text-muted">{t("and {n} more", { n: p.n - 8 })}</li>}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </>
  );
}
