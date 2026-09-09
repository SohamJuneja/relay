// buildTakerOrder against the REAL Phase 1 orders: the book touch we recorded in
// the run log, fed back in, must reproduce the exact `placeBinaryOrder` args that
// were mined — decoded here from the fixture transactions' calldata.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { decodeFunctionData, type Address, type Hex } from "viem";
import { SURFACE, encodeUserData } from "./attribution.js";
import { binaryPoolWriteAbi } from "./abi/index.js";
import { ORDER_KIND, ORDER_TYPE, SELF_MATCHING_OPTION } from "./encoding.js";
import { SELECTOR, buildRedeemCall, buildRedeemManyCall, buildTakerOrder, supportsRedeemMany, type GridParams } from "./order.js";

const FIX = JSON.parse(
  readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../indexer/fixtures/phase1-receipts.json"), "utf8"),
) as Record<string, { input: Hex; to: Address }>;

const ONE = 10n ** 6n;
const GRID: GridParams = { tickSize: 1000n, minQuantity: 1000n, lotSize: 1000n };
const TAG = encodeUserData({ partnerId: 1, surfaceId: SURFACE.WEB });
const PARTNER = "0xb5eCf004491aa8589a82af91633D18867fcFF038" as Address;
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

function placedArgs(key: string) {
  const d = decodeFunctionData({ abi: binaryPoolWriteAbi, data: FIX[key]!.input });
  return d.args as unknown as readonly [number, bigint, bigint, bigint, number, number, Address, bigint, bigint];
}

describe("buildTakerOrder reproduces the Phase 1 orders", () => {
  // Run 2 A: BTC 15m, best YES ask 0.430 (touch own 430000), limit 5 ticks through
  // → 435000, one contract, builder 0. Mined as tx 0x743321c2…
  it("run 2 UP leg: 5 ticks through a 0.430 ask → limit 0.435", () => {
    const onChain = placedArgs("run2_A_up_builder0");
    const q = buildTakerOrder({
      outcome: "UP",
      yesBids: [{ price: 400_000n, quantity: 200_000_000n }],
      yesAsks: [{ price: 430_000n, quantity: 200_000_000n }],
      one: ONE,
      grid: GRID,
      quantity: 1n * ONE,
      partner: { userData: TAG },
      nowSec: 1_788_911_377,
      expireInSec: 45,
      marketExpiryNs: 1_788_912_000_000_000_000n,
    });
    expect(q.ok).toBe(true);
    expect(q.touchOwn).toBe(430_000n);
    expect(q.limitOwn).toBe(435_000n);
    expect(q.limitYes).toBe(onChain[1]); // 435000 on chain
    expect(q.qty).toBe(onChain[2]); // 1000000
    expect(q.args[0]).toBe(onChain[0]); // kind 0 BUY_YES
    expect(q.args[4]).toBe(onChain[4]); // orderType 2 IOC
    expect(q.args[5]).toBe(onChain[5]); // selfMatching 0
    expect(q.args[6]).toBe(onChain[6]); // builder address(0)
    expect(q.args[7]).toBe(onChain[7]); // fee 0
    expect(q.args[8]).toBe(onChain[8]); // userData = the Relay tag
    expect(q.args[8]).toBe(TAG);
    expect(q.expireTimestampNs).toBe(onChain[3]);
  });

  // Run 2 B: BUY_NO. Best YES bid 0.287 → NO touch 0.713; 5 ticks through on the
  // NO side means priceYes 0.282 (limit own 0.718). Mined as tx 0x250d902b…
  it("run 2 DOWN leg: BUY_NO crosses YES bids, limit priced below the bid", () => {
    const onChain = placedArgs("run2_B_down_partner");
    const q = buildTakerOrder({
      outcome: "DOWN",
      yesBids: [{ price: 287_000n, quantity: 200_000_000n }],
      yesAsks: [{ price: 320_000n, quantity: 200_000_000n }],
      one: ONE,
      grid: GRID,
      quantity: 1n * ONE,
      partner: { builder: PARTNER, builderFeeBpsTimes1k: 0n, userData: TAG },
      nowSec: 1_788_911_387,
      expireInSec: 45,
      marketExpiryNs: 1_788_912_000_000_000_000n,
    });
    expect(q.ok).toBe(true);
    expect(q.kind).toBe(ORDER_KIND.BUY_NO);
    expect(q.touchOwn).toBe(713_000n); // one − 287000
    expect(q.limitOwn).toBe(718_000n);
    expect(q.limitYes).toBe(282_000n);
    expect(q.limitYes).toBe(onChain[1]);
    expect(q.qty).toBe(onChain[2]);
    expect(q.args[6]?.toLowerCase()).toBe(onChain[6].toLowerCase()); // builder = PARTNER
    expect(q.args[8]).toBe(onChain[8]);
  });

  it("emits the canonical constants (IOC, cancel-taker) for every order", () => {
    const q = buildTakerOrder({
      outcome: "UP",
      yesBids: [],
      yesAsks: [{ price: 500_000n, quantity: 10n * ONE }],
      one: ONE,
      grid: GRID,
      budget: 1n * ONE,
      partner: { userData: TAG },
      nowSec: 1_000_000,
      marketExpiryNs: 10n ** 18n * 2n,
    });
    expect(q.args[4]).toBe(ORDER_TYPE.IOC);
    expect(q.args[5]).toBe(SELF_MATCHING_OPTION.CANCEL_TAKER);
    expect(q.args[6]).toBe(ZERO); // no builder → address(0)
    expect(q.args[7]).toBe(0n);
  });
});

