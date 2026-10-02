import { createSign } from "node:crypto";
import { ProviderHttpError } from "./types";

type ServiceAccount = { client_email: string; private_key: string; token_uri?: string };

const b64url = (b: Buffer | string) => Buffer.from(b).toString("base64url");

/**
 * Service account JSON as pasted by a person: phones often turn straight
 * quotes into typographic ones and add invisible characters or text around
 * the object. Keep only the outermost object and undo those substitutions
 * (none of them can appear in a valid key file).
 */
export function normalizeServiceAccountJson(raw: string): string {
  let s = raw
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB]/g, '"')
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")
    .replace(/[\u00A0\u2007\u202F]/g, " ")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "");
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return s.trim();
}

/** Escape raw line breaks and tabs inside string literals (a paste can turn the key's "\\n" escapes into real line breaks). */
function escapeControlCharsInStrings(json: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of json) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      else if (ch === "\n") {
        out += "\\n";
        continue;
      } else if (ch === "\r") continue;
      else if (ch === "\t") {
        out += "\\t";
        continue;
      }
    } else if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

/** Parse a pasted service account key; throws the user-facing messages. */
export function parseServiceAccount(raw: string): ServiceAccount {
  const text = normalizeServiceAccountJson(raw);
  let sa: ServiceAccount;
  try {
    sa = JSON.parse(text);
  } catch {
    try {
      sa = JSON.parse(escapeControlCharsInStrings(text));
    } catch {
      // A key file always ends with "}" after "client_x509_cert_url" / "universe_domain": a paste that stops early is the usual cause.
      if (text.startsWith("{") && !text.endsWith("}")) throw new Error("Service account JSON looks cut off: the file content was not pasted completely. Load the file with Choose the JSON file instead.");
      throw new Error("Service account JSON is invalid");
    }
  }
  if (!sa || typeof sa !== "object" || !sa.client_email || !sa.private_key) throw new Error("Service account JSON must contain client_email and private_key");
  return sa;
}

/** OAuth 2.0 access token for a Google service account (JWT bearer grant, RS256). */
export async function googleAccessToken(serviceAccountJson: string, scopes: string[], fetchImpl: typeof fetch = fetch): Promise<string> {
  const sa = parseServiceAccount(serviceAccountJson);
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
