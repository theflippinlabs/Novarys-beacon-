import { slugify } from "@/core/util/text";

/**
 * "Export production-ready content": an approved (or published) version as
 * files a team can publish outside Beacon: Markdown with front matter, the
 * JSON-LD structured data, and the meta (titles, description, sources and
 * the approval record). Only the approved version is exported; nothing is
 * rewritten here.
 */
export type ExportInput = {
  asset: { id: string; title: string; type: string; status: string; approvedAt: Date | null };
  version: { version: number; body: string; metaTitle: string | null; metaDescription: string | null; structuredData: Record<string, unknown>[]; factRefs: { ref: string; sourceUrl?: string }[] };
  product: { name: string; slug: string } | null;
  exportedAt: Date;
};

const yamlString = (s: string) => JSON.stringify(s);

export function exportBaseName(i: ExportInput) {
  return `${slugify(i.product?.slug ?? "beacon")}-${slugify(i.asset.title) || "content"}-v${i.version.version}`.slice(0, 120);
}

export function exportMarkdown(i: ExportInput): string {
  const fm = [
    "---",
    `title: ${yamlString(i.version.metaTitle ?? i.asset.title)}`,
    ...(i.version.metaDescription ? [`description: ${yamlString(i.version.metaDescription)}`] : []),
    `type: ${i.asset.type}`,
    ...(i.product ? [`product: ${yamlString(i.product.name)}`] : []),
    `version: ${i.version.version}`,
    ...(i.asset.approvedAt ? [`approved_at: ${i.asset.approvedAt.toISOString()}`] : []),
    `exported_at: ${i.exportedAt.toISOString()}`,
    ...(i.version.factRefs.some((f) => f.sourceUrl) ? ["sources:", ...[...new Set(i.version.factRefs.map((f) => f.sourceUrl).filter((x): x is string => Boolean(x)))].map((u) => `  - ${yamlString(u)}`)] : []),
    "---",
    "",
  ].join("\n");
  return `${fm}${i.version.body.trim()}\n`;
}

export function exportJsonLd(i: ExportInput): string {
  const items = i.version.structuredData;
  const doc = items.length === 1 ? items[0] : { "@context": "https://schema.org", "@graph": items.map((x) => Object.fromEntries(Object.entries(x).filter(([k]) => k !== "@context"))) };
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function exportMeta(i: ExportInput) {
  return {
    title: i.asset.title,
    metaTitle: i.version.metaTitle,
    metaDescription: i.version.metaDescription,
    type: i.asset.type,
    status: i.asset.status,
    version: i.version.version,
    approvedAt: i.asset.approvedAt?.toISOString() ?? null,
    product: i.product?.name ?? null,
    factRefs: i.version.factRefs,
    exportedAt: i.exportedAt.toISOString(),
    note: "Approved in Novarys Beacon by a person. Publish it on your own site with the JSON-LD in a script type=application/ld+json tag.",
  };
}

/** Markdown with the JSON-LD and meta appended as fenced blocks (single-file option). */
export function exportSingleMarkdown(i: ExportInput): string {
  return `${exportMarkdown(i)}\n<!-- JSON-LD (place in a <script type="application/ld+json"> tag) -->\n\n\`\`\`json\n${exportJsonLd(i)}\`\`\`\n`;
}

export function exportFiles(i: ExportInput) {
  const base = exportBaseName(i);
  return [
    { name: `${base}/content.md`, content: exportMarkdown(i) },
    { name: `${base}/structured-data.jsonld`, content: exportJsonLd(i) },
    { name: `${base}/meta.json`, content: `${JSON.stringify(exportMeta(i), null, 2)}\n` },
  ];
}
