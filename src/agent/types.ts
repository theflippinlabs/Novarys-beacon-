import type { z } from "zod";
import type { Tx } from "@/db";
import type { Locale, T } from "@/i18n/core";
import type { Actor } from "@/lib/audit";
import type { AuthContext } from "@/lib/auth/service";
import type { Permission } from "@/lib/auth/rbac";

/** What a tool receives when it runs. Each call runs in its own tenant-scoped (RLS) transaction. */
export type AgentToolContext = {
  tx: Tx;
  ctx: AuthContext;
  /** Audit actor for writes; tools add `{ via: "agent" }` to audit metadata. */
  actor: Actor;
  locale: Locale;
  t: T;
};

/**
 * A capability the Beacon agent can use on the user's behalf. Tools never do
 * anything the signed-in user could not do themselves (RBAC `permission`), and
 * never perform the human-only steps: approving or publishing content,
 * verifying facts, submitting externally, payouts, deletions, members/keys.
 */
export type AgentTool<S extends z.ZodObject = z.ZodObject> = {
  name: string;
  /** Short English progress label shown in the chat while it runs, e.g. "Creating a content draft". Must have a French entry in src/i18n/fr/agent.ts. */
  label: string;
  /** Written for the model: what it does, when to use it, what it returns. */
  description: string;
  permission: Permission;
  /** "read" tools only look; "write" tools change Beacon data (reported to the user as actions). */
  kind: "read" | "write";
  input: S;
  /** Returns JSON-serialisable data. Include app paths (e.g. `link: "/content/<id>"`) the user can open. Throw Error with a clear message on failure. */
  run: (c: AgentToolContext, input: z.infer<S>) => Promise<unknown>;
};

export function defineTool<S extends z.ZodObject>(tool: AgentTool<S>): AgentTool<S> {
  return tool;
}
