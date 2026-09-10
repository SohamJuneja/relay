import { describe, expect, it } from "vitest";
import { aggregateVenueDaily, dayOf, summarise, type MarketAgg } from "./compute.js";

const V = "0x6797";
const DAY = Date.UTC(2026, 8, 8) / 1000; // 2026-09-08T00:00Z
const mk = (i: number, over: Partial<MarketAgg>): MarketAgg => ({
  marketId: `m${i}`,
  venueId: V,
  asset: "BTC",
  intervalSec: 300,
  expiry: DAY + 300 * (i + 1),
  fills: 0,
  notional: 0n,
  uniqueTakers: 0,
  restedBids: 0,
  restedAsks: 0,
  ...over,
});

describe("zero-fill and quoted-but-untaken on a synthetic day", () => {
  it("classifies windows and sums the day", () => {
    const rows: MarketAgg[] = [
      mk(0, { fills: 3, notional: 300n, restedBids: 2, restedAsks: 2 }), // traded
      mk(1, { restedBids: 1, restedAsks: 1 }), // quoted both sides, nobody took → zero-fill AND quoted-but-untaken
      mk(2, { restedBids: 1 }), // one-sided quote → zero-fill only
      mk(3, {}), // never quoted → zero-fill only
      mk(4, { fills: 1, notional: 50n, restedBids: 0, restedAsks: 0 }), // filled without a resting quote seen (pre-window maker)
      mk(5, { asset: "ETH", restedBids: 1, restedAsks: 1 }), // another series
      mk(6, { expiry: DAY + 86400 + 60, restedBids: 1, restedAsks: 1 }), // next day
    ];
    const out = aggregateVenueDaily(rows);
    const btc = out.find((g) => g.asset === "BTC" && g.day === dayOf(DAY + 1))!;
    expect(btc.windows).toBe(5);
    expect(btc.zeroFillWindows).toBe(3);
    expect(btc.quotedButUntakenWindows).toBe(1);
    expect(btc.fills).toBe(4);
    expect(btc.notional).toBe(350n);
    const eth = out.find((g) => g.asset === "ETH")!;
    expect(eth.windows).toBe(1);
    expect(eth.zeroFillWindows).toBe(1);
    expect(eth.quotedButUntakenWindows).toBe(1);
    const next = out.find((g) => g.asset === "BTC" && g.day === dayOf(DAY + 86400 + 60))!;
    expect(next.windows).toBe(1);
    expect(out).toHaveLength(3);
  });

  it("zero-fill share reproduces the Phase 0 arithmetic", () => {
    // Phase 0: DreamDEX venue, 198 completed windows, 85 zero-fill → 42.9 %
    const rows: MarketAgg[] = Array.from({ length: 198 }, (_, i) => mk(i, { fills: i < 85 ? 0 : 1, expiry: DAY + 60 * i }));
    const g = aggregateVenueDaily(rows)[0]!;
    expect(g.windows).toBe(198);
    expect(((100 * g.zeroFillWindows) / g.windows).toFixed(1)).toBe("42.9");
  });
});

describe("one definition of quoted-but-untaken", () => {
  // The live failure this guards: the headline KPI said 34.5% and the per-series
  // table directly beneath it said 3.5%, because they were computed by different
  // code with different ideas of what counts as quoted.
  const day = Date.UTC(2026, 8, 8) / 1000;
  const mk = (i: number, over: Partial<MarketAgg>): MarketAgg => ({
    marketId: `m${i}`,
    venueId: V,
    asset: i % 2 ? "ETH" : "BTC",
    intervalSec: i % 3 === 0 ? 300 : 900,
    expiry: day + 300 * (i + 1),
    fills: 0,
    notional: 0n,
    uniqueTakers: 0,
    restedBids: 0,
    restedAsks: 0,
    ...over,
  });

  const population: MarketAgg[] = [
    mk(0, { fills: 4, notional: 400n, restedBids: 1, restedAsks: 1 }),
    mk(1, { restedBids: 1, restedAsks: 1 }),
    mk(2, { restedBids: 1 }),
    mk(3, {}),
    mk(4, { restedBids: 1, restedAsks: 1 }),
    mk(5, { fills: 1, notional: 20n }),
    mk(6, { restedAsks: 1 }),
    mk(7, { restedBids: 1, restedAsks: 1 }),
  ];

  it("per-series sums equal the venue total", () => {
    const total = summarise(population);

    const bySeries = new Map<string, MarketAgg[]>();
    for (const m of population) {
      const k = `${m.asset}|${m.intervalSec}`;
      bySeries.set(k, [...(bySeries.get(k) ?? []), m]);
    }
    const parts = [...bySeries.values()].map(summarise);

    const sum = (f: (s: ReturnType<typeof summarise>) => number) => parts.reduce((a, p) => a + f(p), 0);
    expect(sum((p) => p.windows)).toBe(total.windows);
    expect(sum((p) => p.zeroFillWindows)).toBe(total.zeroFillWindows);
    expect(sum((p) => p.quotedButUntakenWindows)).toBe(total.quotedButUntakenWindows);
    expect(sum((p) => p.fills)).toBe(total.fills);
    expect(parts.reduce((a, p) => a + p.notional, 0n)).toBe(total.notional);
  });

  it("untaken is always a subset of zero-fill", () => {
    const t = summarise(population);
    expect(t.quotedButUntakenWindows).toBeLessThanOrEqual(t.zeroFillWindows);
    expect(t.zeroFillWindows).toBeLessThanOrEqual(t.windows);
    // Concretely: 6 of 8 windows never filled, and 3 of those had BOTH sides quoted
    // (m1, m4, m7). m2 had only bids, m6 only asks, m3 nothing — one-sided liquidity
    // is not an offer anyone refused.
    expect(t.windows).toBe(8);
    expect(t.zeroFillWindows).toBe(6);
    expect(t.quotedButUntakenWindows).toBe(3);
  });

  it("a filled window is never untaken, however it was quoted", () => {
    expect(summarise([mk(0, { fills: 1, restedBids: 9, restedAsks: 9 })]).quotedButUntakenWindows).toBe(0);
  });

  it("the daily rollup agrees with summarise on the same rows", () => {
    const daily = aggregateVenueDaily(population);
    const total = summarise(population);
    expect(daily.reduce((a, g) => a + g.windows, 0)).toBe(total.windows);
    expect(daily.reduce((a, g) => a + g.zeroFillWindows, 0)).toBe(total.zeroFillWindows);
    expect(daily.reduce((a, g) => a + g.quotedButUntakenWindows, 0)).toBe(total.quotedButUntakenWindows);
  });
});
