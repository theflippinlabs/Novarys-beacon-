import { createSign } from "node:crypto";
import { ProviderHttpError } from "./types";

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/** OAuth 2.0 access token for a Google service account (JWT bearer grant, RS256). */
export async function googleAccessToken(serviceAccountJson: string, scopes: string[], fetchImpl: typeof fetch = fetch): Promise<string> {
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(serviceAccountJson);
  } catch {
    throw new Error("Service account JSON is invalid");
  }
  if (!sa.client_email || !sa.private_key) throw new Error("Service account JSON must contain client_email and private_key");
  const tokenUri = sa.token_uri ?? "https://oauth2.googleapis.com/token";
  if (!/^https:\/\/oauth2\.googleapis\.com\//.test(tokenUri)) throw new Error("Unexpected token_uri in service account");
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({ iss: sa.client_email, scope: scopes.join(" "), aud: tokenUri, iat: now, exp: now + 3600 }));
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${b64url(signer.sign(sa.private_key))}`;
  const res = await fetchImpl(tokenUri, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new ProviderHttpError("google-oauth", res.status, await res.text());
  const json = (await res.json()) as { access_token: string };
  return json.access_token;
}
