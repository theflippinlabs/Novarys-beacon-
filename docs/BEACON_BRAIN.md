# Beacon Brain: orchestrator, specialists and estimators

The Brain is Beacon's main reasoning system. One orchestrator deploys specialist analysts across every area of growth, each backed by quantitative estimators, and merges their findings into one ranked, measurable plan. It follows the platform rules: measure everything, fake nothing, humans approve anything impactful.

## 1. Layers

```
                         Beacon Brain (orchestrator)
        plans the run, deploys specialists, merges, ranks by expected impact
                                    │
   ┌──────────┬──────────┬──────────┼──────────┬──────────┬──────────┐
 Technical  Content &   AI         Competitors Conversion Distribution
 SEO        knowledge   visibility             & revenue  & growth
   └──────────┴──────────┴──── each uses ───────┴──────────┴──────────┘
                             Estimators (src/core/estimate)
   traffic potential · conversion rate · value per conversion · success
   probability · AI mention rate · expected impact (master, Monte Carlo)
```

- **Estimators** (`src/core/estimate`, pure, unit tested): turn measured data into estimates with an uncertainty interval, or say exactly why they cannot.
- **Specialists** (`src/brain/specialists`): one per area. Each runs a deterministic analysis on real data (always available, no LLM needed) and, when an Anthropic key is configured, an optional LLM pass that may reorder and explain but never adds a number that is not in its evidence.
- **Orchestrator** (`src/brain/orchestrator.ts`): runs as the `brain.run` job (capped at 1), deploys every specialist, deduplicates against open opportunities, ranks by the master estimator, and stores a Brain report. The chat agent can run it and ask a single specialist.

## 2. Estimator contract (`src/core/estimate/types.ts`)

```ts
export type EstimateUnit = "visits" | "clicks" | "signups" | "conversions" | "money_minor" | "ratio" | "probability" | "mentions";
export type InputSource = "MEASURED" | "ORG_HISTORY";   // never invented, never a generic benchmark
export type EstimateInput = { name: string; value: number | string; source: InputSource; detail: string; sampleSize?: number };

export type Estimate =
  | {
      key: string;                 // e.g. "traffic_potential"
      label: string;               // English, translated at render
      unit: EstimateUnit;
      currency?: string;           // money only; currencies are never mixed
      state: "ESTIMATED";
      p10: number; p50: number; p90: number;   // 80% interval
      horizonDays: number;
      confidence: "LOW" | "MEDIUM" | "HIGH";   // from sample sizes, documented per estimator
      method: string;              // plain-language formula
      inputs: EstimateInput[];
    }
  | {
      key: string; label: string; unit: EstimateUnit;
      state: "NOT_ESTIMABLE";
      reason: string;              // what is missing
      missing: string[];           // connection or data needed, e.g. "Search Console", "50+ tracked visitors"
      inputs: EstimateInput[];     // what was available
    };
```

Rules:
- Inputs come only from this organisation's measured data (`MEASURED`) or its own history (`ORG_HISTORY`). No industry benchmark, no default rate, no invented CTR curve. When data is insufficient the estimator returns `NOT_ESTIMABLE` with the exact missing items.
- Intervals are real: Beta posteriors (uniform prior) for rates, Wilson intervals for proportions, empirical quantiles or bootstrap for values, seeded Monte Carlo (deterministic, 2,000 draws) for the master estimator.
- Every estimate states its method and inputs so the UI can show "how this was estimated".

## 3. Estimators

| Key | Question | Data | Not estimable when |
|---|---|---|---|
| `traffic_potential` | Extra clicks per 30 days if this query or cluster reaches a target position | Search Console or Bing impressions per query; the org's own CTR by position curve fitted from its search data | No search provider, or fewer than 5 positions with 100+ impressions to fit the curve |
| `conversion_rate` | Visitor to signup (or chosen step) rate for a product and channel | Tracked events (visitors, signups) | Fewer than 50 tracked visitors in the window |
| `value_per_conversion` | Revenue per converting identity, per currency | Revenue events and attributed conversions | No revenue source, or fewer than 5 paying conversions |
| `success_probability` | Chance an action of this opportunity type produces a measured improvement | `autopilot_learning` tallies | Fewer than 3 measured outcomes for the type |
| `ai_mention_rate` | Share of sampled AI answers that mention the product, and the gap to the best competitor | AI visibility tests | No AI provider or fewer than 10 sampled answers |
| `expected_impact` (master) | Expected extra signups and revenue over the horizon for one action | Combines the above by Monte Carlo: clicks × conversion rate × success probability (× value per conversion) | Any required input is not estimable: returns the partial chain it could compute (e.g. clicks only) plus the missing items |

