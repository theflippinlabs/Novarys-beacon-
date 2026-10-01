import { env } from "@/lib/env";

/**
 * Email adapter: Resend's HTTPS API (POST https://api.resend.com/emails).
 * Configured by RESEND_API_KEY and BEACON_EMAIL_FROM; without both, the
 * email channel is "Not connected" and nothing is sent. The endpoint is a
 * fixed, trusted host (not user supplied), so plain fetch is used.
 */
export const RESEND_ENDPOINT = "https://api.resend.com/emails";
export const EMAIL_NOT_CONNECTED = "Not connected: set RESEND_API_KEY and BEACON_EMAIL_FROM";

export type EmailMessage = { to: string; subject: string; text: string; html: string };
export type EmailConfig = { configured: boolean; provider: "RESEND"; from: string | null };

export function emailConfig(e: { RESEND_API_KEY?: string; BEACON_EMAIL_FROM?: string } = env()): EmailConfig {
  return { configured: Boolean(e.RESEND_API_KEY && e.BEACON_EMAIL_FROM), provider: "RESEND", from: e.BEACON_EMAIL_FROM ?? null };
}

export class EmailError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryable: boolean,
  ) {
    super(message);
    this.name = "EmailError";
  }
}

/** Send one email; throws EmailError (retryable on 429 and 5xx). */
export async function sendEmail(msg: EmailMessage, opts: { fetchImpl?: typeof fetch; apiKey?: string; from?: string } = {}): Promise<{ id: string | null }> {
  const e = env();
  const apiKey = opts.apiKey ?? e.RESEND_API_KEY;
  const from = opts.from ?? e.BEACON_EMAIL_FROM;
  if (!apiKey || !from) throw new EmailError(EMAIL_NOT_CONNECTED, 0, false);
  const res = await (opts.fetchImpl ?? fetch)(RESEND_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ from, to: [msg.to], subject: msg.subject, text: msg.text, html: msg.html }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 200);
    throw new EmailError(`Email provider answered ${res.status}${detail ? `: ${detail}` : ""}`, res.status, res.status === 429 || res.status >= 500);
  }
  const body = (await res.json().catch(() => ({}))) as { id?: string };
  return { id: body.id ?? null };
}
