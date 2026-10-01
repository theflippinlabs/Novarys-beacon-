import { addCompetitorWatchAction, checkCompetitorWatchAction, removeCompetitorWatchAction, toggleCompetitorWatchAction } from "@/app/actions/intel";
import { Badge, Button, EmptyState, Field, HiddenBack, Panel, ResponsiveTable, Td, Th } from "@/components/ui";
import { WATCH_KINDS, type WatchDiff, type WatchStatus } from "@/core/competitors/watch";
import { enumLabel } from "@/i18n/core";
import { getT } from "@/i18n/server";
import type { SnapshotRow, WatchRow } from "@/services/competitor-watch";

const STATUS_TONE: Record<WatchStatus, "ok" | "warn" | "crit" | "muted" | "neutral"> = {
  PENDING: "neutral",
  OK: "ok",
  BLOCKED_BY_ROBOTS: "warn",
  HTTP_ERROR: "crit",
  NOT_HTML: "warn",
  FETCH_ERROR: "crit",
};

const when = (d: Date | null) => (d ? d.toISOString().slice(0, 16).replace("T", " ") : null);

async function DiffLines({ diff }: { diff: WatchDiff }) {
  const t = await getT();
  return (
    <div className="flex flex-col gap-1">
      <div className="num text-chrome">{t("{added} line(s) added, {removed} removed", { added: diff.linesAdded, removed: diff.linesRemoved })}</div>
      {diff.pricesAppeared.length > 0 && <div className="text-warn">{t("Prices that appeared: {list}", { list: diff.pricesAppeared.join(", ") })}</div>}
      {diff.pricesDisappeared.length > 0 && <div className="text-warn">{t("Prices that disappeared: {list}", { list: diff.pricesDisappeared.join(", ") })}</div>}
      {diff.added.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-ok">
          {diff.added.map((l, i) => (
            <li key={`a${i}`} className="break-words">
              + {l}
            </li>
          ))}
        </ul>
      )}
      {diff.removed.length > 0 && (
        <ul className="flex flex-col gap-0.5 text-crit">
          {diff.removed.map((l, i) => (
            <li key={`r${i}`} className="break-words">
              - {l}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

async function History({ snapshots }: { snapshots: SnapshotRow[] }) {
  const t = await getT();
  if (!snapshots.length) return null;
  return (
    <details className="mt-2">
      <summary className="cursor-pointer text-muted">{t("History ({n})", { n: snapshots.length })}</summary>
      <ol className="mt-2 flex flex-col gap-3">
        {snapshots.map((s) => (
          <li key={s.id} className="border-l border-line pl-2">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={s.kind === "CHANGED" ? "gold" : "muted"}>{enumLabel(t, s.kind)}</Badge>
              <span className="num text-muted">{when(s.fetchedAt)}</span>
            </div>
            {s.diff ? <DiffLines diff={s.diff} /> : <div className="text-muted">{t("First successful check: the reference for later changes.")}</div>}
          </li>
        ))}
      </ol>
    </details>
  );
}

/**
 * "Watched pages": competitor pages (pricing first) checked weekly,
 * robots.txt respected, one page each. A change is shown with a factual
 * diff and notified for human review; facts are never updated from it.
 */
export async function WatchedPages({
  watches,
  competitors,
  back,
  canEdit,
  canRun,
}: {
  watches: (WatchRow & { snapshots: SnapshotRow[] })[];
  competitors: { id: string; name: string; domain: string | null }[];
  back: string;
  canEdit: boolean;
  canRun: boolean;
}) {
  const t = await getT();
  return (
    <section id="watched-pages" className="mt-6 scroll-mt-20">
      <Panel title={t("Watched competitor pages")} eyebrow={t("Weekly check · robots.txt respected · changes need human review")} pad={false}>
        {competitors.length === 0 ? (
          <div className="p-4">
            <EmptyState
              variant="no_data_yet"
              what={t("No competitor to watch yet")}
              why={t("Add competitors to a product's knowledge first, then watch their pricing or feature pages here.")}
              action={{ label: t("Open products"), href: "/products" }}
            />
          </div>
        ) : watches.length === 0 ? (
          <div className="p-4">
            <EmptyState
              variant="not_generated"
              what={t("No competitor page watched yet")}
              why={t("Beacon can check a competitor's pricing or feature page once a week (robots.txt respected, one page, no crawling) and notify you when it changes. A change is never applied to your facts automatically.")}
              action={{ label: canEdit ? t("Add a page to watch") : t("Back to AI visibility"), href: canEdit ? "#watch-form" : back }}
            />
          </div>
        ) : (
          <ResponsiveTable>
            <thead>
              <tr>
                <Th>{t("Page")}</Th>
                <Th>{t("Status")}</Th>
                <Th>{t("Last checked")}</Th>
                <Th>{t("Last changed")}</Th>
                <Th>{t("Excerpt")}</Th>
                <Th />
              </tr>
            </thead>
            <tbody>
              {watches.map((w) => (
                <tr key={w.id} id={`watch-${w.id}`}>
                  <Td primary className="max-w-xs">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-platinum">{w.competitorName}</span>
                      <Badge tone="muted">{enumLabel(t, w.kind)}</Badge>
                      {!w.active && <Badge tone="muted">{t("paused")}</Badge>}
                    </div>
                    <a href={w.url} target="_blank" rel="noopener noreferrer nofollow" className="num break-all text-xs text-muted hover:text-blue-bright">
                      {w.url}
                    </a>
                    {w.finalUrl && w.finalUrl !== w.url && <div className="num break-all text-[11px] text-muted">{t("Redirects to {url}", { url: w.finalUrl })}</div>}
                  </Td>
                  <Td label={t("Status")} className="text-xs">
                    <Badge tone={STATUS_TONE[w.status]}>{enumLabel(t, w.status)}</Badge>
                    {w.httpStatus !== null && <span className="num ml-2 text-muted">{t("HTTP {code}", { code: w.httpStatus })}</span>}
                    {w.error && <div className="mt-1 break-words text-muted">{t(w.error)}</div>}
                  </Td>
                  <Td label={t("Last checked")} className="num text-xs">
                    {when(w.lastFetchedAt) ?? t("Never")}
                  </Td>
                  <Td label={t("Last changed")} className="num text-xs">
                    {when(w.lastChangedAt) ?? (w.contentHash ? t("No change since the first check") : t("n/a"))}
                  </Td>
                  <Td label={t("Excerpt")} className="max-w-md text-xs">
                    <p className="break-words text-chrome">{w.excerpt ?? t("n/a")}</p>
                    <History snapshots={w.snapshots} />
                  </Td>
                  <Td>
                    <div className="flex flex-wrap items-center gap-2">
                      {canRun && w.active && (
                        <form action={checkCompetitorWatchAction}>
                          <HiddenBack path={back} />
                          <input type="hidden" name="id" value={w.id} />
                          <Button>{t("Check now")}</Button>
                        </form>
                      )}
                      {canEdit && (
                        <form action={toggleCompetitorWatchAction}>
                          <HiddenBack path={back} />
                          <input type="hidden" name="id" value={w.id} />
                          <input type="hidden" name="active" value={w.active ? "false" : "true"} />
                          <button className="eyebrow hover:text-chrome">{w.active ? t("pause") : t("resume")}</button>
                        </form>
                      )}
                      {canEdit && (
                        <form action={removeCompetitorWatchAction}>
                          <HiddenBack path={back} />
                          <input type="hidden" name="id" value={w.id} />
                          <button className="eyebrow text-crit hover:text-chrome">{t("remove")}</button>
                        </form>
                      )}
                    </div>
                  </Td>
                </tr>
              ))}
            </tbody>
          </ResponsiveTable>
        )}
        {canEdit && competitors.length > 0 && (
          <form id="watch-form" action={addCompetitorWatchAction} className="grid gap-3 border-t border-line p-4 md:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_minmax(0,10rem)_auto] md:items-end">
            <HiddenBack path={back} />
            <Field label={t("Competitor")}>
              <select name="competitorId" required>
                {competitors.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label={t("Page URL (https)")}>
              <input name="url" type="url" required maxLength={2000} placeholder="https://competitor.example/pricing" />
            </Field>
            <Field label={t("Page type")}>
              <select name="kind" defaultValue="PRICING">
                {WATCH_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {enumLabel(t, k)}
                  </option>
                ))}
              </select>
            </Field>
            <div>
              <Button variant="gold">{t("Watch page")}</Button>
            </div>
          </form>
        )}
        <p className="px-4 pb-4 text-[11px] text-muted">
          {t("One page per watch, fetched at most weekly as NovarysBeacon; pages robots.txt disallows are never fetched. Excerpts and diffs are quoted from the page; review a change before updating any comparison fact.")}
        </p>
      </Panel>
    </section>
  );
}
