import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AGENT_TOOLS, toolsForRole } from "@/agent/tools";
import { FR } from "@/i18n/fr";
import { ROLES, can } from "@/lib/auth/rbac";

const FORBIDDEN = /approve|publish|verify|delete|payout|submit_external|member|integration|api_key/;

describe("agent tool catalog", () => {
  it("has unique, well-formed names", () => {
    const names = AGENT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const n of names) expect(n).toMatch(/^[a-z][a-z0-9_]{2,63}$/);
  });

  it("never exposes a human-only capability", () => {
    expect(AGENT_TOOLS.map((t) => t.name).filter((n) => FORBIDDEN.test(n))).toEqual([]);
    for (const t of AGENT_TOOLS) expect(["content:approve", "distribution:approve", "recommendation:decide", "revenue:write", "integration:manage", "apikey:manage", "member:manage", "settings:manage"]).not.toContain(t.permission);
  });

  it("describes and labels every tool, with a French label", () => {
    for (const t of AGENT_TOOLS) {
      expect(t.description.length, t.name).toBeGreaterThan(40);
      expect(t.label.trim().length, t.name).toBeGreaterThan(3);
      expect(FR[t.label], `French label for "${t.label}"`).toBeTruthy();
    }
  });

  it("read tools only need the read permission; write tools need more", () => {
    for (const t of AGENT_TOOLS) {
      expect(["read", "write"]).toContain(t.kind);
      if (t.kind === "read") expect(t.permission, t.name).toBe("read");
      else expect(t.permission, t.name).not.toBe("read");
    }
  });

  it("converts every input schema to a JSON-schema object with described properties", () => {
    for (const t of AGENT_TOOLS) {
      const schema = z.toJSONSchema(t.input) as { type?: string; properties?: Record<string, { description?: string }> };
      expect(schema.type, t.name).toBe("object");
      for (const [k, p] of Object.entries(schema.properties ?? {})) expect(p.description, `${t.name}.${k}`).toBeTruthy();
    }
  });

  it("toolsForRole filters by RBAC: viewers only read", () => {
    const viewer = toolsForRole("VIEWER");
    expect(viewer.length).toBeGreaterThan(0);
    expect(viewer.every((t) => t.kind === "read")).toBe(true);
    expect(toolsForRole("OWNER")).toHaveLength(AGENT_TOOLS.length);
    for (const role of ROLES) for (const t of toolsForRole(role)) expect(can(role, t.permission)).toBe(true);
    const analyst = toolsForRole("ANALYST").map((t) => t.name);
    expect(analyst).toContain("add_query");
    expect(analyst).not.toContain("create_content_draft");
  });
});
