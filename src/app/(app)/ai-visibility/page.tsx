import { desc, eq } from "drizzle-orm";
import { addPromptAction, runAiTestsAction, togglePromptAction } from "@/app/actions/growth";
import { Badge, Button, EmptyState, Field, Flash, HiddenBack, LinkButton, PageHeader, Panel, Table, Td, Th } from "@/components/ui";
import { LineChart } from "@/components/charts/line-chart";
import { aiVisibilityTests, products } from "@/db/schema";
import { availableProviders } from "@/ai/registry";
import { aiVisibilityTrend, promptSummaries } from "@/services/ai-visibility";
import { pageData, type SP } from "@/lib/page";

export const metadata = { title: "AI visibility" };

export default async function AiVisibilityPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
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
        eyebrow="07 / AI visibility"
        title="Observable AI visibility"
        description="Sampled observations: Beacon sends tracked questions to AI providers through their official APIs and records which products, competitors and sources appear. API answers can differ from consumer apps and between users — these are samples, not totals, and no placement can be guaranteed."
        actions={
          can("job:run") &&
          data.providers.length > 0 && (
            <form action={runAiTestsAction}>
              <HiddenBack path={back} />
              <Button variant="gold">Run all active prompts</Button>
            </form>
          )
        }
      />
      <Flash searchParams={sp} />
      {data.providers.length === 0 && (
        <div className="mb-6">
          <EmptyState title="No AI provider configured" action={<LinkButton href="/settings/integrations">Configure providers</LinkButton>}>
            Connect Anthropic, OpenAI or Perplexity API keys (stored encrypted) to run sampled tests. Prompts can be prepared now.
          </EmptyState>
        </div>
      )}
      <div className="grid gap-6 xl:grid-cols-[1fr_22rem]">
        <Panel title="Mention rate over time" eyebrow="Weekly · sampled">
          {data.trend.length ? (
            <LineChart
              title="Weekly sampled tests and tests mentioning the organisation"
              series={[
                { key: "t", label: "Tests run", color: "var(--color-s1)", points: data.trend.map((w) => ({ x: w.week, y: w.tests })) },
                { key: "m", label: "Mentioned", color: "var(--color-s2)", points: data.trend.map((w) => ({ x: w.week, y: w.mentioned })) },
                { key: "c", label: "Own domain cited", color: "var(--color-s3)", points: data.trend.map((w) => ({ x: w.week, y: w.cited })) },
              ]}
            />
          ) : (
            <p className="text-sm text-muted">No tests have run yet.</p>
          )}
          <p className="mt-3 text-xs text-muted">Providers: {data.providers.join(", ") || "none"}</p>
        </Panel>
        {can("query:write") && (
          <Panel title="Track a question">
            <form action={addPromptAction} className="flex flex-col gap-3">
              <HiddenBack path={back} />
              <Field label="Prompt">
                <textarea name="prompt" required minLength={5} className="min-h-20" placeholder="Best software for managing TikTok LIVE moderation" />
              </Field>
              <Field label="Product">
                <select name="productId" defaultValue="">
                  <option value="">Ecosystem</option>
                  {data.prods.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Category">
                <input name="category" placeholder="Commercial discovery" />
              </Field>
              <div>
                <Button>Add prompt</Button>
              </div>
            </form>
          </Panel>
        )}
      </div>

      <Panel title={`${data.summaries.length} tracked prompt(s)`} eyebrow="Last 90 days" className="mt-6" pad={false}>
        {data.summaries.length ? (
          <Table>
            <thead>
              <tr>
                <Th>Prompt</Th>
                <Th>Tests</Th>
                <Th>Mentioned</Th>
                <Th>Own domain cited</Th>
                <Th>Competitors observed</Th>
                <Th>Last position</Th>
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
                  <Td className="num text-xs" title="Order of first appearance among detected entities in the latest answer">
                    {s.last?.position ?? "—"}
                  </Td>
                  <Td>
                    <div className="flex items-center gap-2">
                      {can("job:run") && data.providers.length > 0 && s.prompt.active && (
                        <form action={runAiTestsAction}>
                          <HiddenBack path={back} />
                          <input type="hidden" name="promptId" value={s.prompt.id} />
                          <Button>Run</Button>
                        </form>
                      )}
                      {can("query:write") && (
                        <form action={togglePromptAction}>
                          <HiddenBack path={back} />
                          <input type="hidden" name="id" value={s.prompt.id} />
                          <input type="hidden" name="active" value={s.prompt.active ? "false" : "true"} />
                          <button className="eyebrow hover:text-chrome">{s.prompt.active ? "pause" : "resume"}</button>
                        </form>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        ) : (
          <p className="p-4 text-sm text-muted">No prompts tracked yet.</p>
        )}
      </Panel>

      <Panel title="Latest observations" eyebrow="Raw samples" className="mt-6">
        {data.recent.length ? (
          <ul className="flex flex-col gap-4">
            {data.recent.map((t) => (
              <li key={t.id} className="border-b border-line/60 pb-4">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  <Badge tone="muted">{t.label.replace(/_/g, " ")}</Badge>
                  <span className="num text-muted">{t.ranAt.toISOString().slice(0, 16).replace("T", " ")}</span>
                  <Badge>{t.provider}:{t.model}</Badge>
                  {t.orgMentioned ? <Badge tone="ok">mentioned</Badge> : <Badge tone="muted">not mentioned</Badge>}
                  {t.productsMentioned.map((p) => (
                    <Badge key={p.productId} tone="gold">
                      #{p.position} {p.name}
                    </Badge>
                  ))}
                  {t.competitorsMentioned.map((c) => (
                    <Badge key={c.competitorId}>
                      #{c.position} {c.name}
                    </Badge>
                  ))}
                </div>
                <details className="mt-2">
                  <summary className="cursor-pointer text-xs text-chrome">Response & {t.citations.length} citation(s)</summary>
                  <p className="mt-2 whitespace-pre-wrap text-xs text-chrome">{t.response.slice(0, 4000)}</p>
                  <ul className="mt-2 text-[11px] text-muted">
                    {t.citations.slice(0, 20).map((c) => (
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
          <p className="text-sm text-muted">No observations yet.</p>
        )}
      </Panel>
    </>
  );
}
