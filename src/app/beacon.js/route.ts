import { env } from "@/lib/env";
import { trackerSource } from "@/lib/tracker";

export const dynamic = "force-dynamic";

export function GET() {
  const js = trackerSource(`${env().BEACON_BASE_URL}/api/v1/events`);
  return new Response(js, { headers: { "content-type": "application/javascript; charset=utf-8", "cache-control": "public, max-age=3600", "access-control-allow-origin": "*" } });
}
