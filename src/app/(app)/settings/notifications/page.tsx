import type { Metadata } from "next";
import { Badge, Button, Field, Flash, HiddenBack, PageHeader, Panel, Table, Td, Th } from "@/components/ui";
import { SettingsTabs } from "@/components/shell/settings-tabs";
import { addWebhookAction, removeWebhookAction, saveNotificationPreferencesAction, saveNotificationSettingsAction, testWebhookAction, toggleWebhookAction } from "@/app/actions/reports";
import { KIND_LABELS, NOTIFICATION_KINDS } from "@/core/notifications/notifications";
import { emailConfig, EMAIL_NOT_CONNECTED } from "@/integrations/email";
import { pageData, type SP } from "@/lib/page";
import { getI18n, getT } from "@/i18n/server";
import { channelEnabled, listWebhooks, loadPreferences, thresholdsFrom } from "@/services/notifications";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Notification settings") };
}

const BACK = "/settings/notifications";
const INPUT = "w-full border border-line-strong bg-obsidian px-3 py-2 text-sm text-platinum";

export default async function NotificationSettingsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { data, ctx, can } = await pageData(async (tx, ctx) => ({ prefs: await loadPreferences(tx, ctx.org.id), hooks: await listWebhooks(tx, ctx.org.id) }));
  const { t, intl } = await getI18n();
  const email = emailConfig();
  const th = thresholdsFrom(data.prefs);
  const admin = can("settings:manage");
  return (
    <>
      <PageHeader eyebrow={t("13 / Settings")} title={t("Notifications")} description={t("Choose how Beacon tells you about what changed. Evaluated after every sync, audit and opportunity run, and daily; one digest per kind and per day.")} />
      <SettingsTabs active="notifications" />
      <Flash searchParams={sp} />

      <Panel eyebrow={t("Your channels")} title={t("What you receive")} className="mb-6">
        {!email.configured && (
          <p className="mb-3 border border-line px-3 py-2 text-xs text-muted" data-email-state="NOT_CONNECTED">
            <span className="mr-2 font-medium text-chrome">{t("Email")}</span>
            {t(EMAIL_NOT_CONNECTED)}
          </p>
        )}
        <form action={saveNotificationPreferencesAction}>
          <HiddenBack path={BACK} />
          <Table>
            <thead>
              <tr>
                <Th>{t("Kind")}</Th>
                <Th className="text-center">{t("In-app")}</Th>
                <Th className="text-center">{t("Email")}</Th>
              </tr>
            </thead>
            <tbody>
              {NOTIFICATION_KINDS.map((k) => (
                <tr key={k}>
                  <Td>{t(KIND_LABELS[k])}</Td>
                  <Td className="text-center">
                    <input type="checkbox" name="on[]" value={`${k}:IN_APP`} defaultChecked={channelEnabled(data.prefs, ctx.user.id, k, "IN_APP")} aria-label={t("{kind}: in-app", { kind: t(KIND_LABELS[k]) })} className="h-4 w-4" />
                  </Td>
                  <Td className="text-center">
                    <input
                      type="checkbox"
                      name="on[]"
                      value={`${k}:EMAIL`}
                      defaultChecked={email.configured && channelEnabled(data.prefs, ctx.user.id, k, "EMAIL")}
                      disabled={!email.configured}
                      title={email.configured ? undefined : t(EMAIL_NOT_CONNECTED)}
                      aria-label={t("{kind}: email", { kind: t(KIND_LABELS[k]) })}
                      className="h-4 w-4 disabled:opacity-40"
                    />
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
          <div className="mt-4">
            <Button variant="gold">{t("Save my preferences")}</Button>
          </div>
        </form>
      </Panel>

      <Panel eyebrow={t("Organisation")} title={t("Thresholds and webhook events")} className="mb-6">
        {admin ? (
          <form action={saveNotificationSettingsAction} className="flex flex-col gap-5">
            <HiddenBack path={BACK} />
            <fieldset className="grid gap-4 sm:grid-cols-2">
              <legend className="eyebrow mb-2 text-chrome">{t("Traffic drop")}</legend>
              <Field label={t("Clicks drop, week over week (%)")} hint={t("Only when search data is connected.")}>
                <input name="dropPct" type="number" min={5} max={95} step={1} defaultValue={th.TRAFFIC_DROP.dropPct} className={INPUT} />
              </Field>
              <Field label={t("Minimum clicks in the previous week")}>
                <input name="minClicks" type="number" min={1} step={1} defaultValue={th.TRAFFIC_DROP.minClicks} className={INPUT} />
              </Field>
            </fieldset>
            <fieldset className="grid gap-4 sm:grid-cols-2">
              <legend className="eyebrow mb-2 text-chrome">{t("Query entered the top positions")}</legend>
              <Field label={t("Positions")}>
                <select name="range" defaultValue={th.QUERY_ENTERED_TOP.range} className={INPUT}>
                  <option value="BOTH">{t("1 to 3 and 4 to 10")}</option>
                  <option value="TOP_3">{t("1 to 3 only")}</option>
                  <option value="TOP_10">{t("4 to 10 only")}</option>
                </select>
              </Field>
              <Field label={t("Minimum impressions in the week")}>
                <input name="minImpressions" type="number" min={1} step={1} defaultValue={th.QUERY_ENTERED_TOP.minImpressions} className={INPUT} />
              </Field>
            </fieldset>
            <fieldset className="grid gap-4 sm:grid-cols-2">
              <legend className="eyebrow mb-2 text-chrome">{t("Conversion anomaly")}</legend>
              <Field label={t("Z-score threshold")} hint={t("Daily conversions (signups, trials, subscriptions) against the trailing 28 days.")}>
                <input name="z" type="number" min={1.5} max={10} step={0.1} defaultValue={th.CONVERSION_ANOMALY.z} className={INPUT} />
              </Field>
              <Field label={t("Minimum daily average")} hint={t("Below this volume, changes are noise and are not notified.")}>
                <input name="minDailyMean" type="number" min={1} step={0.5} defaultValue={th.CONVERSION_ANOMALY.minDailyMean} className={INPUT} />
              </Field>
            </fieldset>
            <fieldset>
              <legend className="eyebrow mb-2 text-chrome">{t("Events sent to webhooks")}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {NOTIFICATION_KINDS.map((k) => (
                  <label key={k} className="flex items-center gap-2 text-sm text-chrome">
                    <input type="checkbox" name="webhookKinds[]" value={k} defaultChecked={channelEnabled(data.prefs, null, k, "WEBHOOK")} className="h-4 w-4" />
                    {t(KIND_LABELS[k])}
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <Button variant="gold">{t("Save thresholds")}</Button>
            </div>
          </form>
        ) : (
          <p className="text-sm text-muted">{t("Only owners and admins can change thresholds and webhooks.")}</p>
        )}
      </Panel>

      <Panel eyebrow={t("Webhooks")} title={t("Signed webhooks")}>
        <p className="mb-4 text-xs text-muted">{t("Beacon POSTs JSON to your https endpoint, signed with HMAC-SHA256 in the X-Beacon-Signature header (t=timestamp,v1=hex of timestamp.body). Private and local addresses are refused. Failed deliveries are retried with back-off.")}</p>
        {data.hooks.length > 0 && (
          <div className="mb-6">
            <Table>
              <thead>
                <tr>
                  <Th>{t("URL")}</Th>
                  <Th>{t("Events")}</Th>
                  <Th>{t("Last delivery")}</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {data.hooks.map((h) => (
                  <tr key={h.id}>
                    <Td className="max-w-xs break-all text-xs">
                      {h.url}
                      <div className="mt-1">{h.active ? <Badge tone="ok">{t("Active")}</Badge> : <Badge tone="muted">{t("Disabled")}</Badge>}</div>
                    </Td>
                    <Td className="text-xs">{h.kinds.length ? h.kinds.map((k) => t(KIND_LABELS[k as keyof typeof KIND_LABELS] ?? k)).join(", ") : t("All enabled events")}</Td>
                    <Td className="text-xs">
                      {h.lastDeliveryAt ? <span className="num">{h.lastDeliveryAt.toLocaleString(intl, { dateStyle: "medium", timeStyle: "short" })}</span> : <span className="text-muted">{t("Never")}</span>}
                      {h.lastError && <div className="mt-1 break-all text-crit">{h.lastError}</div>}
                    </Td>
                    <Td>
                      {admin && (
                        <span className="flex flex-wrap gap-2">
                          <form action={testWebhookAction}>
                            <HiddenBack path={BACK} />
                            <input type="hidden" name="id" value={h.id} />
                            <button className="eyebrow hover:text-chrome">{t("Send test")}</button>
                          </form>
                          <form action={toggleWebhookAction}>
                            <HiddenBack path={BACK} />
                            <input type="hidden" name="id" value={h.id} />
                            <input type="hidden" name="active" value={h.active ? "" : "true"} />
                            <button className="eyebrow hover:text-chrome">{h.active ? t("Disable") : t("Enable")}</button>
                          </form>
                          <form action={removeWebhookAction}>
                            <HiddenBack path={BACK} />
                            <input type="hidden" name="id" value={h.id} />
                            <button className="eyebrow text-crit hover:text-crit">{t("Remove")}</button>
                          </form>
                        </span>
                      )}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </div>
        )}
        {admin && (
          <form action={addWebhookAction} className="grid gap-4 sm:grid-cols-2">
            <HiddenBack path={BACK} />
            <Field label={t("Endpoint URL")} hint={t("https only, public address.")}>
              <input name="url" type="url" required placeholder="https://" className={INPUT} />
            </Field>
            <Field label={t("Signing secret")} hint={t("At least 16 characters. Stored encrypted; keep a copy to verify signatures.")}>
              <input name="secret" type="password" required minLength={16} autoComplete="new-password" className={INPUT} />
            </Field>
            <fieldset className="sm:col-span-2">
              <legend className="eyebrow mb-2 text-chrome">{t("Only these events (none checked: every enabled event)")}</legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {NOTIFICATION_KINDS.map((k) => (
                  <label key={k} className="flex items-center gap-2 text-sm text-chrome">
                    <input type="checkbox" name="kinds[]" value={k} className="h-4 w-4" />
                    {t(KIND_LABELS[k])}
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <Button variant="gold">{t("Add webhook")}</Button>
            </div>
          </form>
        )}
      </Panel>
    </>
  );
}
