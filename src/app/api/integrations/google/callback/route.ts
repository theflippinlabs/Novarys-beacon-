import { getAuthContext } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { ipHashOf } from "@/lib/http";
import { googleOAuthCallback } from "@/services/google-oauth-flow";

export const dynamic = "force-dynamic";

/** Google OAuth redirect URI: verifies the signed state, stores the refresh token encrypted, lists properties. */
export async function GET(req: Request) {
  const sp = new URL(req.url).searchParams;
  const target = await googleOAuthCallback(await getAuthContext(), { code: sp.get("code"), state: sp.get("state"), error: sp.get("error") }, { ipHash: ipHashOf(req) });
  return Response.redirect(new URL(target, env().BEACON_BASE_URL), 303);
}
