/**
 * Minimal i18n: English source strings are the keys; locale dictionaries map
 * them to translations. Keys may contain `{name}` placeholders. When a string
 * produced at runtime (flash messages, generated labels) has no exact entry,
 * it is matched against the placeholder templates so dynamic messages
 * translate too. Unknown strings fall back to English, never to blanks.
 */
export const LOCALES = ["en", "fr"] as const;
export type Locale = (typeof LOCALES)[number];
export type Vars = Record<string, string | number>;
export type Dict = Readonly<Record<string, string>>;
export type T = (key: string, vars?: Vars) => string;

export const LOCALE_COOKIE = "beacon_locale";

export function isLocale(v: unknown): v is Locale {
  return typeof v === "string" && (LOCALES as readonly string[]).includes(v);
}

/** BCP-47 tag for Intl formatting. */
export function intlTag(locale: Locale) {
  return locale === "fr" ? "fr-FR" : "en-GB";
}

/** Picks a locale from an Accept-Language header (French if preferred, else English). */
export function negotiate(acceptLanguage: string | null | undefined): Locale {
  const first = (acceptLanguage ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  return first.startsWith("fr") ? "fr" : "en";
}

export function interpolate(s: string, vars?: Vars) {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function placeholders(s: string) {
  return [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
}

type Template = { re: RegExp; names: string[]; target: string };
const templateCache = new WeakMap<Dict, Template[]>();

/** Placeholders that always hold numbers; at runtime they only match numerals. */
const NUMERIC = new Set(["n", "pct", "days", "ms", "count", "total", "words", "views", "size", "tests", "skipped", "planned", "published", "urgency"]);
const NUM_RE = "([-+−]?\\d[\\d.,\\s\u202f\u00a0]*)";

/**
 * Templates eligible for matching runtime strings. A template needs enough
 * literal text to be specific: "{label}:" or "{plan}: {price}" would otherwise
 * swallow unrelated strings. Purely numeric templates ("{n}d") are fine.
 */
function eligible(key: string) {
  const names = placeholders(key);
  const letters = key.replace(/\{\w+\}/g, "").replace(/[^\p{L}]/gu, "").length;
  return names.every((n) => NUMERIC.has(n)) || letters >= 3;
}

function templates(dict: Dict): Template[] {
  let list = templateCache.get(dict);
  if (!list) {
    list = Object.entries(dict)
      .filter(([k]) => /\{\w+\}/.test(k) && eligible(k))
      .map(([k, target]) => {
        const names: string[] = [];
        const src = k.split(/(\{\w+\})/).map((part) => {
          const m = /^\{(\w+)\}$/.exec(part);
          if (m) {
            names.push(m[1]);
            return NUMERIC.has(m[1]) ? NUM_RE : "(.+?)";
          }
          return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        });
        return { re: new RegExp(`^${src.join("")}$`, "su"), names, target };
      })
      // Most specific (longest literal) templates first.
      .sort((a, b) => b.re.source.length - a.re.source.length);
    templateCache.set(dict, list);
  }
  return list;
}

/** Keys may carry a disambiguating context after "||" ("Content||proof text"); it is never displayed. */
const CONTEXT = "||";

export function translate(dict: Dict | null, key: string, vars?: Vars): string {
  const exact = dict?.[key];
  if (exact !== undefined) return interpolate(exact, vars);
  const ctx = key.indexOf(CONTEXT);
  if (ctx >= 0) key = key.slice(0, ctx);
  if (!dict) return interpolate(key, vars);
  if (!vars && key) {
    for (const tpl of templates(dict)) {
      const m = tpl.re.exec(key);
      if (m) {
        const captured: Vars = {};
        tpl.names.forEach((n, i) => (captured[n] = dict[m[i + 1]] ?? m[i + 1]));
        return interpolate(tpl.target, captured);
      }
    }
  }
  return interpolate(key, vars);
}

export function makeT(dict: Dict | null): T {
  return (key, vars) => translate(dict, key, vars);
}

/** Enum value (e.g. `IN_REVIEW`) → translated uppercase label (`EN RELECTURE`). */
export function enumLabel(t: T, value: string) {
  return t(value.replace(/_/g, " "));
}
