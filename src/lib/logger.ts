/**
 * Structured JSON logger with secret redaction. Output goes to stdout/stderr
 * so any log shipper can ingest it.
 */
type Level = "debug" | "info" | "warn" | "error";
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEY = /pass(word)?|secret|token|api[_-]?key|authorization|cookie|credential|private[_-]?key|ciphertext/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) ? "[redacted]" : redact(v, depth + 1);
    return out;
  }
  if (typeof value === "string") {
    // Redact things that look like bearer tokens / API keys embedded in strings.
    return value.replace(/\b(sk|bsk|bpk|sk-ant|pplx)[-_][A-Za-z0-9_-]{8,}/g, "[redacted-key]");
  }
  return value;
}

const minLevel = (): number => LEVELS[(process.env.LOG_LEVEL as Level) ?? "info"] ?? 20;

function emit(level: Level, msg: string, fields?: Record<string, unknown>) {
  if (LEVELS[level] < minLevel()) return;
  if (process.env.NODE_ENV === "test" && !process.env.LOG_IN_TESTS) return;
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...(redact(fields ?? {}) as object) });
  if (level === "error" || level === "warn") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

export const log = {
  debug: (msg: string, f?: Record<string, unknown>) => emit("debug", msg, f),
  info: (msg: string, f?: Record<string, unknown>) => emit("info", msg, f),
  warn: (msg: string, f?: Record<string, unknown>) => emit("warn", msg, f),
  error: (msg: string, f?: Record<string, unknown>) => emit("error", msg, f),
};

/** Error-tracking hook: logs and optionally forwards to a configured webhook. */
export function reportError(err: unknown, context: Record<string, unknown> = {}) {
  log.error("error.reported", { err, ...context });
  const url = process.env.BEACON_ERROR_WEBHOOK_URL;
  if (url) {
    const body = JSON.stringify(redact({ err, context, ts: new Date().toISOString() }));
    fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => undefined);
  }
}
