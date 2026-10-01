"use client";

import { createContext, useContext, useMemo } from "react";
import { intlTag, makeT, type Locale, type T } from "./core";
import { FR } from "./fr";

const Ctx = createContext<{ locale: Locale; intl: string; t: T }>({ locale: "en", intl: "en-GB", t: makeT(null) });

export function I18nProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const value = useMemo(() => ({ locale, intl: intlTag(locale), t: makeT(locale === "fr" ? FR : null) }), [locale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n() {
  return useContext(Ctx);
}
