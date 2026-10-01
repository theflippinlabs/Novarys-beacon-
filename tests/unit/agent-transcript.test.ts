import { describe, expect, it } from "vitest";
import { repairToolPairs } from "@/agent/transcript";

describe("repairToolPairs", () => {
  it("leaves a complete transcript untouched", () => {
    const msgs = [
      { role: "user" as const, content: [{ type: "text" as const, text: "hi" }] },
      { role: "assistant" as const, content: [{ type: "tool_use" as const, id: "t1", name: "x", input: {} }] },
      { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "t1", content: "{}" }] },
    ];
    expect(repairToolPairs(msgs)).toEqual(msgs);
  });

  it("answers an orphaned tool call at the end", () => {
    const out = repairToolPairs([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
    ]);
    expect(out).toHaveLength(3);
    expect(out[2]).toMatchObject({ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", is_error: true }] });
  });

  it("prepends missing results to the next user message", () => {
    const out = repairToolPairs([
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "x", input: {} }] },
      { role: "user", content: [{ type: "text", text: "again" }] },
    ]);
    expect(out).toHaveLength(3);
    expect(out[2].content).toMatchObject([{ type: "tool_result", tool_use_id: "t1" }, { type: "text", text: "again" }]);
  });
});
