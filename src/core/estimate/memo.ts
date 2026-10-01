import type { EstimationContext } from "./context";

const caches = new WeakMap<EstimationContext, Map<string, unknown>>();

/**
 * Per-context memo for expensive, deterministic intermediate results (Monte
 * Carlo draws of a curve, bootstrap distributions). Draws are seeded by their
 * own key, so results never depend on call order.
 */
export function memo<T>(ctx: EstimationContext, key: string, fn: () => T): T {
  let m = caches.get(ctx);
  if (!m) caches.set(ctx, (m = new Map()));
  if (m.has(key)) return m.get(key) as T;
  const v = fn();
  m.set(key, v);
  return v;
}
