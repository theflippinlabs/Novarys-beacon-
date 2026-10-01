import { desc, eq } from "drizzle-orm";
import { addPromptAction, runAiTestsAction, togglePromptAction } from "@/app/actions/growth";
import { Badge, Button, EmptyState, Field, Flash, HiddenBack, LinkButton, PageHeader, Panel, Table, Td, Th } from "@/components/ui";
import { LineChart } from "@/components/charts/line-chart";
import { aiVisibilityTests, products } from "@/db/schema";
import { availableProviders } from "@/ai/registry";
import { aiVisibilityTrend, promptSummaries } from "@/services/ai-visibility";
import { pageData, type SP } from "@/lib/page";
import { enumLabel } from "@/i18n/core";
import { getI18n, getT } from "@/i18n/server";
import type { Metadata } from "next";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("AI visibility") };
}

export default async function AiVisibilityPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const { t } = await getI18n();
  const { data, can } = await pageData(async (tx, ctx) => {
    const prods = await tx.select().from(products).where(eq(products.organizationId, ctx.org.id)).orderBy(products.name);
    const summaries = await promptSummaries(tx, ctx.org.id);
    const trend = await aiVisibilityTrend(tx, ctx.org.id, 12);
    const recent = await tx.select().from(aiVisibilityTests).where(eq(aiVisibilityTests.organizationId, ctx.org.id)).orderBy(desc(aiVisibilityTests.ranAt)).limit(12);
    const providers = (await availableProviders(tx, ctx.org.id)).map((p) => `${p.label} (${p.model})`);
    return { prods, summaries, trend, recent, providers };
  });
  const back = "/ai-visibility";
  return (
    <>
      <PageHeader
        eyebrow={t("07 / AI visibility")}
        title={t("Observable AI visibility")}
        description={t("Sampled observations: Beacon sends tracked questions to AI providers through their official APIs and records which products, competitors and sources appear. API answers can differ from consumer apps and between users — these are samples, not totals, and no placement can be guaranteed.")}
        actions={
          can("job:run") &&
          data.providers.length > 0 && (
            <form action={runAiTestsAction}>
              <HiddenBack path={back} />
              <Button variant="gold">{t("Run all active prompts")}</Button>
            </form>
          )
        }
      />
      <Flash searchParams={sp} />
      {data.providers.length === 0 && (
        <div className="mb-6">
          <EmptyState title={t("No AI provider configured")} action={<LinkButton href="/settings/integrations">{t("Configure providers")}</LinkButton>}>
            {t("Connect Anthropic, OpenAI or Perplexity API keys (stored encrypted) to run sampled tests. Prompts can be prepared now.")}
          </EmptyState>
        </div>
      )}
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel title={t("Mention rate over time")} eyebrow={t("Weekly · sampled")}>
          {data.trend.length ? (
            <LineChart
              title={t("Weekly sampled tests and tests mentioning the organisation")}
              series={[
                { key: "t", label: t("Tests run"), color: "var(--color-s1)", points: data.trend.map((w) => ({ x: w.week, y: w.tests })) },
                { key: "m", label: t("Mentioned"), color: "var(--color-s2)", points: data.trend.map((w) => ({ x: w.week, y: w.mentioned })) },
                { key: "c", label: t("Own domain cited"), color: "var(--color-s3)", points: data.trend.map((w) => ({ x: w.week, y: w.cited })) },
              ]}
            />
          ) : (
            <p className="text-sm text-muted">{t("No tests have run yet.")}</p>
          )}
          <p className="mt-3 text-xs text-muted">{data.providers.length ? t("Providers: {list}", { list: data.providers.join(", ") }) : t("Providers: none")}</p>
        </Panel>
        {can("query:write") && (
          <Panel title={t("Track a question")}>
            <form action={addPromptAction} className="flex flex-col gap-3">
              <HiddenBack path={back} />
              <Field label={t("Prompt")}>
                <textarea name="prompt" required minLength={5} className="min-h-20" placeholder={t("Best software for managing TikTok LIVE moderation")} />
              </Field>
              <Field label={t("Product")}>
                <select name="productId" defaultValue="">
                  <option value="">{t("Ecosystem")}</option>
                  {data.prods.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label={t("Category")}>
                <input name="category" placeholder={t("Commercial discovery")} />
              </Field>
              <div>
                <Button>{t("Add prompt")}</Button>
              </div>
            </form>
          </Panel>
        )}
      </div>

      <Panel title={t("{n} tracked prompt(s)", { n: data.summaries.length })} eyebrow={t("Last 90 days")} className="mt-6" pad={false}>
        {data.summaries.length ? (
          <Table>
            <thead>
              <tr>
                <Th>{t("Prompt")}</Th>
                <Th>{t("Tests")}</Th>
                <Th>{t("Mentioned")}</Th>
                <Th>{t("Own domain cited")}</Th>
                <Th>{t("Competitors observed")}</Th>
                <Th>{t("Last position")}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {data.summaries.map((s) => (
                <tr key={s.prompt.id}>
                  <Td className="max-w-md">
                    <div className="text-platinum">{s.prompt.prompt}</div>
                    <div className="text-[11px] text-muted">{s.prompt.category ?? ""}</div>
                  </Td>
                  <Td className="num">{s.testsRun}</Td>
                  <Td className="num">{s.testsRun ? `${s.mentions}/${s.testsRun}` : "—"}</Td>
                  <Td className="num">{s.testsRun ? `${s.cited}/${s.testsRun}` : "—"}</Td>
                  <Td className="text-xs">{s.competitors.join(", ") || "—"}</Td>
                  <Td className="num text-xs" title={t("Order of first appearance among detected entities in the latest answer")}>
                    {s.last?.position ?? "—"}
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      {can("job:run") && data.providers.length > 0 && s.prompt.active && (
                        <form action={runAiTestsAction}>
                          <HiddenBack path={back} />
                          <input type="hidden" name="promptId" value={s.prompt.id} />
                          <Button>{t("Run")}</Button>
                        </form>
                      )}
                      {can("query:write") && (
                        <form action={togglePromptAction}>
                          <HiddenBack path={back} />
                          <input type="hidden" name="id" value={s.prompt.id} />
                          <input type="hidden" name="active" value={s.prompt.active ? "false" : "true"} />
                          <button className="eyebrow hover:text-chrome">{s.prompt.active ? t("pause") : t("resume")}</button>
                        </form>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="p-4 text-sm text-muted">{t("No prompts tracked yet.")}</p>
        )}
      </Panel>

      <Panel title={t("Latest observations")} eyebrow={t("Raw samples")} className="mt-6">
        {data.recent.length ? (
          <ul className="flex flex-col gap-4">
            {data.recent.map((obs) => (
              <li key={obs.id} className="border-b border-line/60 pb-4">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone="muted">{enumLabel(t, obs.label)}</Badge>
                  <span className="num text-muted">{obs.ranAt.toISOString().slice(0, 16).replace("T", " ")}</span>
                  <Badge>{obs.provider}:{obs.model}</Badge>
                  {obs.orgMentioned ? <Badge tone="ok">{t("mentioned")}</Badge> : <Badge tone="muted">{t("not mentioned")}</Badge>}
                  {obs.productsMentioned.map((p) => (
                    <Badge key={p.productId} tone="gold">
                      #{p.position} {p.name}
                    </Badge>
                  ))}
                  {obs.competitorsMentioned.map((c) => (
                    <Badge key={c.competitorId}>
                      #{c.position} {c.name}
                    </Badge>
                  ))}
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-chrome">{t("Response & {n} citation(s)", { n: obs.citations.length })}</summary>
                  <p className="mt-2 whitespace-pre-wrap text-xs text-chrome">{obs.response.slice(0, 4000)}</p>
                  <ul className="mt-2 text-[11px] text-muted">
                    {obs.citations.slice(0, 20).map((c) => (
                      <li key={c} className="num truncate">
                        {c}
                      </li>
                    ))}
                  </ul>
                </details>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">{t("No observations yet.")}</p>
        )}
      </Panel>
    </>
  );
}
