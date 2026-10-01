import { withOrg } from "@/db";
import { isUuid } from "@/core/media/image";
import { reportToCsv, reportToMarkdown } from "@/core/reports/report";
import { intlTag, isLocale, LOCALE_COOKIE, makeT, negotiate } from "@/i18n/core";
import { FR } from "@/i18n/fr";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { resolveSession } from "@/lib/auth/service";
import { getReport } from "@/services/reports";

export const dynamic = "force-dynamic";

const BASE = { "x-content-type-options": "nosniff", "cache-control": "private, no-store", "content-security-policy": "default-src 'none'" };

function cookieValue(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const notFound = () => new Response("Not found", { status: 404, headers: { ...BASE, "content-type": "text/plain; charset=utf-8" } });

/**
 * Export a stored report as CSV, Markdown or JSON (attachment). Signed-in
 * members only; the report is read inside the member's organisation scope
 * (RLS), so another organisation's report id answers 404.
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const ctx = await resolveSession(cookieValue(req, SESSION_COOKIE));
  if (!ctx) return new Response("Unauthorized", { status: 401, headers: { ...BASE, "content-type": "text/plain; charset=utf-8" } });
  const { id } = await params;
  if (!isUuid(id)) return notFound();
  const format = new URL(req.url).searchParams.get("format") ?? "csv";
  if (!["csv", "md", "json"].includes(format)) return new Response("Unsupported format", { status: 400, headers: { ...BASE, "content-type": "text/plain; charset=utf-8" } });
  const report = await withOrg(ctx.org.id, (tx) => getReport(tx, ctx.org.id, id.toLowerCase()));
  if (!report) return notFound();
  const c = cookieValue(req, LOCALE_COOKIE);
  const locale = isLocale(c) ? c : negotiate(req.headers.get("accept-language"));
  const t = makeT(locale === "fr" ? FR : null);
  const base = `beacon-weekly-report-${report.periodStart}_${report.periodEnd}`;
  const [body, type, ext] =
    format === "json"
      ? [JSON.stringify({ id: report.id, kind: report.kind, ...report.payload }, null, 2), "application/json; charset=utf-8", "json"]
      : format === "md"
        ? [reportToMarkdown(report.payload, t, intlTag(locale)), "text/markdown; charset=utf-8", "md"]
        : [`﻿${reportToCsv(report.payload, t)}`, "text/csv; charset=utf-8", "csv"];
  return new Response(body, { status: 200, headers: { ...BASE, "content-type": type, "content-disposition": `attachment; filename="${base}.${ext}"` } });
}
