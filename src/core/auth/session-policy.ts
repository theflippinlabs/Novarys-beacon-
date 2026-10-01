/**
 * Session lifetime policy (pure). A session ends after 24 hours without use
 * (idle timeout) or 30 days after sign-in (absolute maximum), whichever comes
 * first. Activity slides the idle window, but the stored `lastSeenAt` is only
 * rewritten at most once an hour so a busy page does not write on every
 * request.
 */
export const SESSION_IDLE_MS = 24 * 60 * 60 * 1000;
export const SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000;
export const SESSION_TOUCH_INTERVAL_MS = 60 * 60 * 1000;

export type SessionTimes = { createdAt: Date; lastSeenAt: Date; expiresAt: Date };
export type SessionVerdict = { valid: false; reason: "expired" | "idle" } | { valid: true; touch: boolean };

export function sessionVerdict(s: SessionTimes, now: Date = new Date()): SessionVerdict {
  const t = now.getTime();
  // The absolute cap also applies to sessions created before the policy existed.
  if (s.expiresAt.getTime() <= t || s.createdAt.getTime() + SESSION_ABSOLUTE_MS <= t) return { valid: false, reason: "expired" };
  if (s.lastSeenAt.getTime() + SESSION_IDLE_MS <= t) return { valid: false, reason: "idle" };
  return { valid: true, touch: t - s.lastSeenAt.getTime() >= SESSION_TOUCH_INTERVAL_MS };
}

/** Absolute expiry of a session created at `createdAt`. */
export const sessionAbsoluteExpiry = (createdAt: Date) => new Date(createdAt.getTime() + SESSION_ABSOLUTE_MS);

/** Cookie names: `__Host-` prefix in production (Secure, Path=/, no Domain); the legacy name is still read once to migrate. */
export const SESSION_COOKIE_PROD = "__Host-beacon_session";
export const SESSION_COOKIE_LEGACY = "beacon_session";
export const sessionCookieName = (production: boolean) => (production ? SESSION_COOKIE_PROD : SESSION_COOKIE_LEGACY);

/** The session token from a cookie lookup, preferring the current name over the legacy one. */
export function pickSessionToken(get: (name: string) => string | undefined, production: boolean): { token: string | undefined; legacy: boolean } {
  const current = get(sessionCookieName(production));
  if (current) return { token: current, legacy: false };
  const old = production ? get(SESSION_COOKIE_LEGACY) : undefined;
  return { token: old, legacy: Boolean(old) };
}
