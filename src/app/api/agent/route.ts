import { z } from "zod";
import { runAgentTurn, type AgentEvent } from "@/agent/loop";
import { getLocale } from "@/i18n/server";
import { getAuthContext } from "@/lib/auth/session";
import { err, ipHashOf, limited, readJson, sameOrigin } from "@/lib/http";
import { log } from "@/lib/logger";

export const dynamic = "force-dynamic";

const Body = z.object({
  conversationId: z.string().uuid().nullish(),
  text: z.string().max(8000),
  mediaIds: z.array(z.string().uuid()).max(4).default([]),
});

/** Same-origin only (`sameOrigin`): the session cookie authenticates, the Origin check blocks cross-site use. */
/** Runs one agent turn and streams events as NDJSON. */
export async function POST(req: Request) {
  if (!sameOrigin(req)) return err(403, "Cross-origin request refused");
  const ctx = await getAuthContext();
  if (!ctx) return err(401, "Not signed in");
  const tooMany = await limited(`agent:${ctx.user.id}`, 30, 300);
  if (tooMany) return tooMany;

  let body: z.infer<typeof Body>;
  try {
    body = Body.parse(await readJson(req, 64_000));
  } catch {
    return err(400, "Invalid request");
  }
  if (!body.text.trim() && body.mediaIds.length === 0) return err(400, "Empty message");

  const locale = await getLocale();
  const actor = { organizationId: ctx.org.id, userId: ctx.user.id, actorType: "USER" as const, ipHash: ipHashOf(req) };
  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort());

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: AgentEvent) => {
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
        } catch {
          // Client went away; the turn still completes and is persisted.
        }
      };
      try {
        for await (const e of runAgentTurn({ ctx, actor, locale, conversationId: body.conversationId, text: body.text, mediaIds: body.mediaIds, signal: abort.signal })) send(e);
      } catch (e) {
        log.error("agent.turn_failed", { err: (e as Error).message });
        send({ type: "error", code: "failed" });
      } finally {
        try {
          controller.close();
        } catch {}
      }
    },
    cancel() {
      abort.abort();
    },
  });

  return new Response(stream, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
