import { and, desc, eq, sql } from "drizzle-orm";
import type { Metadata } from "next";
import { retryJobAction } from "@/app/actions/settings";
import { Button, Flash, HiddenBack, KV, PageHeader, Panel, StatusBadge, Table, Td, Th } from "@/components/ui";
import { SettingsTabs } from "@/components/shell/settings-tabs";
import { db } from "@/db";
import { integrations, jobs } from "@/db/schema";
import { snapshot } from "@/lib/metrics";
import { systemHealth } from "@/services/health";
import { pageData, type SP } from "@/lib/page";
import { getI18n, getT } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("System health") };
}

export default async function HealthPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { t, intl } = await getI18n();
  const { ctx, data, can } = await pageData(async (tx, ctx) => tx.select().from(integrations).where(eq(integrations.organizationId, ctx.org.id)));
  const health = await systemHealth();
  // Jobs table is not RLS-protected (system queue); always scope to the current org explicitly.
  const recent = await db().select().from(jobs).where(eq(jobs.organizationId, ctx.org.id)).orderBy(desc(jobs.createdAt)).limit(40);
  const failing = await db().select().from(jobs).where(and(eq(jobs.organizationId, ctx.org.id), sql`${jobs.status} in ('DEAD','QUEUED') and ${jobs.lastError} is not null`)).orderBy(desc(jobs.createdAt)).limit(20);
  const byType = await db().execute<{ type: string; ok: number; dead: number; avg_s: number | null }>(sql`
    select type, count(*) filter (where status = 'SUCCEEDED')::int as ok, count(*) filter (where status = 'DEAD')::int as dead,
      avg(extract(epoch from finished_at - started_at)) filter (where status = 'SUCCEEDED')::float as avg_s
    from jobs where organization_id = ${ctx.org.id} and created_at >= now() - interval '7 days' group by type order by type`);
  const metrics = snapshot();
  const back = "/settings/health";
  return (
    <>
      <PageHeader
        eyebrow={t("13 / Settings")}
        title={t("System health")}
        description={t("Database, background jobs, integrations and API latency. Structured JSON logs go to stdout; set BEACON_ERROR_WEBHOOK_URL to forward errors to your tracker.")}
      />
      <SettingsTabs active="health" />
      <Flash searchParams={sp} />
      <div className="grid gap-6 lg:grid-cols-3">
        <Panel title={t("Overall")} eyebrow={t("Status")}>
          <div className="mb-4">
            <StatusBadge status={health.status === "ok" ? "SUCCEEDED" : health.status === "degraded" ? "NEEDS_REVIEW" : "FAILED"} />
          </div>
          <KV
            items={[
              [t("Database"), health.db.ok ? t("ok · {ms} ms", { ms: health.db.latencyMs }) : t("unreachable")],
              [t("Migrations applied"), health.db.migrations],
              [t("Checked"), health.time.slice(0, 19).replace("T", " ")],
            ]}
          />
        </Panel>
        <Panel title={t("Job queue")} eyebrow={t("Worker")}>
          {health.queue && (
            <KV
              items={[
                [t("Queued (due)"), health.queue.queued],
                [t("Running"), health.queue.running],
                [t("Retrying"), health.queue.retrying],
                [t("Dead (24h)"), health.queue.dead24h],
                [t("Oldest queued"), health.queue.oldestQueuedSeconds === null ? t("n/a") : t("{n}s", { n: health.queue.oldestQueuedSeconds })],
                [t("Last job started"), health.queue.lastJobStartedAt?.slice(0, 19) ?? t("never")],
              ]}
            />
          )}
          {health.queue?.workerStale && <p className="mt-3 text-xs text-warn">◐ {t("Jobs are waiting > 10 minutes. Is the worker running? (`pnpm worker` or BEACON_EMBEDDED_WORKER=true)")}</p>}
        </Panel>
        <Panel title={t("Integration health")} eyebrow={t("Sync")}>
          <ul className="flex flex-col gap-2">
            {data.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="text-chrome">{i.provider.replace(/_/g, " ")}</span>
                <span className="num text-muted">{i.lastSyncAt?.toISOString().slice(0, 16).replace("T", " ") ?? t("never")}</span>
                <StatusBadge status={i.status} />
              </li>
            ))}
            {!data.length && <li className="text-sm text-muted">{t("No integrations.")}</li>}
          </ul>
        </Panel>
      </div>
      <div className="mt-6 grid gap-6 xl:grid-cols-2">
        <Panel title={t("Jobs by type · 7 days")} pad={false}>
          <Table>
            <thead>
              <tr>
                <Th>{t("Type")}</Th>
                <Th>{t("Succeeded")}</Th>
                <Th>{t("Dead")}</Th>
                <Th>{t("Avg duration")}</Th>
              </tr>
            </thead>
            <tbody>
              {byType.rows.map((r) => (
                <tr key={r.type}>
                  <Td className="num text-xs">{r.type}</Td>
                  <Td className="num">{r.ok}</Td>
                  <Td className={`num ${Number(r.dead) ? "text-crit" : ""}`}>{r.dead}</Td>
                  <Td className="num">{r.avg_s === null ? t("n/a") : t("{n}s", { n: Number(r.avg_s).toLocaleString(intl, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }) })}</Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Panel>
        <Panel title={t("API latency · this instance since {since}", { since: metrics.since.slice(0, 16).replace("T", " ") })} pad={false}>
          <Table>
            <thead>
              <tr>
                <Th>{t("Route")}</Th>
                <Th>{t("Requests")}</Th>
                <Th>{t("Avg")}</Th>
                <Th>p95</Th>
                <Th>5xx</Th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(metrics.routes).map(([route, m]) => (
                <tr key={route}>
                  <Td className="num text-xs">{route}</Td>
                  <Td className="num">{m.count}</Td>
                  <Td className="num">{m.avgMs} ms</Td>
                  <Td className="num">≤ {m.p95Ms} ms</Td>
                  <Td className="num">{m.errors}</Td>
                </tr>
              ))}
              {!Object.keys(metrics.routes).length && (
                <tr>
                  <Td colSpan={5} className="text-muted">
                    {t("No public API traffic recorded on this instance yet.")}
                  </Td>
                </tr>
              )}
            </tbody>
          </Table>
        </Panel>
      </div>
      <Panel title={t("Failures & retries")} eyebrow={t("Jobs with errors")} className="mt-6" pad={false}>
        <Table>
          <tbody>
            {failing.map((j) => (
              <tr key={j.id}>
                <Td className="num text-xs">{j.type}</Td>
                <Td>
                  <StatusBadge status={j.status} />
                </Td>
                <Td className="num text-xs">
                  {j.attempts}/{j.maxAttempts}
                </Td>
                <Td className="max-w-lg text-xs text-crit">{j.lastError}</Td>
                <Td>
                  {can("job:run") && j.status === "DEAD" && (
                    <form action={retryJobAction}>
                      <HiddenBack path={back} />
                      <input type="hidden" name="id" value={j.id} />
                      <Button>{t("Retry")}</Button>
                    </form>
                  )}
                </Td>
              </tr>
            ))}
            {!failing.length && (
              <tr>
                <Td className="text-muted">{t("No failing jobs.")}</Td>
              </tr>
            )}
          </tbody>
        </Table>
      </Panel>
      <Panel title={t("Recent jobs")} className="mt-6" pad={false}>
        <Table>
          <thead>
            <tr>
              <Th>{t("Created")}</Th>
              <Th>{t("Type")}</Th>
              <Th>{t("Status")}</Th>
              <Th>{t("Attempts")}</Th>
              <Th>{t("Duration")}</Th>
            </tr>
          </thead>
          <tbody>
            {recent.map((j) => (
              <tr key={j.id}>
                <Td className="num text-xs">{j.createdAt.toISOString().slice(0, 19).replace("T", " ")}</Td>
                <Td className="num text-xs">{j.type}</Td>
                <Td>
                  <StatusBadge status={j.status} />
                </Td>
                <Td className="num">{j.attempts}</Td>
                <Td className="num text-xs">{j.startedAt && j.finishedAt ? t("{n}s", { n: ((j.finishedAt.getTime() - j.startedAt.getTime()) / 1000).toLocaleString(intl, { minimumFractionDigits: 1, maximumFractionDigits: 1, useGrouping: false }) }) : t("n/a")}</Td>
              </tr>
            ))}
          </tbody>
        </Table>
      </Panel>
    </>
  );
}
