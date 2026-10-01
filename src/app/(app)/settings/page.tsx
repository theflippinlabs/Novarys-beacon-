import { eq } from "drizzle-orm";
import { addMemberAction, changeRoleAction, removeMemberAction, updateOrgSettingsAction } from "@/app/actions/settings";
import { Badge, Button, Field, Flash, HiddenBack, PageHeader, Panel, Table, Td, Th } from "@/components/ui";
import { SettingsTabs } from "@/components/shell/settings-tabs";
import { asSystem } from "@/db";
import { memberships, users } from "@/db/schema";
import { ROLES } from "@/lib/auth/rbac";
import { pageData, type SP } from "@/lib/page";

export const metadata = { title: "Settings" };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { ctx, can } = await pageData(async () => null);
  // Membership rows join the global users table; read them with system privileges, scoped to this org.
  const members = await asSystem((tx) =>
    tx.select({ userId: users.id, email: users.email, name: users.name, role: memberships.role, lastLoginAt: users.lastLoginAt }).from(memberships).innerJoin(users, eq(users.id, memberships.userId)).where(eq(memberships.organizationId, ctx.org.id)),
  );
  const attr = ctx.org.settings.attribution ?? { model: "LAST_TOUCH", lookbackDays: 30, referralPrecedence: true };
  const back = "/settings";
  return (
    <>
      <PageHeader eyebrow="13 / Settings" title="Settings" description={`Organisation “${ctx.org.name}” (${ctx.org.slug}). Beacon is multi-tenant: every record is organisation-scoped and protected by row-level security.`} />
      <SettingsTabs active="org" />
      <Flash searchParams={sp} />
      <div className="grid gap-6 xl:grid-cols-2">
        <Panel title="Organisation & attribution rules">
          <form action={updateOrgSettingsAction} className="flex flex-col gap-4">
            <HiddenBack path={back} />
            <Field label="Display name">
              <input name="displayName" defaultValue={ctx.org.branding.displayName ?? ctx.org.name} disabled={!can("settings:manage")} />
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Attribution model">
                <select name="model" defaultValue={attr.model} disabled={!can("settings:manage")}>
                  <option value="LAST_TOUCH">Last non-direct touch</option>
                  <option value="FIRST_TOUCH">First touch</option>
                </select>
              </Field>
              <Field label="Lookback window (days)">
                <input name="lookbackDays" type="number" min={1} max={180} defaultValue={attr.lookbackDays} disabled={!can("settings:manage")} />
              </Field>
            </div>
            <label className="flex items-center gap-2 text-sm text-chrome">
              <input type="checkbox" name="referralPrecedence" defaultChecked={attr.referralPrecedence} disabled={!can("settings:manage")} /> Referral / affiliate touches take precedence within the window
            </label>
            <Field label="Cross-sell: max recommendations per identity per day">
              <input name="crossSellDailyCap" type="number" min={0} max={10} defaultValue={ctx.org.settings.crossSell?.globalDailyCap ?? 1} disabled={!can("settings:manage")} />
            </Field>
            {can("settings:manage") && (
              <div>
                <Button variant="gold">Save</Button>
              </div>
            )}
          </form>
        </Panel>
        <Panel title="Roles" eyebrow="RBAC">
          <Table>
            <tbody>
              <tr><Th>Owner</Th><Td className="text-xs">Everything, including owners and billing-grade settings.</Td></tr>
              <tr><Th>Admin</Th><Td className="text-xs">Approve & publish content, approve external submissions and recommendations, manage integrations, API keys, members and revenue.</Td></tr>
              <tr><Th>Editor</Th><Td className="text-xs">Edit knowledge graph, create content and distribution targets, experiments and cross-sell rules.</Td></tr>
              <tr><Th>Analyst</Th><Td className="text-xs">Run audits, AI tests and analyses; manage queries; read audit log.</Td></tr>
              <tr><Th>Viewer</Th><Td className="text-xs">Read-only.</Td></tr>
            </tbody>
          </Table>
        </Panel>
      </div>
      <Panel title={`${members.length} member(s)`} eyebrow="Team" className="mt-6" pad={false}>
        <Table>
          <thead>
            <tr>
              <Th>Name</Th>
              <Th>Email</Th>
              <Th>Role</Th>
              <Th>Last login</Th>
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
                      <select name="role" defaultValue={m.role} className="!w-32" aria-label="Role">
                        {ROLES.map((r) => (
                          <option key={r}>{r}</option>
                        ))}
                      </select>
                      <Button>Set</Button>
                    </form>
                  ) : (
                    <Badge>{m.role}</Badge>
                  )}
                </Td>
                <Td className="num text-xs">{m.lastLoginAt?.toISOString().slice(0, 16).replace("T", " ") ?? "never"}</Td>
                <Td>
                  {can("member:manage") && m.userId !== ctx.user.id && (
                    <form action={removeMemberAction}>
                      <HiddenBack path={back} />
                      <input type="hidden" name="userId" value={m.userId} />
                      <Button variant="danger">Remove</Button>
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
            <input name="name" placeholder="Name" required aria-label="Name" />
            <input name="email" type="email" placeholder="Email" required aria-label="Email" />
            <select name="role" defaultValue="VIEWER" aria-label="Role">
              {ROLES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
            <input name="password" type="password" placeholder="Initial password (new users)" autoComplete="new-password" aria-label="Initial password" />
            <Button>Add member</Button>
          </form>
        )}
      </Panel>
    </>
  );
}
