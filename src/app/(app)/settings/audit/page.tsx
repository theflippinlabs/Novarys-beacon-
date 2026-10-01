import { desc, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { PageHeader, Panel, Table, Td, Th, Badge } from "@/components/ui";
import { SettingsTabs } from "@/components/shell/settings-tabs";
import { auditLogs } from "@/db/schema";
import { pageData } from "@/lib/page";

export const metadata = { title: "Audit log" };

export default async function AuditLogPage() {
  const { data, can } = await pageData(async (tx, ctx) => tx.select().from(auditLogs).where(eq(auditLogs.organizationId, ctx.org.id)).orderBy(desc(auditLogs.createdAt)).limit(300));
  if (!can("audit:read")) redirect("/settings");
  return (
    <>
      <PageHeader eyebrow="13 / Settings" title="Audit log" description="Append-only record of security- and content-relevant actions. Metadata is redacted; credentials are never logged." />
      <SettingsTabs active="audit" />
      <Panel title={`Latest ${data.length} events`} pad={false}>
        <Table>
          <thead>
            <tr>
              <Th>Time</Th>
              <Th>Action</Th>
              <Th>Entity</Th>
              <Th>Actor</Th>
              <Th>Metadata</Th>
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
