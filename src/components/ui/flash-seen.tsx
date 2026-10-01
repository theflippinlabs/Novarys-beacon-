"use client";

import { useEffect } from "react";

/** URL with the flash parameters (`ok`, `error`) removed, or null when it has none. */
export function withoutFlashParams(href: string): string | null {
  const u = new URL(href);
  if (!u.searchParams.has("ok") && !u.searchParams.has("error")) return null;
  u.searchParams.delete("ok");
  u.searchParams.delete("error");
  return `${u.pathname}${u.search}${u.hash}`;
}

/**
 * Makes a flash message one-shot: once it is displayed, its parameters are
 * removed from the address bar, so a reload or a copied link never shows it
 * again. The router's own history state is kept, which updates only the
 * address bar: syncing the router here would race with a server action
 * submitted right after the message appears. Runs after every render, since
 * each action redirect writes the parameters back.
 */
export function FlashSeen() {
  useEffect(() => {
    const next = withoutFlashParams(window.location.href);
    if (next !== null) window.history.replaceState(window.history.state, "", next);
  });
  return null;
}
