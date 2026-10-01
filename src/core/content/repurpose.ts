import { buildAnswerBlocks } from "@/core/geo/entity";
import { publishableGraph, restrictGraph } from "@/core/knowledge/facts";
import type { ProductGraph } from "@/core/knowledge/types";
import { faqPageJsonLd } from "@/core/seo/schema-org";
import { stripLongDashes } from "@/core/util/text";
import { generateDraft, type Draft } from "./generate";
import { EDITOR_TODO } from "./markers";
import { REPURPOSE_LABELS, type RepurposeType } from "./types";

export type RepurposeSource = { title: string; factRefs: { ref: string; sourceUrl?: string }[] };

/**
 * Builds a derivative draft (X post, LinkedIn post, scripts, newsletter
 * block, FAQ additions, product update) from an approved or published
 * source. Only the facts the source version itself was built from are
 * available, and only while they are still VERIFIED; anything missing
 * becomes an editor TODO. The derivative is then fact checked and goes
 * through human approval like any other asset.
 */
export function buildDerivative(g: ProductGraph, source: RepurposeSource, type: RepurposeType, publisher: string): Draft {
  const allowed = new Set(source.factRefs.map((f) => f.ref));
  const graph = restrictGraph(publishableGraph(g), allowed);
  const title = stripLongDashes(`${source.title} (${REPURPOSE_LABELS[type]})`);
  if (type === "FAQ") {
    const { answers } = buildAnswerBlocks(graph);
    const lines = [`# ${title}`, ""];
    const refs = new Map<string, string | undefined>();
    for (const a of answers) {
      lines.push(`## ${a.question}`, "", a.answer, "");
      // Answer blocks list every field they may draw on; keep only the source's own facts.
      for (const r of a.basedOn) if (allowed.has(r)) refs.set(r, a.sources[0]);
    }
    if (!answers.length) lines.push(`${EDITOR_TODO} The source content has no verified facts that answer a question. Add FAQ entries to the knowledge graph first.`, "");
    const urls = [...new Set([...refs.values()].filter((u): u is string => Boolean(u)).map((u) => u.replace(/\/+$/, "")))];
    if (urls.length) lines.push("## Sources", "", ...urls.map((u) => `- <${u}>`), "");
    const ld = faqPageJsonLd(answers.map((a) => ({ question: a.question, answer: a.answer })));
    return {
      title,
      metaTitle: title.length <= 65 ? title : `${title.slice(0, 64).replace(/\s+\S*$/, "")}…`,
      metaDescription: null,
      body: stripLongDashes(lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n"),
      factRefs: [...refs.entries()].map(([ref, sourceUrl]) => ({ ref, sourceUrl })),
      structuredData: ld ? [ld] : [],
    };
  }
  const draft = generateDraft(graph, { type, publisher });
  return { ...draft, title };
}
