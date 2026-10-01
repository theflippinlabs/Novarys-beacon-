import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, BlockList } from "node:net";

/**
 * SSRF-safe HTTP client used by the crawler and any feature that fetches
 * user-supplied URLs.
 *
 * - http/https only, default ports only (80/443) unless explicitly allowed
 * - the resolved IP is validated inside the socket `lookup` hook, so the
 *   address that is checked is the address that is connected (no DNS
 *   rebinding between check and use)
 * - private, loopback, link-local, CGNAT, multicast and cloud metadata ranges
 *   are blocked
 * - redirects are followed manually and every hop is re-validated
 * - response size is capped, and every request has a hard wall-clock
 *   deadline (a slow server dripping bytes cannot hold a worker forever)
 */
const blocked = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["2001:db8::", 32],
  // Tunnelling prefixes that embed an IPv4 address: 6to4 and Teredo.
  ["2002::", 16],
  ["2001::", 32],
] as const)
  blocked.addSubnet(net, prefix, "ipv6");

export class SsrfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SsrfError";
  }
}

const allowPrivate = () => process.env.BEACON_SSRF_ALLOW_PRIVATE === "true" && process.env.NODE_ENV !== "production";

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  if (family === 6) {
    const lower = address.toLowerCase();
    // IPv4-mapped (::ffff:a.b.c.d) and deprecated IPv4-compatible (::a.b.c.d) addresses, dotted or hex.
    const mapped = lower.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blocked.check(mapped[1], "ipv4");
    const hex = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hex) {
      const [hi, lo] = [parseInt(hex[1], 16), parseInt(hex[2], 16)];
      return blocked.check(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`, "ipv4");
    }
    return blocked.check(address, "ipv6");
  }
  return blocked.check(address, "ipv4");
}

export function assertSafeUrl(raw: string, opts: { allowPorts?: number[] } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SsrfError("Invalid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SsrfError("Only http(s) URLs are allowed");
  if (url.username || url.password) throw new SsrfError("Credentials in URLs are not allowed");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  const allowed = opts.allowPorts ?? [80, 443];
  if (!allowed.includes(port) && !allowPrivate()) throw new SsrfError(`Port ${port} is not allowed`);
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && isBlockedAddress(host) && !allowPrivate()) throw new SsrfError("Address is not allowed");
  if (/^(localhost|.*\.localhost|metadata\.google\.internal)\.?$/i.test(host) && !allowPrivate()) throw new SsrfError("Host is not allowed");
  return url;
}

function safeLookup(
  hostname: string,
  options: object,
  callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, "", 0);
    const list = addresses as LookupAddress[];
    if (!allowPrivate()) {
      const bad = list.find((a) => isBlockedAddress(a.address));
      if (bad) return callback(Object.assign(new Error(`Blocked address for ${hostname}`), { code: "ESSRF" }), "", 0);
    }
    const all = (options as { all?: boolean }).all;
    if (all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

export type SafeResponse = {
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  bytes: number;
  elapsedMs: number;
  redirects: string[];
  truncated: boolean;
  /** Status code of each redirect hop (same order as `redirects`). */
  redirectStatuses?: number[];
  /** Undecoded response bytes (e.g. gzip sitemaps). */
  raw?: Buffer;
};

export async function safeFetch(
  rawUrl: string,
  opts: {
    method?: "GET" | "HEAD" | "POST";
    maxBytes?: number;
    timeoutMs?: number;
    maxRedirects?: number;
    userAgent?: string;
    acceptEncoding?: string;
    /** Request body (POST); redirects are never followed for a POST. */
    body?: string;
    /** Extra request headers (e.g. content-type, signatures). */
    headers?: Record<string, string>;
  } = {},
): Promise<SafeResponse> {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxRedirects = opts.method === "POST" ? 0 : (opts.maxRedirects ?? 5);
  const started = Date.now();
  const redirects: string[] = [];
  const redirectStatuses: number[] = [];
  let current = rawUrl;

  for (let hop = 0; hop <= maxRedirects; hop++) {
    const url = assertSafeUrl(current);
    const res = await requestOnce(url, opts.method ?? "GET", maxBytes, Math.max(1000, timeoutMs - (Date.now() - started)), opts.userAgent, opts.acceptEncoding, opts.body, opts.headers);
    if (res.status >= 300 && res.status < 400 && res.headers.location && opts.method !== "POST") {
      redirects.push(current);
      redirectStatuses.push(res.status);
      current = new URL(res.headers.location, url).toString();
      continue;
    }
    return { ...res, url: current, elapsedMs: Date.now() - started, redirects, redirectStatuses };
  }
  throw new SsrfError("Too many redirects");
}

function requestOnce(url: URL, method: string, maxBytes: number, timeoutMs: number, userAgent?: string, acceptEncoding = "identity", body?: string, extraHeaders?: Record<string, string>) {
  return new Promise<Omit<SafeResponse, "url" | "elapsedMs" | "redirects">>((resolve, reject) => {
    const mod = url.protocol === "https:" ? https : http;
    const req = mod.request(
      url,
      {
        method,
        lookup: safeLookup as never,
        timeout: timeoutMs,
        headers: {
          "user-agent": userAgent ?? "NovarysBeacon/1.0 (+technical-seo-audit)",
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5",
          // Only "identity" unless a caller (gzip sitemaps) decodes the raw bytes itself.
          "accept-encoding": acceptEncoding,
          ...(extraHeaders ?? {}),
          ...(body !== undefined ? { "content-length": String(Buffer.byteLength(body)) } : {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        let truncated = false;
        res.on("data", (c: Buffer) => {
          bytes += c.length;
          if (bytes > maxBytes) {
            truncated = true;
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        const done = () => {
          const buf = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")])),
            body: buf.toString("utf8"),
            raw: buf,
            bytes,
            truncated,
          });
        };
        res.on("end", done);
        res.on("close", done);
        res.on("error", reject);
      },
    );
    // `timeout` above is an idle timeout; this is the hard per-request deadline.
    const deadline = setTimeout(() => req.destroy(new Error("Request deadline exceeded")), timeoutMs);
    deadline.unref?.();
    req.on("close", () => clearTimeout(deadline));
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}
