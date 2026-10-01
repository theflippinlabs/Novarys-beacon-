import { desc, eq } from "drizzle-orm";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PageHeader, Panel, Table, Td, Th, Badge } from "@/components/ui";
import { SettingsTabs } from "@/components/shell/settings-tabs";
import { auditLogs } from "@/db/schema";
import { pageData } from "@/lib/page";
import { getI18n, getT } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Audit log") };
}

export default async function AuditLogPage() {
  const { data, can } = await pageData(async (tx, ctx) => tx.select().from(auditLogs).where(eq(auditLogs.organizationId, ctx.org.id)).orderBy(desc(auditLogs.createdAt)).limit(300));
  if (!can("audit:read")) redirect("/settings");
  const { t } = await getI18n();
  return (
    <>
      <PageHeader eyebrow={t("13 / Settings")} title={t("Audit log")} description={t("Append-only record of security- and content-relevant actions. Metadata is redacted; credentials are never logged.")} />
      <SettingsTabs active="audit" />
      <Panel title={t("Latest {n} events", { n: data.length })} pad={false}>
        <Table>
          <thead>
            <tr>
              <Th>{t("Time")}</Th>
              <Th>{t("Action")}</Th>
              <Th>{t("Entity")}</Th>
              <Th>{t("Actor")}</Th>
              <Th>{t("Metadata")}</Th>
            </tr>
          </thead>
          <tbody>
            {data.map((a) => (
              <tr key={a.id}>
                <Td className="num whitespace-nowrap text-xs">{a.createdAt.toISOString().slice(0, 19).replace("T", " ")}</Td>
                <Td>
                  <Badge>{a.action}</Badge>
                </Td>
                <Td className="num text-[11px]">
                  {a.entityType}
                  <div className="text-muted">{a.entityId}</div>
                </Td>
                <Td className="num text-[11px]">
                  {a.actorType}
                  <div className="text-muted">{a.actorUserId?.slice(0, 8)}</div>
                </Td>
                <Td className="num max-w-md break-all text-[10px] text-muted">{JSON.stringify(a.metadata)}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>
    </>
  );
}
