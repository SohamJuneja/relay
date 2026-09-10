// A chart's x-axis is a claim about a range, and the range has to be complete.
//
// The partner breakdown returned only the hours that had fills. One trade meant one
// point, and a bar chart given a single x value invents an axis around it — the live
// dashboard drew one bar labelled "Dec 2026 … Jun 2029" for a partner with a single
// fill in the last 24 hours.

import { describe, expect, it } from "vitest";
import { bucketSecondsFor, bucketsEnding, hourBuckets } from "./hourly.js";

const HOUR = 3600;
// 2026-09-10T08:00:00Z, exactly on an hour boundary.
const NOW_HOUR = 1789027200;

describe("hourBuckets", () => {
  it("renders 24 buckets with one non-zero for a single fill in a 24 h range", () => {
    const rows = [{ hour_ts: NOW_HOUR - 5 * HOUR, fills: 1, notional: "1347318", wallets: 1 }];

    const out = hourBuckets(NOW_HOUR, 24, rows, (r) => ({
      fills: Number(r.fills),
      notional: Number(r.notional) / 1e6,
      uniqueWallets: Number(r.wallets),
    }));

    expect(out).toHaveLength(24);
    const nonZero = out.filter((b) => b.fills > 0);
    expect(nonZero).toHaveLength(1);
    expect(nonZero[0]!.hourTs).toBe(NOW_HOUR - 5 * HOUR);
    expect(nonZero[0]!.fills).toBe(1);
    // Every other bucket is present and explicitly zero, not absent.
    expect(out.filter((b) => b.fills === 0)).toHaveLength(23);
    expect(out.every((b) => typeof b.notional === "number")).toBe(true);
  });

  it("covers exactly the requested count for 6 h and 7 d", () => {
    expect(hourBuckets(NOW_HOUR, 6, [], () => ({ fills: 0 }))).toHaveLength(6);
    expect(hourBuckets(NOW_HOUR, 168, [], () => ({ fills: 0 }))).toHaveLength(168);
  });

  it("ends on the hour in progress, so a fill placed a minute ago is on the chart", () => {
    // The regression this exists for: anchoring on `since` ended the range an hour
    // short and a two-minute-old fill landed outside it — 24 buckets, 0 non-zero.
    const nowish = NOW_HOUR + 35 * 60;
    const out = hourBuckets(nowish, 24, [{ hour_ts: nowish, fills: 1 }], (r) => ({ fills: Number(r.fills) }));
    expect(out).toHaveLength(24);
    expect(out[out.length - 1]!.hourTs).toBe(NOW_HOUR);
    expect(out[out.length - 1]!.fills).toBe(1);
    expect(out[0]!.hourTs).toBe(NOW_HOUR - 23 * HOUR);
  });

  it("is contiguous, ascending, and exactly one hour apart", () => {
    const out = hourBuckets(NOW_HOUR, 24, [], () => ({ fills: 0 }));
    for (let i = 1; i < out.length; i++) {
      expect(out[i]!.hourTs - out[i - 1]!.hourTs).toBe(HOUR);
    }
    expect(out[0]!.hourTs).toBeLessThan(out[out.length - 1]!.hourTs);
  });

  it("snaps a mid-hour end down to its hour boundary", () => {
    const out = hourBuckets(NOW_HOUR + 1799, 3, [], () => ({ fills: 0 }));
    expect(out[out.length - 1]!.hourTs).toBe(NOW_HOUR);
    expect(out.every((b) => b.hourTs % HOUR === 0)).toBe(true);
  });

  it("snaps a row's timestamp to its bucket rather than dropping it", () => {
    // fills.block_ts is a real block time, not an hour boundary.
    const rows = [{ hour_ts: NOW_HOUR + 1234, fills: 3 }];
    const out = hourBuckets(NOW_HOUR + 1234, 2, rows, (r) => ({ fills: Number(r.fills) }));
    expect(out[1]!.fills).toBe(3);
    expect(out[0]!.fills).toBe(0);
  });

  it("ignores rows outside the range instead of widening it", () => {
    const rows = [{ hour_ts: NOW_HOUR - 500 * HOUR, fills: 9 }];
    const out = hourBuckets(NOW_HOUR, 24, rows, (r) => ({ fills: Number(r.fills) }));
    expect(out).toHaveLength(24);
    expect(out.every((b) => b.fills === 0)).toBe(true);
  });

  it("treats timestamps as seconds, not milliseconds", () => {
    // A millisecond value would land ~55 000 years away and be dropped; this asserts
    // the units the API and the chart agree on.
    const out = hourBuckets(NOW_HOUR, 2, [{ hour_ts: NOW_HOUR * 1000, fills: 7 }], (r) => ({ fills: Number(r.fills) }));
    expect(out.every((b) => b.fills === 0)).toBe(true);
    expect(out[0]!.hourTs).toBeLessThan(2_000_000_000);
  });
});

describe("bucketSecondsFor", () => {
  it("stays hourly up to a week and switches to daily beyond it", () => {
    expect(bucketSecondsFor(6)).toBe(3600);
    expect(bucketSecondsFor(24)).toBe(3600);
    expect(bucketSecondsFor(168)).toBe(3600);
    expect(bucketSecondsFor(169)).toBe(86400);
    // The console's "all" span: 90 days would be 2 160 hourly buckets.
    expect(bucketSecondsFor(24 * 90)).toBe(86400);
  });
});

describe("bucketsEnding with daily buckets", () => {
  const DAY = 86400;
  // 2026-09-10T00:00:00Z
  const TODAY = Math.floor(1789027200 / DAY) * DAY;

  it("gives one bucket per day for a 90-day range", () => {
    const out = bucketsEnding(TODAY + 12 * 3600, 90, DAY, [], () => ({ fills: 0 }));
    expect(out).toHaveLength(90);
    expect(out[out.length - 1]!.hourTs).toBe(TODAY);
    expect(out[1]!.hourTs - out[0]!.hourTs).toBe(DAY);
  });

  it("sums the hourly rows that fall inside one day", () => {
    // The hourly path never had to merge — one row per bucket. Daily buckets take
    // many, and overwriting instead of adding would silently report only the last.
    const rows = [
      { hour_ts: TODAY + 1 * 3600, fills: 2, notional: 10 },
      { hour_ts: TODAY + 5 * 3600, fills: 3, notional: 25 },
      { hour_ts: TODAY - 2 * 3600, fills: 7, notional: 70 },
    ];
    const out = bucketsEnding(TODAY + 12 * 3600, 2, DAY, rows, (r) => ({ fills: Number(r.fills), notional: Number(r.notional) }));
    expect(out).toHaveLength(2);
    expect(out[1]!.fills).toBe(5);
    expect(out[1]!.notional).toBe(35);
    // Yesterday's row stays in yesterday.
    expect(out[0]!.fills).toBe(7);
  });

  it("is identical to hourBuckets when the step is an hour", () => {
    const rows = [{ hour_ts: 1789027200 - 5 * 3600, fills: 1 }];
    const a = hourBuckets(1789027200, 24, rows, (r) => ({ fills: Number(r.fills) }));
    const b = bucketsEnding(1789027200, 24, 3600, rows, (r) => ({ fills: Number(r.fills) }));
    expect(b).toEqual(a);
  });
});
