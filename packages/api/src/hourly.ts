// Hourly bucketing for the charts.
//
// Extracted so it can be tested without a database: a chart's x-axis is a claim about
// a range, and the bug it fixes was invisible in SQL — the query was correct, it just
// returned only the hours that had rows.

/**
 * `count` hourly buckets ending at the hour containing `endSec` — so the LAST bucket
 * is the hour in progress and the first is `count - 1` hours before it.
 *
 * Anchoring on the start instead looks equivalent and is not: 24 buckets from
 * `now - 24h` end an hour short, and the hour a reader is currently in — the one
 * holding the trade they just placed — falls outside the chart. That is exactly what
 * happened: 24 buckets, 0 non-zero, and a fill two minutes old nowhere on it.
 *
 * Timestamps are unix SECONDS throughout, matching fills.block_ts and what uPlot
 * expects with `time: true`. Rows are snapped to their bucket, so a raw block
 * timestamp lands in the right hour, and rows outside the range are dropped rather
 * than widening it.
 */
export function hourBuckets<T extends Record<string, number>>(
  endSec: number,
  count: number,
  rows: Record<string, unknown>[],
  pick: (r: Record<string, unknown>) => T,
): ({ hourTs: number } & T)[] {
  const last = Math.floor(endSec / 3600) * 3600;
  const first = last - (count - 1) * 3600;
  const zero = Object.fromEntries(Object.keys(pick(rows[0] ?? {})).map((k) => [k, 0])) as T;
  const byHour = new Map<number, T>();
  for (let i = 0; i < count; i++) byHour.set(first + i * 3600, { ...zero });
  for (const r of rows) {
    const h = Math.floor(Number(r.hour_ts) / 3600) * 3600;
    if (byHour.has(h)) byHour.set(h, pick(r));
  }
  return [...byHour.entries()].map(([hourTs, v]) => ({ hourTs, ...v })).sort((a, b) => a.hourTs - b.hourTs);
}
