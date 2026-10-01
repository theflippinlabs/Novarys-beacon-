import "server-only";
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { intlTag, isLocale, LOCALE_COOKIE, makeT, negotiate, type Locale } from "./core";
import { FR } from "./fr";

/** Request locale: explicit cookie choice, else the browser's preferred language. */
export const getLocale = cache(async (): Promise<Locale> => {
  const c = (await cookies()).get(LOCALE_COOKIE)?.value;
  if (isLocale(c)) return c;
  return negotiate((await headers()).get("accept-language"));
});

export const getI18n = cache(async () => {
  const locale = await getLocale();
  return { locale, intl: intlTag(locale), t: makeT(locale === "fr" ? FR : null) };
});

export async function getT() {
  return (await getI18n()).t;
}