The master estimator also returns `estimationPower`: which inputs are measured, and the single connection that would unlock the most estimates ("Connect Search Console to estimate 14 opportunities").

## 4. Specialists

| Specialist | Covers | Main sources |
|---|---|---|
| Technical SEO | Crawl issues, indexability, sitemaps, internal links, Core pages | `seo_audits`, `seo_issues`, `crawled_pages`, sitemaps |
| Content and knowledge | Content gaps, drafts, quality gate, knowledge completeness and verification | content services, knowledge graph, content gaps |
| AI visibility and GEO | Mention rate, citations, prompts without the product, entity endpoints | AI visibility tests, citations, GEO |
| Competitors | Competitor share of answers and citations, watched page changes, comparison facts | competitors, competitor watches |
| Conversion and revenue | Funnels, attribution, revenue, experiments | tracking, attribution, revenue, experiments |
| Distribution and growth | Distribution targets, referrals, cross-sell, ecosystem | distribution, referrals, cross-sell |

Each specialist returns:

```ts
type SpecialistReport = {
  specialist: SpecialistKey;
  coverage: "MEASURED" | "PARTIAL" | "NOT_CONNECTED";   // how much of its area has data
  missing: string[];                                    // connections that would raise coverage
  findings: Array<{
    title: string; summary: string;                     // English, entity names as variables
    severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
    evidence: Array<{ label: string; value: string; href?: string }>;   // every number shown comes from here
    estimate?: Estimate;                                // expected impact when estimable
    action: { label: string; href: string; kind: "OPEN" | "PROPOSE_RECOMMENDATION" };
    opportunityId?: string;                             // when it maps to an existing opportunity
  }>;
  narrative?: string;                                   // optional LLM summary, validated
  llm?: { model: string; inputTokens: number; outputTokens: number };
};
```

LLM guard: the narrative and any reordered finding are checked so every number they contain appears in that specialist's evidence or estimates; otherwise the deterministic report is kept and the rejection is logged.

## 5. Orchestrator

`brain.run` (weekly per organisation with at least one product, and on demand):
1. Read phase (one `withOrg` transaction per specialist, sequential queries): collect signals.
2. Estimation: compute estimates per finding (pure).
3. Optional LLM phase (no transaction open): specialists in parallel, then one orchestrator synthesis call that writes the executive summary from the merged findings only.
4. Merge: deduplicate (same opportunity or same target), rank by `expected_impact` p50 signups (then revenue, then severity, then effort), keep estimable and non-estimable findings separate so unknowns are never ranked as zero.
5. Store `brain_runs` (status, coverage map, executive summary, top actions, estimation power, model usage) and `brain_findings`; notify members when a CRITICAL finding is new.
6. Actions: findings link to the page that resolves them; "Propose" creates an autopilot recommendation (human approval). The Brain never publishes, verifies facts, submits externally or deletes.

Budget: LLM calls count toward the existing agent monthly budget (`agent_usage`); without a key the Brain runs fully deterministically and says so.

## 6. Surfaces

- `/brain` page: coverage grid (six areas, measured / partial / not connected), executive summary, ranked plan with estimate bars (p10 to p90 with the p50 mark) and "How this was estimated", non-estimable findings with what to connect, estimation power, run history, "Run now".
- Overview: the latest Brain summary card.
- Agent tools: `run_brain` (queues a run), `get_brain_report`, `ask_specialist` (runs one specialist now and returns its report).
- Opportunities: each opportunity shows its `expected_impact` estimate when estimable.
