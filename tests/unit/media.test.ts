import { describe, expect, it } from "vitest";
import { altFromFilename, buildMediaUrl, markdownImage, mediaIdFromUrl, sniffImage } from "@/core/media/image";
import { renderMarkdown } from "@/core/content/markdown";
import { factCheck } from "@/core/content/fact-check";
import { completeGraph } from "./fixtures/graph";

const ID = "3f2b8c1e-7a4d-4e5f-9b6a-0c1d2e3f4a5b";
const bytes = (...xs: (number | string)[]) => {
  const out: number[] = [];
  for (const x of xs) {
    if (typeof x === "string") out.push(...[...x].map((c) => c.charCodeAt(0)));
    else out.push(x);
  }
  while (out.length < 16) out.push(0);
  return new Uint8Array(out);
};

describe("sniffImage", () => {
  it("recognises raster formats by magic bytes", () => {
    expect(sniffImage(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("jpeg");
    expect(sniffImage(bytes(0x89, "PNG", 0x0d, 0x0a, 0x1a, 0x0a))).toBe("png");
    expect(sniffImage(bytes("GIF89a"))).toBe("gif");
    expect(sniffImage(bytes("RIFF", 0, 0, 0, 0, "WEBP"))).toBe("webp");
    expect(sniffImage(bytes(0x49, 0x49, 0x2a, 0x00))).toBe("tiff");
    expect(sniffImage(bytes(0, 0, 0, 0x18, "ftypheic"))).toBe("heif");
    expect(sniffImage(bytes(0, 0, 0, 0x1c, "ftypavif"))).toBe("heif");
  });

  it("rejects SVG, HTML, PDF, video and short input", () => {
    expect(sniffImage(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).toBeNull();
    expect(sniffImage(new TextEncoder().encode("<!doctype html><html></html>"))).toBeNull();
    expect(sniffImage(bytes("%PDF-1.7"))).toBeNull();
    expect(sniffImage(bytes(0, 0, 0, 0x18, "ftypmp42"))).toBeNull();
    expect(sniffImage(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });
});

describe("media URLs", () => {
  it("builds relative and absolute URLs", () => {
    expect(buildMediaUrl(ID)).toBe(`/api/media/${ID}`);
    expect(buildMediaUrl(ID, "https://beacon.example/")).toBe(`https://beacon.example/api/media/${ID}`);
  });

  it("extracts ids only from this site's media URLs", () => {
    expect(mediaIdFromUrl(`/api/media/${ID}`)).toBe(ID);
    expect(mediaIdFromUrl(`https://beacon.example/api/media/${ID}`, ["https://beacon.example"])).toBe(ID);
    expect(mediaIdFromUrl(`https://evil.example/api/media/${ID}`, ["https://beacon.example"])).toBeNull();
    expect(mediaIdFromUrl(`https://beacon.example/api/media/${ID}?x=1`, ["https://beacon.example"])).toBeNull();
    expect(mediaIdFromUrl("/api/media/../../etc/passwd")).toBeNull();
    expect(mediaIdFromUrl("/api/media/not-a-uuid")).toBeNull();
    expect(mediaIdFromUrl("javascript:alert(1)", ["https://beacon.example"])).toBeNull();
  });

  it("formats Markdown snippets and alt texts", () => {
    expect(markdownImage("Dashboard [beta] (v2)", `/api/media/${ID}`)).toBe(`![Dashboard beta v2](/api/media/${ID})`);
    expect(altFromFilename("IMG_0042.HEIC")).toBe("IMG 0042");
    expect(altFromFilename("my-product_screen.png")).toBe("my product screen");
  });
});

describe("Markdown images", () => {
  const base = "https://beacon.example";
  it("renders this site's media as <img>", () => {
    const html = renderMarkdown(`Look: ![The dashboard](${base}/api/media/${ID}) and ![rel](/api/media/${ID})`, { imageOrigins: [base] });
    expect(html).toContain(`<img src="${base}/api/media/${ID}" alt="The dashboard" loading="lazy" decoding="async">`);
    expect(html).toContain(`<img src="/api/media/${ID}" alt="rel"`);
  });

  it("never renders remote or unsafe images", () => {
    const html = renderMarkdown(`![x](https://tracker.example/pixel.gif) ![y](javascript:alert(1)) ![z](${base}/api/media/${ID})`);
    expect(html).not.toContain("<img");
    expect(html).toContain('<a href="https://tracker.example/pixel.gif"');
    expect(html).not.toContain("javascript:");
  });

  it("keeps alt text escaped and free of injected markup", () => {
    const html = renderMarkdown(`![a" onerror="alert(1) **b** _c_](/api/media/${ID})`);
    expect(html).toContain("<img");
    expect(html).not.toContain('" onerror="');
    expect(html).not.toMatch(/alt="[^"]*<strong>/);
  });
});

describe("fact check and images", () => {
  it("checks only the alt text of an image, not its URL (UUID digits are not invented numbers)", () => {
    const g = completeGraph();
    const ok = factCheck(`![Screenshot of the moderator dashboard](https://beacon.example/api/media/${ID})`, g);
    expect(ok.claims.filter((c) => c.status === "UNSUPPORTED")).toEqual([]);
    const bad = factCheck(`![Trusted by 5000 agencies worldwide](https://beacon.example/api/media/${ID})`, g);
    expect(bad.passed).toBe(false);
  });
});
