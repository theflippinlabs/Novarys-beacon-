"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { deleteConversation } from "@/agent/store";
import { getAuthContext } from "@/lib/auth/session";

/** Members delete their own agent conversations (the agent itself has no delete tools). */
export async function deleteConversationAction(fd: FormData) {
  const ctx = await getAuthContext();
  if (!ctx) redirect("/login");
  const id = z.string().uuid().safeParse(fd.get("id"));
  if (id.success) await deleteConversation(ctx, id.data);
  redirect("/agent");
}
