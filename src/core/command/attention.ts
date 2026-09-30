export type AttentionItem = {
  key: string;
  title: string;
  detail: string;
  href: string;
  count: number;
  impact: number;
  confidence: number;
  effort: number;
  urgency: number;
};

export const attentionPriority = (i: Pick<AttentionItem, "impact" | "confidence" | "effort" | "urgency">) => (i.impact * i.confidence * i.urgency) / i.effort;

/** Ranks "what needs my attention today" by impact × confidence × urgency ÷ effort; zero-count items are dropped. */
export function prioritizeAttention(items: AttentionItem[]): (AttentionItem & { priority: number })[] {
  return items
    .filter((i) => i.count > 0)
    .map((i) => ({ ...i, priority: Math.round(attentionPriority(i) * 10) / 10 }))
    .sort((a, b) => b.priority - a.priority);
}
