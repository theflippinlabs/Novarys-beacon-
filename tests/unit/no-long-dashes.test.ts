import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { stripLongDashes } from "@/core/util/text";

/** Built from char codes so this file never contains the characters it forbids. */
const EM = String.fromCharCode(0x2014);
const EN = String.fromCharCode(0x2013);
const LONG_DASH = new RegExp(`[${EM}${EN}]`);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? files(p) : [p];
  });
}

describe("no long dashes in the app", () => {
  it("has no em or en dash anywhere under src/ or tests/e2e", () => {
    const root = process.cwd();
    const hits: string[] = [];
    for (const dir of ["src", join("tests", "e2e")])
      for (const f of files(join(root, dir))) {
        if (!/\.(tsx?|mjs|js|css|json|md|sql|txt|html)$/.test(f)) continue;
        readFileSync(f, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (LONG_DASH.test(line)) hits.push(`${relative(root, f)}:${i + 1}`);
          });
      }
    expect(hits).toEqual([]);
  });
});

describe("stripLongDashes", () => {
  it("returns text without long dashes unchanged (including trailing spaces)", () => {
    const s = "Line one  \nLine - two, 1-5.";
    expect(stripLongDashes(s)).toBe(s);
  });

  it("turns spaced asides and title separators into commas", () => {
    expect(stripLongDashes(`Beacon ${EM} the growth engine ${EM} ships today.`)).toBe("Beacon, the growth engine, ships today.");
    expect(stripLongDashes(`Acme Live ${EN} TikTok moderation`)).toBe("Acme Live, TikTok moderation");
    expect(stripLongDashes(`word${EM}another`)).toBe("word, another");
  });

  it("uses hyphens for numeric ranges and en-dash compounds", () => {
    expect(stripLongDashes(`Relevance 1${EN}5, 2020 ${EN} 2024`)).toBe("Relevance 1-5, 2020-2024");
    expect(stripLongDashes(`Paris${EN}Lyon`)).toBe("Paris-Lyon");
  });

  it("keeps Markdown bullets and table cells readable", () => {
    expect(stripLongDashes(`${EM} first\n  ${EN} second`)).toBe("- first\n  - second");
    expect(stripLongDashes(`| a | ${EM} |`)).toBe("| a | - |");
  });

  it("never leaves doubled punctuation or dangling dashes", () => {
    expect(stripLongDashes(`Done. ${EM} Next step`)).toBe("Done. Next step");
    expect(stripLongDashes(`Wait ${EM}.`)).toBe("Wait.");
    expect(stripLongDashes(`Trailing ${EM}\nnext`)).toBe("Trailing\nnext");
    expect(stripLongDashes(`Fin ${EM}`)).toBe("Fin");
  });

  it("handles French text", () => {
    expect(stripLongDashes(`Beacon ${EM} le moteur de croissance ${EM} est prêt.`)).toBe("Beacon, le moteur de croissance, est prêt.");
  });
});
