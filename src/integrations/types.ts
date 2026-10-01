export type MetricRow = { metric: string; day: string; dimension?: string; value: number; weight?: number | null };

export type DateRange = { start: string; end: string };

export type ConfigField = { key: string; label: string; placeholder?: string; required: boolean; hint?: string };
export type SecretField = { key: string; label: string; multiline?: boolean; hint?: string };

/**
 * What a search adapter can deliver as normalized rows:
 * daily totals, per query, per page, per country, per device.
 */
export const SEARCH_CAPABILITIES = ["daily", "query", "page", "country", "device"] as const;
export type SearchCapability = (typeof SEARCH_CAPABILITIES)[number];

/**
 * One normalized search row (provider-independent). The grain is given by the
 * dimensions that are set: all null = daily total; query only; page only;
 * query + page; country only; device only. `position` is null when the
 * provider reports none (e.g. Bing site totals). `ctr` is a ratio (0..1).
 */
export type SearchRow = {
  day: string;
  query: string | null;
  page: string | null;
  country: string | null;
  device: string | null;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number | null;
};

export type SearchFetchOptions = {
  /** Only keep pages starting with this URL prefix (one property serving several products). */
  pagePrefix?: string | null;
  /** Pause between paginated provider calls (quota friendliness). */
  delayMs?: number;
};

export type ConnectionTest = {
  ok: boolean;
  message: string;
  /** HTTP status of the failing provider call, when known (401/403 means expired or revoked access). */
  httpStatus?: number;
  /** Scopes / permissions observed for the connection. */
  scopes?: string[];
};

/**
 * Visibility provider adapter. Beacon core never calls a vendor API directly;
 * it goes through this interface so providers can be swapped or added
 * without touching the rest of the system. Search adapters return
 * normalized `SearchRow`s only: no provider-specific shapes leak to services.
 */
export interface VisibilityAdapter {
  readonly provider: "GOOGLE_SEARCH_CONSOLE" | "GOOGLE_ANALYTICS" | "BING_WEBMASTER";
  readonly label: string;
  readonly configFields: ConfigField[];
  readonly secretFields: SecretField[];
  readonly docsUrl: string;
  /** Search row capabilities; empty for non-search providers. */
  readonly capabilities?: readonly SearchCapability[];
  /** How history is imported on first connect: months back, and whether to split it into monthly chunks. */
  readonly backfill?: { months: number; chunked: boolean };
  testConnection(config: Record<string, string>, secret: Record<string, string>): Promise<ConnectionTest>;
  fetchMetrics(config: Record<string, string>, secret: Record<string, string>, range: DateRange): Promise<MetricRow[]>;
  fetchSearchRows?(config: Record<string, string>, secret: Record<string, string>, range: DateRange, opts?: SearchFetchOptions): Promise<SearchRow[]>;
  /** Analytics providers (GA4): daily rows per report grain, stored in analytics_daily. */
  fetchAnalyticsDaily?(config: Record<string, string>, secret: Record<string, string>, range: DateRange): Promise<AnalyticsRow[]>;
}

/**
 * One GA4 daily row. `report` names the grain: "landing" (landing page,
 * source, medium, campaign) or "geo_device" (country, device); dimensions
 * the report does not use are "". Rows of different reports are never summed.
 */
export type AnalyticsRow = {
  report: "landing" | "geo_device";
  day: string;
  landingPage: string;
  source: string;
  medium: string;
  campaign: string;
  country: string;
  device: string;
  sessions: number;
  users: number;
  engagedSessions: number;
  keyEvents: number;
};

export class ProviderHttpError extends Error {
  constructor(
    public provider: string,
    public status: number,
    message: string,
  ) {
    super(`${provider} HTTP ${status}: ${sanitizeProviderMessage(message).slice(0, 300)}`);
    this.name = "ProviderHttpError";
  }
}

/** The stored authorisation was revoked or expired (e.g. OAuth `invalid_grant`): reconnect required. */
export class AuthExpiredError extends Error {
  constructor(message: string) {
    super(sanitizeProviderMessage(message));
    this.name = "AuthExpiredError";
  }
}

/** Missing or invalid local configuration (not a provider failure): retrying will not help. */
export class IntegrationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationConfigError";
  }
}

/** True for failures that only a human can fix by reconnecting (401, 403, revoked grant). */
export function isAuthFailure(e: unknown): boolean {
  if (e instanceof AuthExpiredError) return true;
  return e instanceof ProviderHttpError && (e.status === 401 || e.status === 403);
}

/** Rate limits, server errors and network failures are worth retrying; other client errors are not. */
export function isRetryableProviderError(e: unknown): boolean {
  if (isAuthFailure(e) || e instanceof IntegrationConfigError) return false;
  if (e instanceof ProviderHttpError) return e.status === 429 || e.status >= 500;
  return true;
}

/**
 * Remove anything that could carry a credential from a provider message:
 * query strings of URLs, key/token parameters, bearer tokens, JWT-like blobs.
 */
export function sanitizeProviderMessage(message: string): string {
  return message
    .replace(/(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi, "$1?[redacted]")
    .replace(/\b(api[_-]?key|apikey|key|access_token|refresh_token|client_secret|token|code|assertion)=([^&\s"']+)/gi, "$1=[redacted]")
    .replace(/("(?:access_token|refresh_token|client_secret|private_key|apiKey|api_key)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, "Bearer [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted-jwt]");
}

/** Truncate to a byte budget (UTF-8) so long URLs and queries fit the unique index. */
export function clipBytes(s: string, maxBytes: number): string {
  const b = Buffer.from(s, "utf8");
  if (b.length <= maxBytes) return s;
  let out = b.subarray(0, maxBytes).toString("utf8");
  // Drop a trailing partial code point (decoded as U+FFFD).
  while (out.endsWith("�")) out = out.slice(0, -1);
  return out;
}

export const MAX_QUERY_BYTES = 600;
export const MAX_PAGE_BYTES = 1600;

/** Build a normalized row, clipping text dimensions and deriving CTR when the provider omits it. */
export function searchRow(r: { day: string; query?: string | null; page?: string | null; country?: string | null; device?: string | null; clicks: number; impressions: number; ctr?: number | null; position?: number | null }): SearchRow {
  const clicks = Math.max(0, Math.round(Number(r.clicks) || 0));
  const impressions = Math.max(0, Math.round(Number(r.impressions) || 0));
  const pos = r.position === null || r.position === undefined || !Number.isFinite(Number(r.position)) || Number(r.position) <= 0 ? null : Number(r.position);
  return {
    day: r.day,
    query: r.query ? clipBytes(r.query, MAX_QUERY_BYTES) : null,
    page: r.page ? clipBytes(r.page, MAX_PAGE_BYTES) : null,
    country: r.country ? r.country.toLowerCase().slice(0, 8) : null,
    device: r.device ? r.device.toUpperCase().slice(0, 16) : null,
    clicks,
    impressions,
    ctr: r.ctr !== null && r.ctr !== undefined && Number.isFinite(Number(r.ctr)) ? Number(r.ctr) : impressions ? clicks / impressions : 0,
    position: pos,
  };
}
