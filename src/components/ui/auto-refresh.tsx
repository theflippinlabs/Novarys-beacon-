"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

/**
 * Re-renders the server page every `seconds` while mounted (live job status). Stops when the tab is hidden.
 * When the address bar no longer matches the router's URL (a displayed flash message removed its
 * parameters, see `FlashSeen`), the first tick moves the router to the address bar's URL instead of
 * refreshing, so the message is not rendered again.
 */
export function AutoRefresh({ seconds = 4 }: { seconds?: number }) {
  const router = useRouter();
  const params = useSearchParams();
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      const shown = window.location.search.replace(/^\?/, "");
      if (shown !== params.toString()) router.replace(`${window.location.pathname}${window.location.search}${window.location.hash}`, { scroll: false });
      else router.refresh();
    }, Math.max(2, seconds) * 1000);
    return () => clearInterval(id);
  }, [router, params, seconds]);
  return null;
}
