import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeT, negotiate, placeholders, translate } from "@/i18n/core";
import { FR, FR_AREAS } from "@/i18n/fr";

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : /\.(tsx?|ts)$/.test(f) ? [p] : [];
  });
}

/** Every literal passed to t("…") in the source tree. */
function literalKeys() {
  const keys = new Map<string, string>();
  const re = /\bt\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
  for (const f of files(join(process.cwd(), "src"))) {
    if (f.includes(`${join("src", "i18n")}`)) continue;
    const src = readFileSync(f, "utf8");
    for (const m of src.matchAll(re)) {
      if (m[1] === "`" && m[2].includes("${")) continue;
      const key = m[2].replace(/\\(["'`\\])/g, "$1").replace(/\\n/g, "\n");
      keys.set(key, f);
    }
  }
  return keys;
}

describe("i18n core", () => {
  it("negotiates French only when preferred", () => {
    expect(negotiate("fr-FR,fr;q=0.9,en;q=0.8")).toBe("fr");
    expect(negotiate("en-US,fr;q=0.5")).toBe("en");
    expect(negotiate(undefined)).toBe("en");
  });

  it("interpolates and falls back to English", () => {
    const t = makeT({ "Hello {name}": "Bonjour {name}" });
    expect(t("Hello {name}", { name: "Ada" })).toBe("Bonjour Ada");
    expect(t("Untranslated")).toBe("Untranslated");
    expect(makeT(null)("{n} items", { n: 3 })).toBe("3 items");
  });

  it("translates runtime strings through placeholder templates", () => {
    const dict = { "{email} added as {role}.": "{email} ajouté en tant que {role}.", editor: "éditeur" };
    expect(translate(dict, "a@b.c added as editor.")).toBe("a@b.c ajouté en tant que éditeur.");
  });
});

describe("French dictionary", () => {
  it("covers every t() literal in the source", () => {
    const missing = [...literalKeys()].filter(([k]) => FR[k] === undefined).map(([k, f]) => `${f.replace(process.cwd(), "")}: ${k}`);
    expect(missing).toEqual([]);
  });

  it("keeps placeholders intact and has no empty values", () => {
    const bad = Object.entries(FR).filter(([k, v]) => !v.trim() || placeholders(k).join() !== placeholders(v).join());
    expect(bad).toEqual([]);
  });

  it("translates a key the same way in every area", () => {
    const seen = new Map<string, string>();
    const conflicts: string[] = [];
    for (const [area, dict] of Object.entries(FR_AREAS))
      for (const [k, v] of Object.entries(dict)) {
        if (seen.has(k) && seen.get(k) !== v) conflicts.push(`${area}: ${k}`);
        seen.set(k, v);
      }
    expect(conflicts).toEqual([]);
  });
});

describe("runtime template matching", () => {
  it("ignores templates without enough literal text and requires numerals for counts", () => {
    const dict = { "{label}:": "{label} :", "{n}s": "{n} s", "{n} days": "{n} jours", Features: "Fonctionnalités" };
    expect(translate(dict, "Plan:")).toBe("Plan:");
    expect(translate(dict, "Integrations")).toBe("Integrations");
    expect(translate(dict, "30s")).toBe("30 s");
    expect(translate(dict, "1,234 days")).toBe("1,234 jours");
    expect(translate(dict, "many days")).toBe("many days");
  });

  it("does not let the merged French dictionary mangle plain words", () => {
    const t = makeT(FR);
    for (const w of ["Integrations", "Features", "Plans", "Weekend", "Status:"]) {
      const out = t(w);
      expect(out === w || FR[w] === out).toBe(true);
    }
  });
});

describe("context keys", () => {
  it("hide the context in English and when untranslated", () => {
    expect(makeT(null)("Content||proof text")).toBe("Content");
    expect(makeT({})("Content||proof text")).toBe("Content");
    expect(makeT({ "Content||proof text": "Contenu" })("Content||proof text")).toBe("Contenu");
  });
});
