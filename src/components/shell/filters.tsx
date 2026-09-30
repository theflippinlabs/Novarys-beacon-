/** GET filter bar (works without JavaScript). */
export function FilterBar({ action, children }: { action: string; children: React.ReactNode }) {
  return (
    <form method="get" action={action} className="mb-6 flex flex-wrap items-end gap-3 border border-line bg-panel p-3">
      {children}
      <button className="border border-line-strong px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.14em] text-platinum hover:border-chrome">Apply</button>
    </form>
  );
}

export function SelectFilter({ name, label, value, options, all = "All" }: { name: string; label: string; value?: string; options: { value: string; label: string }[]; all?: string }) {
  return (
    <label className="flex min-w-40 flex-col gap-1">
      <span className="eyebrow">{label}</span>
      <select name={name} defaultValue={value ?? ""}>
        <option value="">{all}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
