import { Tabs } from "@/components/ui";
import { getT } from "@/i18n/server";

export async function ProductTabs({ slug, active }: { slug: string; active: "overview" | "knowledge" | "geo" | "tracking" | "launch" | "onboarding" }) {
  const t = await getT();
  const b = `/products/${slug}`;
  return (
    <Tabs
      active={active}
      items={[
        { key: "overview", label: t("Dashboard"), href: b },
        { key: "knowledge", label: t("Knowledge graph"), href: `${b}/knowledge` },
        { key: "geo", label: t("GEO / Entity"), href: `${b}/geo` },
        { key: "tracking", label: t("Tracking"), href: `${b}/tracking` },
        { key: "launch", label: t("Launch"), href: `${b}/launch` },
        { key: "onboarding", label: t("Onboarding"), href: `${b}/onboarding` },
      ]}
    />
  );
}

export async function RangePicker({ base, days }: { base: string; days: number }) {
  const t = await getT();
  const sep = base.includes("?") ? "&" : "?";
  return (
    <div className="flex border border-line" role="group" aria-label={t("Date range")}>
      {[7, 28, 90].map((d) => (
        <a key={d} href={`${base}${sep}days=${d}`} className={`inline-flex min-h-10 items-center px-3 py-1.5 font-mono md:min-h-0 text-[11px] uppercase tracking-wider ${d === days ? "bg-panel-2 text-platinum" : "text-muted hover:text-chrome"}`}>
          {t("{n}d", { n: d })}
        </a>
      ))}
    </div>
  );
}
