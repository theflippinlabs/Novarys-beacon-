import Link from "next/link";
import type { Metadata } from "next";
import { EmptyState, Flash, HiddenBack, PageHeader, Panel, cx } from "@/components/ui";
import { BriefingBody } from "@/components/briefing/briefing";
import { generateBriefingAction } from "@/app/actions/reports";
import { isUuid } from "@/core/media/image";
import { pageData, sp1, type SP } from "@/lib/page";
import { getI18n, getT } from "@/i18n/server";
import { getBriefing, listBriefings } from "@/services/briefings";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("Briefings") };
}

const range = (s: Date, e: Date, intl: string) => {
  const f = (d: Date) => d.toLocaleString(intl, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });
  return `${f(s)} > ${f(e)}`;
};

export default async function BriefingsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const sp = await searchParams;
  const id = sp1(sp, "id");
  const { data, can } = await pageData(async (tx, ctx) => {
    const list = await listBriefings(tx, ctx.org.id);
    const selected = id && isUuid(id) ? await getBriefing(tx, ctx.org.id, id) : (list[0] ?? null);
    return { list, selected };
  });
  const { t, intl } = await getI18n();
  return (
    <>
      <PageHeader
        eyebrow={t("Overview / Briefings")}
        title={t("Daily briefings")}
        description={t("One briefing per day: what changed since the previous one and the five actions that matter most. Deterministic and measured; unconnected sources are shown as such.")}
        actions={
          can("job:run") ? (
            <form action={generateBriefingAction}>
              <HiddenBack path="/briefings" />
              <button className="inline-flex items-center gap-2 border border-gold bg-gradient-to-b from-gold-bright to-gold px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-obsidian hover:brightness-110">{t("Generate now")}</button>
            </form>
          ) : null
        }
      />
      <Flash searchParams={sp} />
      {!data.list.length ? (
        <EmptyState
          variant="not_generated"
          what={t("No briefing yet")}
          why={t("Beacon generates a briefing every day. Use Generate now to create the first one; the next ones compare with it.")}
          action={can("job:run") ? { label: t("Generate now"), form: { action: generateBriefingAction, back: "/briefings" } } : { label: t("Command center"), href: "/" }}
        />
      ) : (
        <div className="grid gap-6 xl:grid-cols-[18rem_1fr]">
          <Panel eyebrow={t("History")} title={t("{n} briefing(s)", { n: data.list.length })} pad={false}>
            <ol className="max-h-[70vh] overflow-y-auto">
              {data.list.map((b) => (
                <li key={b.id} className="border-b border-line/60 last:border-0">
                  <Link href={`/briefings?id=${b.id}`} aria-current={data.selected?.id === b.id ? "page" : undefined} className={cx("block px-4 py-2.5 text-xs hover:bg-panel-2", data.selected?.id === b.id ? "bg-blue/10 text-platinum" : "text-chrome")}>
                    <span className="num block">{range(b.periodStart, b.periodEnd, intl)}</span>
                    <span className="text-[11px] text-muted">{t("{n} action(s)", { n: b.topActions.length })}</span>
                  </Link>
                </li>
              ))}
            </ol>
          </Panel>
          {data.selected ? (
            <Panel eyebrow={t("Briefing")} title={range(data.selected.periodStart, data.selected.periodEnd, intl)}>
              <BriefingBody briefing={data.selected} />
            </Panel>
          ) : (
            <EmptyState variant="filtered" what={t("Briefing not found")} why={t("It may belong to another organisation or the link is incomplete.")} action={{ label: t("Latest briefing"), href: "/briefings" }} />
          )}
        </div>
      )}
    </>
  );
}
