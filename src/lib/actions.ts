import "server-only";
import { redirect } from "next/navigation";
import { z } from "zod";
import { withOrg, type Tx } from "@/db";
import type { Actor } from "@/lib/audit";
import { requirePermission, clientIpHash } from "@/lib/auth/session";
import type { AuthContext } from "@/lib/auth/service";
import { ForbiddenError, type Permission } from "@/lib/auth/rbac";
import { log } from "@/lib/logger";

export type ActionCtx = { ctx: AuthContext; actor: Actor; tx: Tx };
export type ActionResult = { ok?: string; redirect?: string } | void;

/** Only allow same-site relative redirect targets (no open redirects via `_back`). */
export function safeBack(v: unknown, fallback = "/"): string {
  return typeof v === "string" && /^\/(?!\/)[^\s\\]*$/.test(v) ? v : fallback;
}

export function formToObject(fd: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of fd.entries()) {
    if (k.startsWith("$ACTION")) continue;
    const value = typeof v === "string" ? v : v.name;
    if (k.endsWith("[]")) {
      const key = k.slice(0, -2);
      out[key] = [...((out[key] as unknown[]) ?? []), value];
    } else out[k] = value;
  }
  return out;
}

function withParam(path: string, key: string, value: string) {
  const [base, hash] = path.split("#");
  const u = new URL(base, "http://x");
  u.searchParams.delete("ok");
  u.searchParams.delete("error");
  u.searchParams.set(key, value.slice(0, 300));
  return `${u.pathname}${u.search}${hash ? `#${hash}` : ""}`;
}

/**
 * Standard server-action pipeline: authenticate → authorise (RBAC) →
 * validate (zod) → run inside a tenant-scoped RLS transaction → redirect with
 * a flash message. Errors never leak stack traces to the client.
 */
export async function act<S extends z.ZodType>(fd: FormData, permission: Permission, schema: S, fn: (a: ActionCtx, input: z.infer<S>) => Promise<ActionResult>): Promise<never> {
  return pipeline(fd, permission, schema, (ctx, actor, input) => withOrg(ctx.org.id, (tx) => fn({ ctx, actor, tx }, input)));
}

export type StagedActionCtx = { ctx: AuthContext; actor: Actor; run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T> };

/**
 * Same pipeline as `act`, but the action opens its own tenant-scoped
 * transactions through `run`. Use it when the action must call an external
 * service (connection tests, OAuth): read in one transaction, call the
 * provider with no transaction open, then write in another.
 */
export async function actStaged<S extends z.ZodType>(fd: FormData, permission: Permission, schema: S, fn: (a: StagedActionCtx, input: z.infer<S>) => Promise<ActionResult>): Promise<never> {
  return pipeline(fd, permission, schema, (ctx, actor, input) => fn({ ctx, actor, run: (f) => withOrg(ctx.org.id, f) }, input));
}

async function pipeline<S extends z.ZodType>(fd: FormData, permission: Permission, schema: S, exec: (ctx: AuthContext, actor: Actor, input: z.infer<S>) => Promise<ActionResult>): Promise<never> {
  const ctx = await requirePermission(permission).catch((e) => {
    if (e instanceof ForbiddenError) return null;
    throw e;
  });
  const raw = formToObject(fd);
  const back = safeBack(raw._back);
  if (!ctx) redirect(withParam(back, "error", "You do not have permission to do that."));
  let target: string;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    target = withParam(back, "error", `Invalid value for “${issue.path.join(".") || "input"}”.`);
  } else {
    try {
      const actor: Actor = { organizationId: ctx.org.id, userId: ctx.user.id, actorType: "USER", ipHash: await clientIpHash() };
      const res = await exec(ctx, actor, parsed.data);
      const dest = safeBack(res?.redirect, back);
      target = res?.ok ? withParam(dest, "ok", res.ok) : dest;
    } catch (e) {
      log.warn("action.failed", { permission, err: (e as Error).message });
      const msg = e instanceof Error && !/duplicate key|violates|syntax|relation/i.test(e.message) ? e.message : "The operation could not be completed.";
      target = withParam(back, "error", msg.includes("duplicate key") ? "That item already exists." : msg);
    }
  }
  redirect(target);
}

// Common field helpers
export const zId = z.string().uuid();
export const zOptText = (max = 2000) =>
  z
    .string()
    .max(max)
    .optional()
    .transform((v) => (v && v.trim() ? v.trim() : null));
export const zOptUrl = z
  .string()
  .max(2000)
  .optional()
  .transform((v) => (v && v.trim() ? v.trim() : null))
  .refine((v) => v === null || /^https:\/\/[^\s]+$/i.test(v), "must be an https:// URL");
export const zBoolTri = z
  .enum(["", "true", "false"])
  .optional()
  .transform((v) => (v === "true" ? true : v === "false" ? false : null));
export const zCheckbox = z
  .string()
  .optional()
  .transform((v) => v === "on" || v === "true");
export const zList = z
  .string()
  .max(4000)
  .optional()
  .transform((v) => (v ? v.split(/[,\n]/).map((s) => s.trim()).filter(Boolean) : []));
