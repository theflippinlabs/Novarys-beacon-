/**
 * Make an error message safe to store (integrations.lastError, jobs.lastError)
 * or show: strips URL query strings, `apikey=`-style parameters, bearer tokens,
 * JWTs, JSON secret fields and key-shaped tokens, then truncates. Pure.
 */
export function redactErrorText(message: string, maxLength = 500): string {
  return String(message ?? "")
    .replace(/(https?:\/\/[^\s?#"'<>]+)\?[^\s"'<>]*/gi, "$1?[redacted]")
    .replace(/\b(api[_-]?key|apikey|key|access_token|refresh_token|client_secret|secret|password|token|code|assertion|signature|sig)=([^&\s"']+)/gi, "$1=[redacted]")
    .replace(/("(?:access_token|refresh_token|client_secret|private_key|apiKey|api_key|password|secret|token)"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/g, "$1 [redacted]")
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[redacted-jwt]")
    .replace(/\b(sk|bsk|bpk|sk-ant|pplx|rk|whsec)[-_][A-Za-z0-9_-]{8,}/g, "[redacted-key]")
    .replace(/postgres(?:ql)?:\/\/[^\s"'<>]+/gi, "postgres://[redacted]")
    .slice(0, maxLength);
}
