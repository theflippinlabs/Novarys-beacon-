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
    if (req.method === "POST" && (req.url ?? "").startsWith("/v1/messages")) return fakeClaude(req, res);
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

/**
 * Minimal stand-in for the Claude Messages API (streaming), used by the agent
 * E2E journey via ANTHROPIC_BASE_URL: first answers with a tool call, then —
 * once it receives the tool result — with a short Markdown reply.
 */
function fakeClaude(req: http.IncomingMessage, res: http.ServerResponse) {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw) as { messages: { role: string; content: string | { type: string }[] }[]; tools?: { name: string }[] };
    const last = body.messages.at(-1)!;
    const gotToolResult = Array.isArray(last.content) && last.content.some((b) => b.type === "tool_result");
    const hasTool = body.tools?.some((t) => t.name === "get_workspace_overview");
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    send("message_start", { type: "message_start", message: { id: "msg_fake", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
    if (!gotToolResult && hasTool) {
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_fake1", name: "get_workspace_overview", input: {} } });
      send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{}" } });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 5 } });
    } else {
      send("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
      for (const part of ["Your workspace has **one product**. ", "[Open products](/products)"]) send("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: part } });
      send("content_block_stop", { type: "content_block_stop", index: 0 });
      send("message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 12 } });
    }
    send("message_stop", { type: "message_stop" });
    res.end();
  });
}