describe("budget walks the book", () => {
  const book = [
    { price: 400_000n, quantity: 1n * ONE }, // 1 share @ 0.40 = 0.40
    { price: 450_000n, quantity: 2n * ONE }, // 2 shares @ 0.45 = 0.90
    { price: 500_000n, quantity: 10n * ONE },
  ];

  it("consumes several levels and reports the VWAP, not the touch", () => {
    const q = buildTakerOrder({
      outcome: "UP",
      yesBids: [],
      yesAsks: book,
      one: ONE,
      grid: GRID,
      budget: 2n * ONE, // $2
      crossTicks: 0n,
      partner: { userData: TAG },
      nowSec: 1_000_000,
      marketExpiryNs: 10n ** 18n * 2n,
    });
    expect(q.ok).toBe(true);
    // 0.40 + 0.90 = 1.30 for 3 shares, then 1.40 buys 1.4 shares at 0.50 → 4.4 shares
    expect(q.qty).toBe(4_400_000n);
    expect(q.levels).toHaveLength(3);
    expect(q.levels.map((l) => l.priceOwn)).toEqual([400_000n, 450_000n, 500_000n]);
    expect(q.cost).toBeLessThanOrEqual(2n * ONE);
    expect(q.avgPriceOwn).toBeGreaterThan(400_000n);
    expect(q.avgPriceOwn).toBeLessThan(500_000n);
    // one whole share pays out 1 collateral on a win
    expect(q.payoutIfWin).toBe(q.qty);
    expect(q.profitIfWin).toBe(q.payoutIfWin - q.cost);
  });

  it("caps size so the ESCROW at the limit still fits the budget", () => {
    const q = buildTakerOrder({
      outcome: "UP",
      yesBids: [],
      yesAsks: [{ price: 500_000n, quantity: 1000n * ONE }],
      one: ONE,
      grid: GRID,
      budget: 1n * ONE,
      crossTicks: 5n, // limit 0.505
      partner: { userData: TAG },
      nowSec: 1_000_000,
      marketExpiryNs: 10n ** 18n * 2n,
    });
    // budget/limit = 1/0.505 = 1.980 shares (not 2.0 at the touch)
    expect(q.qty).toBe(1_980_000n);
    expect(q.escrow).toBeLessThanOrEqual(1n * ONE);
    expect(q.cost).toBeLessThan(q.escrow); // fills at 0.50, escrows at 0.505
  });

  it("flags a book too thin for the budget", () => {
    const q = buildTakerOrder({
      outcome: "UP",
      yesBids: [],
      yesAsks: [{ price: 500_000n, quantity: 1n * ONE }],
      one: ONE,
      grid: GRID,
      budget: 10n * ONE,
      crossTicks: 0n,
      partner: { userData: TAG },
      nowSec: 1_000_000,
      marketExpiryNs: 10n ** 18n * 2n,
    });
    expect(q.qty).toBe(1n * ONE);
    expect(q.depthLimited).toBe(true);
  });

  it("subtracts the settlement fee from the win payout when the venue charges one", () => {
    const q = buildTakerOrder({
      outcome: "UP",
      yesBids: [],
      yesAsks: [{ price: 500_000n, quantity: 100n * ONE }],
      one: ONE,
      grid: GRID,
      quantity: 10n * ONE,
      settlementFeeBpsTimes1k: 100_000n, // 1 %
      partner: { userData: TAG },
      nowSec: 1_000_000,
      marketExpiryNs: 10n ** 18n * 2n,
    });
    expect(q.payoutIfWin).toBe(9_900_000n); // 10 shares − 1 %
  });
});

