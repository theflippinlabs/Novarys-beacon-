/**
 * Indices of the x-axis labels of a chart with `n` points: first, middle and
 * last, each at most once (one or two points never repeat a label).
 */
export function axisTickIndices(n: number): number[] {
  if (n <= 0) return [];
  return [...new Set([0, Math.floor((n - 1) / 2), n - 1])];
}
