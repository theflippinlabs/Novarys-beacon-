import { and, eq } from "drizzle-orm";
import { withOrg } from "@/db";
import { products } from "@/db/schema";
import type { AuthContext } from "@/lib/auth/service";
import { can } from "@/lib/auth/rbac";
import { authorizationUrl, exchangeCode, googleOAuthClient, listSearchConsoleSites, signOAuthState, verifyOAuthState, type GoogleOAuthClient } from "@/integrations/google-oauth";
import { sanitizeProviderMessage } from "@/integrations/types";
import { connectGoogleOAuth } from "./integration-health";

const SETTINGS = "/settings/integrations";
const flash = (kind: "ok" | "error", msg: string) => `${SETTINGS}?${kind}=${encodeURIComponent(msg.slice(0, 300))}`;

/** Where "Connect with Google" sends the browser (a Google consent URL, or back to settings with a reason). */
export async function googleOAuthStart(ctx: AuthContext | null, productId: string | null, client: GoogleOAuthClient | null = googleOAuthClient()): Promise<string> {
  if (!ctx) return "/login";
  if (!can(ctx.role, "integration:manage")) return flash("error", "You do not have permission to do that.");
  if (!client) return flash("error", "Not configured: add the Google OAuth client");
  if (!productId || !/^[0-9a-f-]{36}$/i.test(productId)) return flash("error", "Select a product for this integration.");
  const product = await withOrg(ctx.org.id, (tx) => tx.query.products.findFirst({ where: and(eq(products.id, productId), eq(products.organizationId, ctx.org.id)) }));
  if (!product) return flash("error", "Product not found");
  return authorizationUrl(client, signOAuthState({ organizationId: ctx.org.id, userId: ctx.user.id, productId: product.id }));
}

/**
 * Google redirects here. The state must be signed by Beacon, unexpired and
 * bound to the signed-in user and organisation. Token exchange and the
 * property listing happen before any transaction is opened.
 */
export async function googleOAuthCallback(
  ctx: AuthContext | null,
  params: { code: string | null; state: string | null; error: string | null },
  opts: { client?: GoogleOAuthClient | null; fetchImpl?: typeof fetch; ipHash?: string } = {},
): Promise<string> {
  if (!ctx) return "/login";
  const client = opts.client === undefined ? googleOAuthClient() : opts.client;
  if (!client) return flash("error", "Not configured: add the Google OAuth client");
  const state = verifyOAuthState(params.state, { organizationId: ctx.org.id, userId: ctx.user.id });
  if (!state) return flash("error", "The Google authorisation request is invalid or has expired. Try again.");
  if (!can(ctx.role, "integration:manage")) return flash("error", "You do not have permission to do that.");
  if (params.error || !params.code) return flash("error", "Google authorisation was cancelled.");
  try {
    const fetchImpl = opts.fetchImpl ?? fetch;
    const tokens = await exchangeCode(client, params.code, fetchImpl);
    const sites = await listSearchConsoleSites(tokens.accessToken, fetchImpl);
    const actor = { organizationId: ctx.org.id, userId: ctx.user.id, actorType: "USER" as const, ipHash: opts.ipHash };
    const res = await connectGoogleOAuth((fn) => withOrg(ctx.org.id, fn), actor, { productId: state.p, refreshToken: tokens.refreshToken, scopes: tokens.scopes, sites });
    if (!sites.length) return flash("error", "Connected to Google, but this account has no verified Search Console property.");
    if (res.needsSite) return `${flash("ok", "Connected to Google. Choose the Search Console property.")}#integration-${res.integrationId}`;
    if (res.test && !res.test.ok) return flash("error", `Connection test failed: ${res.test.message}`);
    return flash("ok", "Connected to Google Search Console. History import (16 months) is queued.");
  } catch (e) {
    return flash("error", `Google connection failed: ${sanitizeProviderMessage((e as Error).message)}`);
  }
}
