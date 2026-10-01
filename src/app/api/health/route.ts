import { NextResponse } from "next/server";
import { systemHealth } from "@/services/health";
import { getAuthContext } from "@/lib/auth/session";
import { can } from "@/lib/auth/rbac";
import { env } from "@/lib/env";
import { safeEqual } from "@/lib/security/crypto";

export const dynamic = "force-dynamic";

/**
 * Liveness/readiness probe. Anonymous callers get only `{ status }`; queue and
 * database details are returned to signed-in admins, or to callers presenting
 * BEACON_HEALTH_SECRET in the `x-beacon-health-secret` header (monitoring).
 */
export async function GET(req: Request) {
  const h = await systemHealth();
  const code = h.db.ok ? 200 : 503;
  const headers = { "cache-control": "no-store" };
  if (!(await detailed(req))) return NextResponse.json({ status: h.status }, { status: code, headers });
  return NextResponse.json(
    { status: h.status, db: { ok: h.db.ok, latencyMs: h.db.latencyMs, migrations: h.db.migrations }, queue: h.queue, time: h.time },
    { status: code, headers },
  );
}

async function detailed(req: Request): Promise<boolean> {
  const secret = env().BEACON_HEALTH_SECRET;
  const given = req.headers.get("x-beacon-health-secret");
  if (secret && given && safeEqual(given, secret)) return true;
  if (!req.headers.get("cookie")) return false;
  const ctx = await getAuthContext().catch(() => null);
  return Boolean(ctx && can(ctx.role, "settings:manage"));
}
