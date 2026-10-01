-- Brain estimators migration slot: opportunity_impact_estimate.
-- The expected impact estimate (src/core/estimate) of each opportunity, computed when
-- opportunities are (re)generated: the master estimator's result as JSON, or NULL for
-- opportunities generated before it existed. No backfill: the next regeneration fills it.
ALTER TABLE "opportunities" ADD COLUMN IF NOT EXISTS "impact_estimate" jsonb;
