import { NextResponse } from "next/server";
import { systemHealth } from "@/services/health";

export const dynamic = "force-dynamic";

/** Liveness/readiness probe. Exposes no tenant data. */
export async function GET() {
  const h = await systemHealth();
  return NextResponse.json({ status: h.status, db: { ok: h.db.ok, latencyMs: h.db.latencyMs }, queue: h.queue && { queued: h.queue.queued, running: h.queue.running, workerStale: h.queue.workerStale }, time: h.time }, { status: h.db.ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
