/**
 * Content-Security-Policy for HTML documents (pure, unit-tested).
 *
 * - scripts: only this origin's bundles carrying the per-request nonce
 *   (Next.js adds it to its own scripts); 'strict-dynamic' lets those load
 *   their chunks. Development adds 'unsafe-eval' (React debugging).
 * - styles: 'unsafe-inline' because React `style` attributes (charts, bars)
 *   cannot carry a nonce; styles cannot execute code.
 * - images: self, data:, blob: and https: (Markdown and product logos).
 * - connect: same origin only (agent NDJSON stream, uploads); dev adds the HMR socket.
 * - no plugins, no framing, no foreign form targets or <base>.
 */
export function buildCsp(nonce: string, opts: { dev: boolean; https: boolean }): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${opts.dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self'${opts.dev ? " ws: wss:" : ""}`,
    "media-src 'self' blob:",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  if (opts.https) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

/** Strict-Transport-Security for production (two years, subdomains). */
export const HSTS = "max-age=63072000; includeSubDomains";

/** Paths that must not get the document CSP: JSON/CORS APIs, the public tracker, static assets. */
export const CSP_EXEMPT = /^\/(api\/|_next\/static\/|_next\/image|beacon\.js$|favicon\.ico$|icon\.png$|apple-icon\.png$|opengraph-image|brand\/|r\/)/;
