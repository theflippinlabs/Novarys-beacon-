import http from "node:http";

/**
 * A tiny local website for the technical audit. (The database is reset by
 * tests/e2e/prepare-db.ts in the web-server command, because Playwright starts
 * the web server before global setup.)
 */
export default async function globalSetup() {
  const port = Number(process.env.E2E_FIXTURE_PORT ?? 3199);
  const page = (title: string, body: string, extra = "") =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">${title ? `<title>${title}</title>` : ""}${extra}</head><body>${body}</body></html>`;
  const routes: Record<string, [number, string, string]> = {
    "/robots.txt": [200, "text/plain", `User-agent: *\nAllow: /\nSitemap: http://127.0.0.1:${port}/sitemap.xml\n`],
    "/sitemap.xml": [200, "application/xml", `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>http://127.0.0.1:${port}/</loc></url><url><loc>http://127.0.0.1:${port}/orphan</loc></url></urlset>`],
    "/": [200, "text/html", page("Acme Live — TikTok LIVE moderation", `<h1>Acme Live</h1><p>Home</p><a href="/features">Features</a> <a href="/missing">Broken</a>`, `<meta name="description" content="Acme Live helps agencies moderate TikTok LIVE streams in real time with filters.">`)],
    "/features": [200, "text/html", page("", `<h1>Features</h1><img src="/x.png"><a href="/">Home</a>`)],
    "/orphan": [200, "text/html", page("Orphan page title here", `<h1>Orphan</h1>`)],
  };
  const server = http.createServer((req, res) => {
    const r = routes[(req.url ?? "/").split("?")[0]];
    if (!r) {
      res.writeHead(404, { "content-type": "text/html" });
      return res.end("<h1>Not found</h1>");
    }
    res.writeHead(r[0], { "content-type": r[1] });
    res.end(r[2]);
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  return async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
}
