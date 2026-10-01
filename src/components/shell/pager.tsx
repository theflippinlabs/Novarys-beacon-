import Link from "next/link";
import { getT } from "@/i18n/server";

/**
 * "Showing N of M" with links to the next page and back to the first one.
 * `params` are the current filters; `param` is this list's cursor parameter
 * (several lists on one page use different names).
 */
export async function Pager({ path, params, param = "cursor", shown, total, next, current, anchor }: { path: string; params: Record<string, string | undefined>; param?: string; shown: number; total: number; next: string | null; current?: string | null; anchor?: string }) {
  const t = await getT();
  if (!current && !next && shown >= total) return total > 0 ? <p className="mt-3 text-xs text-muted">{t("Showing {n} of {total}", { n: shown, total })}</p> : null;
  const href = (cursor: string | null) => {
    const q = new URLSearchParams(Object.entries(params).filter(([k, v]) => v && k !== param) as [string, string][]);
    if (cursor) q.set(param, cursor);
    const s = q.toString();
    return `${path}${s ? `?${s}` : ""}${anchor ? `#${anchor}` : ""}`;
  };
  return (
    <nav aria-label={t("Pagination")} className="mt-3 flex flex-wrap items-center gap-3 text-xs text-muted">
      <span>{t("Showing {n} of {total}", { n: shown, total })}</span>
      {current && (
        <Link href={href(null)} className="text-blue-bright underline underline-offset-4">
          {t("First page")}
        </Link>
      )}
      {next && (
        <Link href={href(next)} className="text-blue-bright underline underline-offset-4">
          {t("Next {n} →", { n: 50 })}
        </Link>
      )}
    </nav>
  );
}
