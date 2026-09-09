import { describe, expect, it } from "vitest";
import { aggregateVenueDaily, dayOf, type MarketAgg } from "./compute.js";

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
