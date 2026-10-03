import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { asSystem, closeDb, withOrg } from "@/db";
import { auditLogs, memberships, sessions, users } from "@/db/schema";
import { authenticate, createSession, recoverPassword } from "@/lib/auth/service";
import { hashPassword } from "@/lib/security/crypto";
import { newOrg, uid } from "./helpers";

afterAll(closeDb);

const TOKEN = "r".repeat(40);

async function member() {
  const { org } = await newOrg("recover");
  const email = `owner-${uid()}@example.test`;
  const [u] = await asSystem(async (tx) => tx.insert(users).values({ email, name: "Owner", passwordHash: await hashPassword("old password 123") }).returning());
  await asSystem((tx) => tx.insert(memberships).values({ organizationId: org.id, userId: u.id, role: "OWNER" }));
  await createSession(u.id);
  return { org, user: u, email };
}

describe("password recovery with the operator's recovery code", () => {
  it("sets the new password, revokes sessions and audits", async () => {
    const { org, user, email } = await member();
    const res = await recoverPassword({ email: email.toUpperCase(), token: TOKEN, password: "brand new pass 42", expectedToken: TOKEN, ipHash: "ip1" });
    expect(res).toEqual({ ok: true });
    expect((await authenticate(email, "brand new pass 42")).ok).toBe(true);
    expect((await authenticate(email, "old password 123")).ok).toBe(false);
    expect(await asSystem((tx) => tx.select().from(sessions).where(eq(sessions.userId, user.id)))).toHaveLength(0);
    const logs = await withOrg(org.id, (tx) => tx.select().from(auditLogs).where(and(eq(auditLogs.organizationId, org.id), eq(auditLogs.action, "auth.password_recovered"))));
    expect(logs).toHaveLength(1);
  });

  it("answers the same for a wrong code and an unknown email, and changes nothing", async () => {
    const { email } = await member();
    expect(await recoverPassword({ email, token: "x".repeat(40), password: "brand new pass 42", expectedToken: TOKEN })).toEqual({ ok: false, reason: "invalid" });
    expect(await recoverPassword({ email: `nobody-${uid()}@example.test`, token: TOKEN, password: "brand new pass 42", expectedToken: TOKEN })).toEqual({ ok: false, reason: "invalid" });
    expect((await authenticate(email, "old password 123")).ok).toBe(true);
  });

  it("is disabled without a long enough server code, and refuses weak passwords", async () => {
    const { email } = await member();
    expect(await recoverPassword({ email, token: "", password: "brand new pass 42", expectedToken: undefined })).toEqual({ ok: false, reason: "disabled" });
    expect(await recoverPassword({ email, token: "short", password: "brand new pass 42", expectedToken: "short" })).toEqual({ ok: false, reason: "disabled" });
    expect((await recoverPassword({ email, token: TOKEN, password: "short", expectedToken: TOKEN })).ok).toBe(false);
    expect((await authenticate(email, "old password 123")).ok).toBe(true);
  });
});
