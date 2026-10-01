import { getT } from "@/i18n/server";

/** GET filter bar (works without JavaScript). */
export async function FilterBar({ action, children }: { action: string; children: React.ReactNode }) {
  const t = await getT();
  return (
    <form method="get" action={action} className="mb-6 flex flex-wrap items-end gap-3 border border-line bg-panel p-3">
      {children}
      <button className="border border-line-strong px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-platinum hover:border-chrome">{t("Apply")}</button>
    </form>
  );
}

export async function SelectFilter({ name, label, value, options, all }: { name: string; label: string; value?: string; options: { value: string; label: string }[]; all?: string }) {
  const t = await getT();
  return (
    <label className="flex min-w-40 flex-col gap-1">
      <span className="eyebrow">{label}</span>
      <select name={name} defaultValue={value ?? ""}>
        <option value="">{all ?? t("All")}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
