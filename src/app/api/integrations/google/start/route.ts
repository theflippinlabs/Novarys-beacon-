import { getAuthContext } from "@/lib/auth/session";
import { env } from "@/lib/env";
import { googleOAuthStart } from "@/services/google-oauth-flow";

export const dynamic = "force-dynamic";

/** "Connect with Google" for Search Console: redirects to Google's consent screen with a signed state. */
export async function GET(req: Request) {
  const productId = new URL(req.url).searchParams.get("productId");
  const target = await googleOAuthStart(await getAuthContext(), productId);
  return Response.redirect(target.startsWith("https://") ? target : new URL(target, env().BEACON_BASE_URL), 303);
}
