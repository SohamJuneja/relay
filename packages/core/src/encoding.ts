// Wire encoding for binary pools. Everything here is integer-exact; floats are
// only ever produced for DISPLAY.
//
// Sources: hackathon SKILL.md ("Encoding"), kit docs/gotchas.md #17 (prices are
// scaled to the collateral's decimals, NOT a fixed 1e6), kit ec-core/orders.ts
// (why floats must never reach an 18-decimal venue), markets-sdk writer.ts
// (ORDER_KIND) and index.js (ORDER_TYPE, SELF_MATCHING_OPTION).

import { formatUnits, parseUnits } from "viem";

/** placeBinaryOrder `kind`. YES = Up, NO = Down. */
export const ORDER_KIND = {
  BUY_YES: 0,
  SELL_YES: 1,
  BUY_NO: 2,
  SELL_NO: 3,
} as const;
export type OrderKind = keyof typeof ORDER_KIND;
export const ORDER_KIND_NAMES: readonly OrderKind[] = ["BUY_YES", "SELL_YES", "BUY_NO", "SELL_NO"];

/** placeBinaryOrder `orderType`. The SDK calls 2 `MARKET`; the template calls it IOC. */
export const ORDER_TYPE = {
  LIMIT: 0,
  FILL_OR_KILL: 1,
  IOC: 2,
  POST_ONLY: 3,
} as const;

export const SELF_MATCHING_OPTION = {
  CANCEL_TAKER: 0,
  CANCEL_MAKER: 1,
} as const;

/** 10^decimals — "one whole contract" / "probability 1.0" in raw units. */
export function oneCollateral(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

/**
 * Probability in [0,1] → raw YES price. Goes through a decimal STRING so
 * 0.05 on an 18-dp venue is exactly 5e16, never 50000000000000003.
 */
export function probabilityToPrice(probability: number, decimals: number): bigint {
  if (!(probability >= 0 && probability <= 1)) {
    throw new Error(`probability must be in [0,1], got ${probability}`);
  }
  return parseUnits(probability.toFixed(Math.min(decimals, 18)), decimals);
}

export function priceToProbability(rawPrice: bigint, decimals: number): number {
  return Number(formatUnits(rawPrice, decimals));
}

/** "0.727" — probability with fixed decimals, for display. */
export function formatProbability(rawPrice: bigint, decimals: number, dp = 3): string {
  return priceToProbability(rawPrice, decimals).toFixed(dp);
}

/** NO-side price is the complement of YES in integer space. */
export function noPriceFromYes(yesPrice: bigint, one: bigint): bigint {
  return one - yesPrice;
}

/** Order expiry: unix seconds → nanoseconds (uint64). Must be <= pool.marketExpiryNs(). */
export function expiryNsFromSec(sec: number | bigint): bigint {
  return BigInt(sec) * 1_000_000_000n;
}

export function nsToSec(ns: bigint): number {
  return Number(ns / 1_000_000_000n);
}

/**
 * Fee units. Pools express fees as bps × 1000:
 *   100000 = 100 bps = 1.00 %   (the mainnet maxBuilderFee cap per the kit)
 */
export function bpsTimes1kFromPercent(pct: number): bigint {
  return BigInt(Math.round(pct * 100 * 1000));
}
export function percentFromBpsTimes1k(x: bigint): number {
  return Number(x) / 1000 / 100;
}
export function formatBpsTimes1k(x: bigint): string {
  const bps = Number(x) / 1000;
  return `${x.toString()} (= ${bps} bps = ${(bps / 100).toFixed(4)} %)`;
}

/** Raw collateral/outcome units → human string. */
export function formatRaw(raw: bigint, decimals: number): string {
  return formatUnits(raw, decimals);
}

/**
 * Snap a raw price DOWN to the tick grid and a raw quantity DOWN to the lot
 * grid. Returns 0n when below one step. Integer-only; safe on any decimals.
 */
export function snapDown(raw: bigint, step: bigint): bigint {
  if (step <= 0n) return raw;
  return (raw / step) * step;
}

/**
 * ERC-6909 outcome id encoding (markets-sdk ids.ts):
 *   id = (pool << 72) | (nonce << 8) | idx
 */
export function outcomeId(pool: `0x${string}`, nonce: bigint | number, idx: 0 | 1): bigint {
  return (BigInt(pool) << 72n) | ((BigInt(nonce) & ((1n << 64n) - 1n)) << 8n) | BigInt(idx);
}
export function decodeOutcomeId(id: bigint): { pool: `0x${string}`; nonce: bigint; idx: number } {
  const idx = Number(id & 0xffn);
  const nonce = (id >> 8n) & ((1n << 64n) - 1n);
  const pool = `0x${(id >> 72n).toString(16).padStart(40, "0")}` as `0x${string}`;
  return { pool, nonce, idx };
}
/** Settlement record key = outcomeId >> 8 (pool + nonce, no idx). */
export function marketKey(outcomeIdValue: bigint): bigint {
  return outcomeIdValue >> 8n;
}
