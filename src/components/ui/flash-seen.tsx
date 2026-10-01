"use client";

import { useEffect } from "react";
import { FLASH_PARAMS } from "@/lib/flash-params";

/** URL with the flash parameters (`ok`, `error` and the signature `fs`) removed, or null when it has none. */
export function withoutFlashParams(href: string): string | null {
  const u = new URL(href);
  if (!FLASH_PARAMS.some((p) => u.searchParams.has(p))) return null;
  for (const p of FLASH_PARAMS) u.searchParams.delete(p);
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
