import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A tiny in-memory S3 stand-in for integration tests (path-style URLs only):
 * PutObject, GetObject, DeleteObject and ListObjectsV2 on one bucket. Checks
 * that requests are SigV4-signed with the expected access key id; does not
 * verify signatures.
 */
export type FakeObject = { body: Buffer; contentType: string; lastModified: Date };

export type FakeS3 = {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  objects: Map<string, FakeObject>;
  requests: { method: string; key: string }[];
  /** Status to answer every request of a method with (simulates an outage). */
  failing: Partial<Record<"GET" | "PUT" | "DELETE", number>>;
  close: () => Promise<void>;
};

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function errorXml(res: ServerResponse, status: number, code: string) {
  res.writeHead(status, { "content-type": "application/xml" });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${code}</Message><RequestId>fake</RequestId></Error>`);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of req) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

export async function startFakeS3(opts: { bucket?: string; accessKeyId?: string } = {}): Promise<FakeS3> {
  const bucket = opts.bucket ?? "beacon-test-media";
  const accessKeyId = opts.accessKeyId ?? "AKIDTESTFAKE";
  const objects = new Map<string, FakeObject>();
  const requests: FakeS3["requests"] = [];
  const failing: FakeS3["failing"] = {};

  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://fake");
      const [, b, ...rest] = url.pathname.split("/");
      const key = decodeURIComponent(rest.join("/"));
      const method = req.method ?? "GET";
      const body = await readBody(req);
      requests.push({ method, key });
      if (!String(req.headers.authorization ?? "").startsWith(`AWS4-HMAC-SHA256 Credential=${accessKeyId}/`)) return errorXml(res, 403, "AccessDenied");
      if (b !== bucket) return errorXml(res, 404, "NoSuchBucket");
      const fail = failing[method as keyof FakeS3["failing"]];
      if (fail) return errorXml(res, fail, "InternalError");

      if (method === "PUT" && key) {
        objects.set(key, { body, contentType: String(req.headers["content-type"] ?? "application/octet-stream"), lastModified: new Date() });
        res.writeHead(200, { etag: `"${body.length}"` });
        return res.end();
      }
      if (method === "GET" && key) {
        const o = objects.get(key);
        if (!o) return errorXml(res, 404, "NoSuchKey");
        res.writeHead(200, { "content-type": o.contentType, "content-length": String(o.body.length), "last-modified": o.lastModified.toUTCString(), etag: `"${o.body.length}"` });
        return res.end(o.body);
      }
      if (method === "DELETE" && key) {
        objects.delete(key);
        res.writeHead(204);
        return res.end();
      }
      if (method === "GET" && !key && url.searchParams.get("list-type") === "2") {
        const prefix = url.searchParams.get("prefix") ?? "";
        const max = Number(url.searchParams.get("max-keys") ?? 1000);
        const after = url.searchParams.get("continuation-token") ?? "";
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix) && k > after).sort();
        const page = keys.slice(0, max);
        const truncated = keys.length > page.length;
        const contents = page
          .map((k) => {
            const o = objects.get(k)!;
            return `<Contents><Key>${xml(k)}</Key><LastModified>${o.lastModified.toISOString()}</LastModified><ETag>"${o.body.length}"</ETag><Size>${o.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`;
          })
          .join("");
        res.writeHead(200, { "content-type": "application/xml" });
        return res.end(
          `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${bucket}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${max}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${xml(page[page.length - 1])}</NextContinuationToken>` : ""}${contents}</ListBucketResult>`,
        );
      }
      return errorXml(res, 400, "NotImplemented");
    } catch {
      return errorXml(res, 500, "InternalError");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    endpoint: `http://127.0.0.1:${port}`,
    bucket,
    accessKeyId,
    objects,
    requests,
    failing,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
