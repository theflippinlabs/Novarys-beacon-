import { Tabs } from "@/components/ui";

export function ProductTabs({ slug, active }: { slug: string; active: "overview" | "knowledge" | "geo" | "tracking" | "onboarding" }) {
  const b = `/products/${slug}`;
  return (
    <Tabs
      active={active}
      items={[
        { key: "overview", label: "Dashboard", href: b },
        { key: "knowledge", label: "Knowledge graph", href: `${b}/knowledge` },
        { key: "geo", label: "GEO / Entity", href: `${b}/geo` },
        { key: "tracking", label: "Tracking", href: `${b}/tracking` },
        { key: "onboarding", label: "Onboarding", href: `${b}/onboarding?step=1` },
      ]}
    />
  );
}

export function RangePicker({ base, days }: { base: string; days: number }) {
  const sep = base.includes("?") ? "&" : "?";
  return (
    <div className="flex border border-line" role="group" aria-label="Date range">
      {[7, 28, 90].map((d) => (
        <a key={d} href={`${base}${sep}days=${d}`} className={`px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider ${d === days ? "bg-panel-2 text-platinum" : "text-muted hover:text-chrome"}`}>
          {d}d
        </a>
      ))}
    </div>
  );
}