describe("refusals are explicit, never a silent zero", () => {
  const base = {
    one: ONE,
    grid: GRID,
    partner: { userData: TAG },
    nowSec: 1_000_000,
    marketExpiryNs: 10n ** 18n * 2n,
  } as const;

  it("empty side", () => {
    const up = buildTakerOrder({ ...base, outcome: "UP", yesBids: [{ price: 1n, quantity: 1n }], yesAsks: [], budget: ONE });
    expect(up.ok).toBe(false);
    expect(up.reason).toMatch(/no YES asks/);
    const down = buildTakerOrder({ ...base, outcome: "DOWN", yesBids: [], yesAsks: [{ price: 1n, quantity: 1n }], budget: ONE });
    expect(down.ok).toBe(false);
    expect(down.reason).toMatch(/no YES bids/);
  });

  it("dust budget below one lot", () => {
    const q = buildTakerOrder({ ...base, outcome: "UP", yesBids: [], yesAsks: [{ price: 500_000n, quantity: 100n * ONE }], budget: 100n });
    expect(q.ok).toBe(false);
    expect(q.reason).toMatch(/minQuantity/);
  });

  it("touch worse than maxPrice", () => {
    const q = buildTakerOrder({ ...base, outcome: "UP", yesBids: [], yesAsks: [{ price: 900_000n, quantity: 100n * ONE }], budget: 10n * ONE, maxPrice: 500_000n });
    expect(q.ok).toBe(false);
    expect(q.reason).toMatch(/exceeds maxPrice/);
  });

  it("expiry already passed", () => {
    const q = buildTakerOrder({ ...base, outcome: "UP", yesBids: [], yesAsks: [{ price: 500_000n, quantity: 100n * ONE }], budget: ONE, marketExpiryNs: 1n });
    expect(q.ok).toBe(false);
    expect(q.reason).toMatch(/expiry/);
  });
});

describe("redeem call builders", () => {
  const MODULE = "0x3ecC694Cef705358864a646142ac17A90E29e388" as Address;
  const MARKET = "0x00000000000000000000000000000000000000000000000000000000000177b0" as Hex;
  const VENUE = "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c" as Hex;

  it("builds redeem(operatorId, venueId, marketId, outcomeIdx, amount)", () => {
    const c = buildRedeemCall({ binaryModule: MODULE, operatorId: 2, venueId: VENUE, marketId: MARKET, outcomeIdx: 0, amount: 1n * ONE });
    expect(c.address).toBe(MODULE);
    expect(c.functionName).toBe("redeem");
    expect(c.args).toEqual([2, VENUE, MARKET, 0, 1n * ONE]);
  });

  it("builds redeemMany as parallel arrays", () => {
    const c = buildRedeemManyCall({
      binaryModule: MODULE,
      operatorId: 2,
      venueId: VENUE,
      claims: [
        { marketId: MARKET, outcomeIdx: 0, amount: 1n },
        { marketId: MARKET, outcomeIdx: 1, amount: 2n },
      ],
    });
    expect(c.functionName).toBe("redeemMany");
    expect(c.args[2]).toEqual([MARKET, MARKET]);
    expect(c.args[3]).toEqual([0, 1]);
    expect(c.args[4]).toEqual([1n, 2n]);
  });

  it("derives selectors from the ABI, so they cannot drift from the encoder", () => {
    // Both were hand-written and both were wrong. A wrong selector here fails
    // silently — the only consumer is a substring probe that simply answers "no".
    expect(SELECTOR.redeem).toBe("0x5b1ffcf2");
    expect(SELECTOR.redeemMany).toBe("0x88cb9474");
  });

  it("probes redeemMany from bytecode, and says no when there is none to read", () => {
    expect(supportsRedeemMany(null)).toBe(false);
    expect(supportsRedeemMany("0x")).toBe(false);
    expect(supportsRedeemMany(`0x60806040526${SELECTOR.redeemMany.slice(2)}00`)).toBe(true);
    // A proxy carries no selectors at all, so the probe cannot see through one —
    // the deployed BinaryMarketsModule is 130 bytes of delegating stub. Callers
    // that must work against a proxy simulate the call instead.
    expect(supportsRedeemMany("0x363d3d373d3d3d363d73bebebebebebebebebebebebebebebebebebebebe5af43d82803e903d91602b57fd5bf3")).toBe(false);
  });
});
