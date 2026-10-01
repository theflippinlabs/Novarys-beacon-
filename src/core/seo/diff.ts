/**
 * Audit-to-audit change detection. Pages are matched by URL, issues by
 * fingerprint (product, rule, URL, sub-key). Human decisions (IGNORED,
 * RESOLVED) carry forward to the same fingerprint in the new audit. Pure.
 */
export type PageSnapshot = { url: string; status: number | null; title: string | null; canonical: string | null; indexable: boolean | null; contentHash: string | null };
export type IssueSnapshot = { fingerprint: string; rule: string; url: string; status: "OPEN" | "RESOLVED" | "IGNORED" };

export type ChangeKind = "status" | "title" | "canonical" | "indexability" | "content";

export type AuditDiff = {
  previousAuditId: string | null;
  newPages: number;
  removedPages: number;
  changed: Record<ChangeKind, number>;
  newIssues: number;
  fixedIssues: number;
  /** Issues a human marked resolved that the new crawl still detects. */
  stillDetectedResolved: number;
  carriedIgnored: number;
  examples: {
    newPages: string[];
    removedPages: string[];
    changed: { url: string; kind: ChangeKind; before: string | null; after: string | null }[];
    newIssues: { rule: string; url: string }[];
    fixedIssues: { rule: string; url: string }[];
  };
};

const EXAMPLES = 20;
const str = (v: unknown) => (v === null || v === undefined ? null : String(v));

export function diffAudits(
  previous: { auditId: string; pages: PageSnapshot[]; issues: IssueSnapshot[] } | null,
  current: { pages: PageSnapshot[]; issues: { fingerprint: string; rule: string; url: string }[] },
): { diff: AuditDiff; carried: Map<string, "RESOLVED" | "IGNORED"> } {
  const carried = new Map<string, "RESOLVED" | "IGNORED">();
  const diff: AuditDiff = {
    previousAuditId: previous?.auditId ?? null,
    newPages: 0,
    removedPages: 0,
    changed: { status: 0, title: 0, canonical: 0, indexability: 0, content: 0 },
    newIssues: 0,
    fixedIssues: 0,
    stillDetectedResolved: 0,
    carriedIgnored: 0,
    examples: { newPages: [], removedPages: [], changed: [], newIssues: [], fixedIssues: [] },
  };
  if (!previous) return { diff, carried };

  const prevPages = new Map(previous.pages.map((p) => [p.url, p]));
  const curPages = new Map(current.pages.map((p) => [p.url, p]));
  for (const [url, cur] of curPages) {
    const prev = prevPages.get(url);
    if (!prev) {
      diff.newPages++;
      if (diff.examples.newPages.length < EXAMPLES) diff.examples.newPages.push(url);
      continue;
    }
    const checks: [ChangeKind, unknown, unknown][] = [
      ["status", prev.status, cur.status],
      ["title", prev.title, cur.title],
      ["canonical", prev.canonical, cur.canonical],
      ["indexability", prev.indexable, cur.indexable],
      ["content", prev.contentHash, cur.contentHash],
    ];
    for (const [kind, a, b] of checks) {
      // A missing hash on either side (older audits) is not a change.
      if (kind === "content" && (!a || !b)) continue;
      if (str(a) === str(b)) continue;
      diff.changed[kind]++;
      if (diff.examples.changed.length < EXAMPLES) diff.examples.changed.push({ url, kind, before: kind === "content" ? null : str(a), after: kind === "content" ? null : str(b) });
    }
  }
  for (const url of prevPages.keys())
    if (!curPages.has(url)) {
      diff.removedPages++;
      if (diff.examples.removedPages.length < EXAMPLES) diff.examples.removedPages.push(url);
    }

  const prevIssues = new Map(previous.issues.map((i) => [i.fingerprint, i]));
  const curFps = new Set(current.issues.map((i) => i.fingerprint));
  for (const i of current.issues) {
    const prev = prevIssues.get(i.fingerprint);
    if (!prev) {
      diff.newIssues++;
      if (diff.examples.newIssues.length < EXAMPLES) diff.examples.newIssues.push({ rule: i.rule, url: i.url });
      continue;
    }
    if (prev.status === "IGNORED") {
      carried.set(i.fingerprint, "IGNORED");
      diff.carriedIgnored++;
    } else if (prev.status === "RESOLVED") {
      carried.set(i.fingerprint, "RESOLVED");
      diff.stillDetectedResolved++;
    }
  }
  for (const [fp, prev] of prevIssues)
    if (!curFps.has(fp)) {
      diff.fixedIssues++;
      if (diff.examples.fixedIssues.length < EXAMPLES) diff.examples.fixedIssues.push({ rule: prev.rule, url: prev.url });
    }
  return { diff, carried };
}
