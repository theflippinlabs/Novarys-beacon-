export type MetricRow = { metric: string; day: string; dimension?: string; value: number; weight?: number | null };

export type DateRange = { start: string; end: string };

export type ConfigField = { key: string; label: string; placeholder?: string; required: boolean };
export type SecretField = { key: string; label: string; multiline?: boolean };

/**
 * Visibility provider adapter. Beacon core never calls a vendor API directly;
 * it goes through this interface so providers can be swapped or added
 * without touching the rest of the system.
 */
export interface VisibilityAdapter {
  readonly provider: "GOOGLE_SEARCH_CONSOLE" | "GOOGLE_ANALYTICS" | "BING_WEBMASTER";
  readonly label: string;
  readonly configFields: ConfigField[];
  readonly secretFields: SecretField[];
  readonly docsUrl: string;
  testConnection(config: Record<string, string>, secret: Record<string, string>): Promise<{ ok: boolean; message: string }>;
  fetchMetrics(config: Record<string, string>, secret: Record<string, string>, range: DateRange): Promise<MetricRow[]>;
}

export class ProviderHttpError extends Error {
  constructor(
    public provider: string,
    public status: number,
    message: string,
  ) {
    super(`${provider} HTTP ${status}: ${message.slice(0, 300)}`);
    this.name = "ProviderHttpError";
  }
}
