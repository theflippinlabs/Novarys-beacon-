import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { addMemberAction, changePasswordAction, changeRoleAction, removeMemberAction, updateOrgSettingsAction } from "@/app/actions/settings";
import { Badge, Button, Field, Flash, HiddenBack, PageHeader, Panel, Table, Td, Th } from "@/components/ui";
import { SettingsTabs } from "@/components/shell/settings-tabs";
import { asSystem } from "@/db";
import { memberships, users } from "@/db/schema";
import { ROLES } from "@/lib/auth/rbac";
import { pageData, type SP } from "@/lib/page";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Settings") };
}

export default async function SettingsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { t } = await getI18n();
  const { ctx, can } = await pageData(async () => null);
  // Membership rows join the global users table; read them with system privileges, scoped to this org.
  const members = await asSystem((tx) =>
    tx.select({ userId: users.id, email: users.email, name: users.name, role: memberships.role, lastLoginAt: users.lastLoginAt }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.organizationId, ctx.org.id)),
  );
  const attr = ctx.org.settings.attribution ?? { model: "LAST_TOUCH", lookbackDays: 30, referralPrecedence: true };
  const back = "/settings";
  return (
    <>
      <PageHeader
        eyebrow={t("13 / Settings")}
        title={t("Settings")}
        description={t("Organisation “{name}” ({slug}). Beacon is multi-tenant: every record is organisation-scoped and protected by row-level security.", { name: ctx.org.name, slug: ctx.org.slug })}
      />
      <SettingsTabs active="org" />
      <Flash searchParams={sp} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title={t("Organisation & attribution rules")}>
          <form action={updateOrgSettingsAction} className="flex flex-col gap-4">
            <HiddenBack path={back} />
            <Field label={t("Display name")}>
              <input name="displayName" defaultValue={ctx.org.branding.displayName ?? ctx.org.name} disabled={!can("settings:manage")} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label={t("Attribution model")}>
                <select name="model" defaultValue={attr.model} disabled={!can("settings:manage")}>
                  <option value="LAST_TOUCH">{t("Last non-direct touch")}</option>
                  <option value="FIRST_TOUCH">{t("First touch")}</option>
                </select>
              </Field>
              <Field label={t("Lookback window (days)")}>
                <input name="lookbackDays" type="number" min={1} max={180} defaultValue={attr.lookbackDays} disabled={!can("settings:manage")} />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm text-chrome">
              <input type="checkbox" name="referralPrecedence" defaultChecked={attr.referralPrecedence} disabled={!can("settings:manage")} /> {t("Referral / affiliate touches take precedence within the window")}
            </label>
            <Field label={t("Cross-sell: max recommendations per identity per day")}>
              <input name="crossSellDailyCap" type="number" min={0} max={10} defaultValue={ctx.org.settings.crossSell?.globalDailyCap ?? 1} disabled={!can("settings:manage")} />
            </Field>
            {can("settings:manage") && (
              <div>
                <Button variant="gold">{t("Save")}</Button>
              </div>
            )}
          </form>
        </Panel>
        <Panel title={t("Roles")} eyebrow="RBAC">
          <Table>
            <tbody>
              <tr><Th>{t("Owner")}</Th><Td className="text-xs">{t("Everything, including owners and billing-grade settings.")}</Td></tr>
              <tr><Th>{t("Admin")}</Th><Td className="text-xs">{t("Approve & publish content, approve external submissions and recommendations, manage integrations, API keys, members and revenue.")}</Td></tr>
              <tr><Th>{t("Editor")}</Th><Td className="text-xs">{t("Edit knowledge graph, create content and distribution targets, experiments and cross-sell rules.")}</Td></tr>
              <tr><Th>{t("Analyst")}</Th><Td className="text-xs">{t("Run audits, AI tests and analyses; manage queries; read audit log.")}</Td></tr>
              <tr><Th>{t("Viewer")}</Th><Td className="text-xs">{t("Read-only.")}</Td></tr>
            </tbody>
          </Table>
        </Panel>
      </div>
      <Panel title={t("{n} member(s)", { n: members.length })} eyebrow={t("Team")} className="mt-6" pad={false}>
        <Table>
          <thead>
            <tr>
              <Th>{t("Name")}</Th>
              <Th>{t("Email")}</Th>
              <Th>{t("Role")}</Th>
              <Th>{t("Last login")}</Th>
              <Th />
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.userId}>
                <Td className="text-platinum">{m.name}</Td>
                <Td className="text-xs">{m.email}</Td>
                <Td>
                  {can("member:manage") && m.userId !== ctx.user.id ? (
                    <form action={changeRoleAction} className="flex gap-2">
                      <HiddenBack path={back} />
                      <input type="hidden" name="userId" value={m.userId} />
                      <select name="role" defaultValue={m.role} className="!w-32" aria-label={t("Role")}>
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {enumLabel(t, r)}
                          </option>
                        ))}
                      </select>
                      <Button>{t("Set")}</Button>
                    </form>
                  ) : (
                    <Badge>{enumLabel(t, m.role)}</Badge>
                  )}
                </Td>
                <Td className="num text-xs">{m.lastLoginAt?.toISOString().slice(0, 16).replace("T", " ") ?? t("never")}</Td>
                <Td>
                  {can("member:manage") && m.userId !== ctx.user.id && (
                    <form action={removeMemberAction}>
                      <HiddenBack path={back} />
                      <input type="hidden" name="userId" value={m.userId} />
                      <Button variant="danger">{t("Remove")}</Button>
                    </form>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </Table>
        {can("member:manage") && (
          <form action={addMemberAction} className="grid gap-3 border-t border-line p-4 md:grid-cols-5">
            <HiddenBack path={back} />
            <input name="name" placeholder={t("Name")} required aria-label={t("Name")} />
            <input name="email" type="email" placeholder={t("Email")} required aria-label={t("Email")} />
            <select name="role" defaultValue="VIEWER" aria-label={t("Role")}>
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {enumLabel(t, r)}
                </option>
              ))}
            </select>
            <input name="password" type="password" placeholder={t("Initial password (new users)")} autoComplete="new-password" aria-label={t("Initial password")} />
            <Button>{t("Add member")}</Button>
          </form>
        )}
      </Panel>
      <Panel title={t("Your password")} eyebrow={ctx.user.email} className="mt-6">
        <form action={changePasswordAction} className="grid gap-3 md:grid-cols-[1fr_1fr_auto] md:items-end">
          <HiddenBack path={back} />
          <Field label={t("Current password")}>
            <input name="current" type="password" required autoComplete="current-password" />
          </Field>
          <Field label={t("New password (≥ 12 characters)")}>
            <input name="next" type="password" required minLength={12} autoComplete="new-password" />
          </Field>
          <Button>{t("Change password")}</Button>
        </form>
      </Panel>
    </>
  );
}
