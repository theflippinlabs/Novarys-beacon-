"use client";

import { useSyncExternalStore } from "react";
import { greetingKey } from "@/core/briefing/briefing";
import { useI18n } from "@/i18n/client";

const noop = () => () => undefined;

/** Time-of-day greeting in the viewer's own time zone (the server renders a neutral title). */
export function Greeting() {
  const { t } = useI18n();
  const hour = useSyncExternalStore(
    noop,
    () => new Date().getHours(),
    () => -1,
  );
  if (hour < 0) return <>{t("Daily briefing")}</>;
  const key = greetingKey(hour);
  return <>{key === "Good morning" ? t("Good morning") : key === "Good afternoon" ? t("Good afternoon") : t("Good evening")}</>;
}
