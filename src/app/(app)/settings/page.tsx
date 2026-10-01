import { eq } from "drizzle-orm";
import type { Metadata } from "next";
import { updateContentPolicyAction } from "@/app/actions/content";
import { addMemberAction, changePasswordAction, changeRoleAction, removeMemberAction, setPublicSiteAction, updateOrgSettingsAction } from "@/app/actions/settings";
import { isPublicSiteEnabled } from "@/services/public";
import { Badge, Button, Field, Flash, HiddenBack, PageHeader, Panel, Table, Td, Th } from "@/components/ui";
import { SettingsTabs } from "@/components/shell/settings-tabs";
import { asSystem } from "@/db";
import { memberships, users } from "@/db/schema";
import { ROLES } from "@/lib/auth/rbac";
import { pageData, type SP } from "@/lib/page";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";
import { removeOrgLogoAction, uploadOrgLogoAction } from "@/app/actions/media";
import { ConfirmSubmit } from "@/components/media/media-controls";
import { PhotoUpload } from "@/components/media/photo-upload";
import { buildMediaUrl, mediaIdFromUrl } from "@/core/media/image";
import { env } from "@/lib/env";

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
  const logoId = ctx.org.branding.logoUrl ? mediaIdFromUrl(ctx.org.branding.logoUrl, [env().BEACON_BASE_URL]) : null;
  const orgLogo = logoId ? buildMediaUrl(logoId) : null;
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
                  <option value="LINEAR">{t("Linear")}</option>
                  <option value="POSITION_BASED">{t("Position-based (40/20/40)")}</option>
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
        <Panel title={t("Content approval")} eyebrow={ctx.org.settings.content?.requireDistinctApprover ? t("Four-eyes approval on") : t("Four-eyes approval off")}>
          <form action={updateContentPolicyAction} className="flex flex-col gap-3 text-sm text-chrome">
            <HiddenBack path={back} />
            <p>{t("Content is approved and published by members with the approve permission. Optionally, the approver of a version must be someone other than its author (enforced on the server).")}</p>
            <label className="flex items-center gap-2">
              <input type="checkbox" name="requireDistinctApprover" defaultChecked={Boolean(ctx.org.settings.content?.requireDistinctApprover)} disabled={!can("settings:manage")} /> {t("The approver must differ from the author")}
            </label>
            {can("settings:manage") && (
              <div>
                <Button>{t("Save")}</Button>
              </div>
            )}
          </form>
        </Panel>
        <Panel title={t("Public site")} eyebrow={isPublicSiteEnabled(ctx.org.settings) ? t("On||public site") : t("Off||public site")}>
          <div className="flex flex-col gap-3 text-sm text-chrome">
            <p>{t("Hosted pages, sitemap.xml, llms.txt, the entity and published APIs and the product finder (/ask) of this organisation. When off, they all answer 404.")}</p>
            <p className="font-mono text-xs">{`${env().BEACON_BASE_URL}/p/${ctx.org.slug}/`}</p>
            {can("settings:manage") && (
              <form action={setPublicSiteAction}>
                <HiddenBack path={back} />
                <input type="hidden" name="enabled" value={isPublicSiteEnabled(ctx.org.settings) ? "false" : "true"} />
                <Button variant={isPublicSiteEnabled(ctx.org.settings) ? undefined : "gold"}>{isPublicSiteEnabled(ctx.org.settings) ? t("Turn public site off") : t("Turn public site on")}</Button>
              </form>
            )}
          </div>
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
      <Panel title={t("Organisation logo")} eyebrow={t("Branding")} className="mt-6">
        <div className="grid gap-5 sm:grid-cols-[8rem_1fr]">
          <div className="flex h-32 w-32 items-center justify-center border border-line bg-obsidian p-2">
            {orgLogo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={orgLogo} alt={t("Current logo")} className="max-h-full max-w-full object-contain" />
            ) : (
              <span className="eyebrow">{t("No logo")}</span>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-3">
            <p className="text-sm text-chrome">{t("Shown with your organisation’s branding. Square PNG or WebP with transparency works best.")}</p>
            {ctx.org.branding.logoUrl && !orgLogo && (
              <p className="text-xs text-muted">
                {t("Current logo URL:")} <span className="num break-all">{ctx.org.branding.logoUrl}</span>
              </p>
            )}
            {can("settings:manage") && (
              <>
                <PhotoUpload key={ctx.org.branding.logoUrl ?? "none"} action={uploadOrgLogoAction} kind="logo">
                  <HiddenBack path={back} />
                </PhotoUpload>
                {ctx.org.branding.logoUrl && (
                  <form action={removeOrgLogoAction}>
                    <HiddenBack path={back} />
                    <ConfirmSubmit message={t("Remove the organisation logo?")}>{t("Remove logo")}</ConfirmSubmit>
                  </form>
                )}
              </>
            )}
          </div>
        </div>
      </Panel>
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
