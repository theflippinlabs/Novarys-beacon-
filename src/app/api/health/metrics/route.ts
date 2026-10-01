import { NextResponse } from "next/server";
import { getAuthContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { snapshot } from "@/lib/metrics";

export const dynamic = "force-dynamic";

/** Per-instance latency and job metrics (authenticated). */
export async function GET() {
  const ctx = await getAuthContext();
  if (!ctx || !can(ctx.role, "audit:read")) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  return NextResponse.json(snapshot(), { headers: { "cache-control": "no-store" } });
}
