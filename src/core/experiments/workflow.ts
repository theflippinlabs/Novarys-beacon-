/**
 * Experiment lifecycle: DRAFT → RUNNING → READY_FOR_REVIEW → CONCLUDED, or
 * ABANDONED from any open state. READY_FOR_REVIEW may go back to RUNNING to
 * collect more data. CONCLUDED and ABANDONED are final. Enforced server-side
 * (services/experiments.ts) and audited.
 */
export const EXPERIMENT_STATUSES = ["DRAFT", "RUNNING", "READY_FOR_REVIEW", "CONCLUDED", "ABANDONED"] as const;
export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export const EXPERIMENT_NEXT: Record<ExperimentStatus, readonly ExperimentStatus[]> = {
  DRAFT: ["RUNNING", "ABANDONED"],
  RUNNING: ["READY_FOR_REVIEW", "ABANDONED"],
  READY_FOR_REVIEW: ["CONCLUDED", "RUNNING", "ABANDONED"],
  CONCLUDED: [],
  ABANDONED: [],
};

export function canTransitionExperiment(from: ExperimentStatus, to: ExperimentStatus) {
  return EXPERIMENT_NEXT[from].includes(to);
}

export function assertExperimentTransition(from: ExperimentStatus, to: ExperimentStatus) {
  if (!canTransitionExperiment(from, to)) throw new Error(`An experiment cannot move from ${from} to ${to}.`);
}

/** What must be designed before an experiment can start: the counted conversion event and its minimum sample size. */
export function startBlockers(e: { metricKey: string | null; minSampleSize: number | null }): string[] {
  const out: string[] = [];
  if (!e.metricKey) out.push("Choose the conversion event the experiment counts.");
  if (!e.minSampleSize) out.push("Compute the minimum sample size before starting.");
  return out;
}
