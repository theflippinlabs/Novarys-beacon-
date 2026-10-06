import { describe, expect, it } from "vitest";
import { cleanApiKey } from "@/ai/registry";
import { providerError } from "@/ai/providers/openai-compatible";

describe("provider keys and errors", () => {
  it("removes spaces, line breaks and invisible characters from a pasted key", () => {
    expect(cleanApiKey(" sk-proj-abc\u200B123\n ")).toBe("sk-proj-abc123");
    expect(cleanApiKey("sk-proj-abc 123﻿")).toBe("sk-proj-abc123");
  });

  it("keeps the provider's explanation, masks the key and keeps the status", async () => {
    const res = new Response(JSON.stringify({ error: { message: "Incorrect API key provided: sk-proj-****abcd. You can find your API key at https://platform.openai.com/account/api-keys.", code: "invalid_api_key" } }), { status: 401 });
    const e = await providerError("OpenAI", res);
    expect(e.status).toBe(401);
    expect(e.message).toContain("OpenAI API error 401: Incorrect API key provided: sk-[redacted]");
    expect(e.message).not.toContain("abcd");
  });

  it("falls back to the status alone", async () => {
    const e = await providerError("OpenAI", new Response("", { status: 503 }));
    expect(e.message).toBe("OpenAI API error 503");
  });
});
