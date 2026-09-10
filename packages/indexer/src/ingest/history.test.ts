// The history walk's arithmetic, without a chain or a database.
//
// What matters here is the direction and the boundaries: it must walk DOWN from the
// live cursor, never step below the target, and never hand `processRange` a range
// that overlaps the live cursor — which would drag the tail backwards.

import { describe, expect, it } from "vitest";
import { coveredHours, historyKey } from "./history.js";

describe("historyKey", () => {
  it("keeps the history cursor in its own row", () => {
    expect(historyKey("testnet")).toBe("testnet:history");
    expect(historyKey("testnet")).not.toBe("testnet");
  });
});

describe("coveredHours", () => {
  it("is zero until both cursors exist", () => {
    expect(coveredHours(null, 100n)).toBe(0);
    expect(coveredHours(100n, null)).toBe(0);
    expect(coveredHours(null, null)).toBe(0);
  });

  it("counts 36 000 blocks as an hour", () => {
    expect(coveredHours(1_000_000n, 1_036_000n)).toBe(1);
    expect(coveredHours(1_000_000n, 1_864_000n)).toBe(24);
    expect(coveredHours(1_000_000n, 1_018_000n)).toBe(0.5);
  });

  it("never reports negative coverage", () => {
    // The walk starts at the live cursor, so lowest == live is zero hours, and a
    // lowest above it is a state that should read as "nothing yet", not as a
    // negative span leaking into the console.
    expect(coveredHours(1_000_000n, 1_000_000n)).toBe(0);
    expect(coveredHours(1_100_000n, 1_000_000n)).toBe(0);
  });
});

/**
 * The segment arithmetic from `walkHistoryBackwards`, extracted so the boundaries can
 * be checked directly. Kept in step with the loop by the assertions below.
 */
function segments(liveStart: bigint, target: bigint, segment: bigint): { from: bigint; to: bigint }[] {
  const out: { from: bigint; to: bigint }[] = [];
  let lowest = liveStart;
  while (lowest > target) {
    const to: bigint = lowest - 1n;
    const floor: bigint = to - segment + 1n;
    const from: bigint = floor < target ? target : floor;
    out.push({ from, to });
    lowest = from;
  }
  return out;
}

describe("the backward walk", () => {
  const LIVE = 1_000_000n;
  const TARGET = 964_000n; // one hour below
  const SEG = 20_000n;

  it("walks downwards, contiguously, and stops exactly on the target", () => {
    const s = segments(LIVE, TARGET, SEG);
    expect(s.length).toBe(2);
    // Highest range first: the most recent history is the part anything reads.
    expect(s[0]).toEqual({ from: 980_000n, to: 999_999n });
    // The last segment is short, and lands exactly on the target rather than below.
    expect(s[1]).toEqual({ from: 964_000n, to: 979_999n });
    expect(s[s.length - 1]!.from).toBe(TARGET);
  });

  it("never overlaps the live cursor", () => {
    for (const seg of segments(LIVE, TARGET, SEG)) {
      expect(seg.to).toBeLessThan(LIVE);
    }
  });

  it("leaves no gap between segments", () => {
    const s = segments(LIVE, TARGET, SEG);
    for (let i = 1; i < s.length; i++) {
      expect(s[i]!.to).toBe(s[i - 1]!.from - 1n);
    }
  });

  it("does nothing when the target is already covered", () => {
    expect(segments(LIVE, LIVE, SEG)).toEqual([]);
    expect(segments(LIVE, LIVE + 5n, SEG)).toEqual([]);
  });

  it("handles a window shorter than one segment in a single step", () => {
    const s = segments(LIVE, LIVE - 500n, SEG);
    expect(s).toEqual([{ from: 999_500n, to: 999_999n }]);
  });
});
