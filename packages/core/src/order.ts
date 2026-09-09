// Pure order math — no I/O, no clients. Shared by the Node signer (trade.ts)
// and the browser widget so both produce byte-identical `placeBinaryOrder` args.
//
// Encoding recap (PROTOCOL_NOTES §3, §6):
//   - the pool stores ONE book, quoted in YES terms. Buying UP crosses YES asks;
//     buying DOWN (BUY_NO) crosses YES bids and pays `one − yesPrice` per NO.
//   - so for either side the levels to walk are already best-first, and the
//     price in the outcome's OWN terms is `UP ? level.price : one − level.price`.
//   - price snaps to tickSize, quantity to lotSize, quantity ≥ minQuantity.
//   - an IOC that crosses nothing REVERTS (ImmediateOrCancelNoFill), and the
//     touch moves between the read and the send, so the limit is priced a few
//     ticks THROUGH the touch. The pool escrows at the limit and refunds the
//     difference in the same transaction — the taker pays the maker's price.

import { toFunctionSelector } from "viem";
import type { Address, Hex } from "viem";
import { ZERO_ADDRESS } from "./addresses.js";
import { binaryModuleWriteAbi, binaryPoolWriteAbi, erc20Abi, outcomeToken6909Abi, testUsdcAbi } from "./abi/index.js";
import { ORDER_KIND, ORDER_TYPE, SELF_MATCHING_OPTION, expiryNsFromSec, snapDown } from "./encoding.js";

export interface BookLevelRaw {
  price: bigint;
  quantity: bigint;
}

/** `getOrderBookParameters()` — the grid the pool validates every order against. */
export interface GridParams {
  tickSize: bigint;
  minQuantity: bigint;
  lotSize: bigint;
}

export interface PartnerTagInput {
  /** Partner builder code. Zero / omitted = untagged on the fee channel. */
  builder?: Address | undefined;
  /** bps × 1000, ≤ pool cap and ≤ the user's approveBuilder cap. Testnet cap is 0. */
  builderFeeBpsTimes1k?: bigint | undefined;
  /** Relay attribution tag (attribution.ts `encodeUserData`). */
  userData: bigint;
}

export interface BuildTakerOrderInput {
  outcome: "UP" | "DOWN";
  /** Resting YES bids, best (highest) first. */
  yesBids: readonly BookLevelRaw[];
  /** Resting YES asks, best (lowest) first. */
  yesAsks: readonly BookLevelRaw[];
  /** 10^collateralDecimals. */
  one: bigint;
  grid: GridParams;
  /** Raw collateral the user wants to spend. Ignored when `quantity` is given. */
  budget?: bigint | undefined;
  /** Explicit raw quantity — overrides budget sizing. */
  quantity?: bigint | undefined;
  /** Ticks to price through the touch. Default 5. */
  crossTicks?: bigint | undefined;
  /** Refuse if the touch costs more than this (own terms). */
  maxPrice?: bigint | undefined;
  partner: PartnerTagInput;
  /** Unix seconds. Order expiry = min(now + expireInSec, marketExpirySec). */
  nowSec: number;
  expireInSec?: number | undefined;
  /** `pool.marketExpiryNs()` — the hard cap the pool enforces. */
  marketExpiryNs: bigint;
  /** Venue settlement fee (bps × 1000) for the payout estimate. 0 on testnet. */
  settlementFeeBpsTimes1k?: bigint | undefined;
}

export interface WalkedLevel {
  /** Price in the outcome's own terms (what the buyer pays per share). */
  priceOwn: bigint;
  quantity: bigint;
  cost: bigint;
}

export type OrderKindValue = (typeof ORDER_KIND)[keyof typeof ORDER_KIND];

/** The exact tuple `placeBinaryOrder(kind, price, quantity, expireNs, orderType, selfMatch, builder, fee, userData)` takes. */
export type PlaceBinaryOrderArgs = readonly [number, bigint, bigint, bigint, number, number, Address, bigint, bigint];

export interface TakerOrderQuote {
  ok: boolean;
  /** Why the order cannot be built (empty side, dust, unaffordable, window closed). */
  reason: string | null;
  outcome: "UP" | "DOWN";
  kind: OrderKindValue;
  /** Best available price in the outcome's own terms; null when that side is empty. */
  touchOwn: bigint | null;
  /** The limit actually sent, in own terms and in YES terms (what goes on the wire). */
  limitOwn: bigint;
  limitYes: bigint;
  /** Lot-snapped quantity. */
  qty: bigint;
  /** Levels the order is expected to consume at current depth. */
  levels: WalkedLevel[];
  /** Volume-weighted expected price (own terms) over `levels`; null when nothing fills. */
  avgPriceOwn: bigint | null;
  /** Expected spend at current depth — the honest "max loss" for a taker buy. */
  cost: bigint;
  /** What the pool locks up front: ceil(limitOwn × qty / one). Refunded down to `cost`. */
  escrow: bigint;
  /** Winning shares redeem 1 − settlementFee each. */
  payoutIfWin: bigint;
  profitIfWin: bigint;
  /** True when the book had less depth than the budget asked for. */
  depthLimited: boolean;
  expireTimestampNs: bigint;
  /** Ready to pass to `placeBinaryOrder`. Meaningless unless `ok`. */
  args: PlaceBinaryOrderArgs;
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** Walk `levels` (best-first, own terms) until `qty` shares or `budget` is used up. */
function walk(
  levels: readonly BookLevelRaw[],
  toOwn: (p: bigint) => bigint,
  one: bigint,
  limit: { qty?: bigint | undefined; budget?: bigint | undefined },
): { taken: bigint; cost: bigint; out: WalkedLevel[]; exhausted: boolean } {
  const out: WalkedLevel[] = [];
  let taken = 0n;
  let cost = 0n;
  for (const l of levels) {
    if (limit.qty !== undefined && taken >= limit.qty) break;
    const priceOwn = toOwn(l.price);
    if (priceOwn <= 0n) continue;
    let take = l.quantity;
    if (limit.qty !== undefined) {
      const room = limit.qty - taken;
      if (take > room) take = room;
    }
    if (limit.budget !== undefined) {
      const left = limit.budget - cost;
      if (left <= 0n) break;
      const affordable = (left * one) / priceOwn;
      if (take > affordable) take = affordable;
    }
    if (take <= 0n) break;
    const c = ceilDiv(priceOwn * take, one);
    out.push({ priceOwn, quantity: take, cost: c });
    taken += take;
    cost += c;
  }
  const wantedAll = limit.qty !== undefined ? taken >= limit.qty : false;
  return { taken, cost, out, exhausted: !wantedAll };
}

/**
 * Build a taker IOC buy from a book snapshot. Pure: the same inputs always give
 * the same `args`, which is what lets the widget preview exactly what it signs.
 */
export function buildTakerOrder(input: BuildTakerOrderInput): TakerOrderQuote {
  const { outcome, one, grid, partner } = input;
  const kind = (outcome === "UP" ? ORDER_KIND.BUY_YES : ORDER_KIND.BUY_NO) as OrderKindValue;
  const crossTicks = input.crossTicks ?? 5n;
  const settlementFee = input.settlementFeeBpsTimes1k ?? 0n;
  const levels = outcome === "UP" ? input.yesAsks : input.yesBids;
  const toOwn = (p: bigint) => (outcome === "UP" ? p : one - p);

  const wantNs = expiryNsFromSec(input.nowSec + (input.expireInSec ?? 45));
  const expireTimestampNs = wantNs < input.marketExpiryNs ? wantNs : input.marketExpiryNs;

  const fail = (reason: string, partialTouch: bigint | null = null): TakerOrderQuote => ({
    ok: false,
    reason,
    outcome,
    kind,
    touchOwn: partialTouch,
    limitOwn: 0n,
    limitYes: 0n,
    qty: 0n,
    levels: [],
    avgPriceOwn: null,
    cost: 0n,
    escrow: 0n,
    payoutIfWin: 0n,
    profitIfWin: 0n,
    depthLimited: false,
    expireTimestampNs,
    args: [kind, 0n, 0n, expireTimestampNs, ORDER_TYPE.IOC, SELF_MATCHING_OPTION.CANCEL_TAKER, partner.builder ?? ZERO_ADDRESS, partner.builderFeeBpsTimes1k ?? 0n, partner.userData],
  });

  const top = levels[0];
  if (!top) {
    return fail(outcome === "UP" ? "no YES asks resting — nothing to buy UP against" : "no YES bids resting — nothing to buy DOWN against");
  }
  if (expireTimestampNs <= expiryNsFromSec(input.nowSec)) return fail("market expiry has passed", toOwn(top.price));

  const touchYes = top.price;
  const touchOwn = toOwn(touchYes);
  if (input.maxPrice !== undefined && touchOwn > input.maxPrice) {
    return fail(`best ${outcome} price ${touchOwn} exceeds maxPrice ${input.maxPrice}`, touchOwn);
  }

  // Limit: `crossTicks` THROUGH the touch, clamped inside (0, one) and to maxPrice.
  const cross = crossTicks * grid.tickSize;
  let limitYes: bigint;
  if (outcome === "UP") limitYes = touchYes + cross < one ? touchYes + cross : one - grid.tickSize;
  else limitYes = touchYes > cross ? touchYes - cross : grid.tickSize;
  let limitOwn = toOwn(limitYes);
  if (input.maxPrice !== undefined && limitOwn > input.maxPrice) {
    const clamped = snapDown(input.maxPrice, grid.tickSize);
    limitOwn = clamped;
    limitYes = outcome === "UP" ? clamped : one - clamped;
  }
  if (limitYes <= 0n || limitYes >= one) return fail(`limit ${limitYes} outside (0, ${one}) after snapping`, touchOwn);

  // Size: the book walk says what the budget really buys; the escrow cap keeps
  // us inside the budget even if every share fills at the worst (limit) price.
  let qty: bigint;
  let depthLimited = false;
  if (input.quantity !== undefined) {
    qty = snapDown(input.quantity, grid.lotSize);
  } else {
    const budget = input.budget ?? 0n;
    if (budget <= 0n) return fail("no budget and no quantity", touchOwn);
    const byWalk = walk(levels, toOwn, one, { budget });
    const byEscrow = (budget * one) / limitOwn;
    const raw = byWalk.taken < byEscrow ? byWalk.taken : byEscrow;
    qty = snapDown(raw, grid.lotSize);
    depthLimited = byWalk.taken <= byEscrow && byWalk.exhausted;
  }
  if (qty <= 0n || qty < grid.minQuantity) {
    return fail(`quantity ${qty} below minQuantity ${grid.minQuantity} (raise the amount)`, touchOwn);
  }

  const filled = walk(levels, toOwn, one, { qty });
  const cost = filled.cost;
  const escrow = ceilDiv(limitOwn * qty, one);
  const avgPriceOwn = filled.taken > 0n ? (cost * one) / filled.taken : null;
  const payoutIfWin = qty - (qty * settlementFee) / 10_000_000n;

  return {
    ok: true,
    reason: null,
    outcome,
    kind,
    touchOwn,
    limitOwn,
    limitYes,
    qty,
    levels: filled.out,
    avgPriceOwn,
    cost,
    escrow,
    payoutIfWin,
    profitIfWin: payoutIfWin - cost,
    depthLimited: depthLimited || filled.taken < qty,
    expireTimestampNs,
    args: [kind, limitYes, qty, expireTimestampNs, ORDER_TYPE.IOC, SELF_MATCHING_OPTION.CANCEL_TAKER, partner.builder ?? ZERO_ADDRESS, partner.builderFeeBpsTimes1k ?? 0n, partner.userData],
  };
}

// ───────────────────────────── contract call builders ─────────────────────────────
// Shaped for `walletClient.writeContract(...)` / `publicClient.simulateContract(...)`,
// so the widget never hand-rolls an ABI.

export interface ContractCall {
  address: Address;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
}

export const buildPlaceOrderCall = (pool: Address, args: PlaceBinaryOrderArgs): ContractCall => ({
  address: pool,
  abi: binaryPoolWriteAbi,
  functionName: "placeBinaryOrder",
  args,
});

export const buildApproveCall = (collateral: Address, spender: Address, amount: bigint): ContractCall => ({
  address: collateral,
  abi: erc20Abi,
  functionName: "approve",
  args: [spender, amount],
});

/** tUSDC only (testnet): the public faucet. */
export const buildFaucetCall = (testUsdc: Address, amount: bigint): ContractCall => ({
  address: testUsdc,
  abi: testUsdcAbi,
  functionName: "faucet",
  args: [amount],
});

/** One-time ERC-6909 grant so the module can pull outcome tokens on redeem. */
export const buildSetOperatorCall = (outcomeToken: Address, operator: Address): ContractCall => ({
  address: outcomeToken,
  abi: outcomeToken6909Abi,
  functionName: "setOperator",
  args: [operator, true],
});

export interface RedeemInput {
  binaryModule: Address;
  operatorId: number;
  venueId: Hex;
  marketId: Hex;
  /** 0 = YES/UP, 1 = NO/DOWN. */
  outcomeIdx: 0 | 1;
  amount: bigint;
}

export const buildRedeemCall = (r: RedeemInput): ContractCall => ({
  address: r.binaryModule,
  abi: binaryModuleWriteAbi,
  functionName: "redeem",
  args: [r.operatorId, r.venueId, r.marketId, r.outcomeIdx, r.amount],
});

/**
 * `redeemMany(operatorId, venueId, bytes32[], uint8[], uint256[])` — one tx for
 * several claims. It is in the module ABI but not necessarily in the DEPLOYED
 * bytecode, so callers must check with `supportsRedeemMany` before using it.
 */
export function buildRedeemManyCall(p: { binaryModule: Address; operatorId: number; venueId: Hex; claims: { marketId: Hex; outcomeIdx: 0 | 1; amount: bigint }[] }): ContractCall {
  return {
    address: p.binaryModule,
    abi: binaryModuleWriteAbi,
    functionName: "redeemMany",
    args: [p.operatorId, p.venueId, p.claims.map((c) => c.marketId), p.claims.map((c) => c.outcomeIdx), p.claims.map((c) => c.amount)],
  };
}

/**
 * Function selectors for capability probing against `eth_getCode`.
 *
 * DERIVED from the same ABI the calls are encoded with, never hand-written. Both
 * constants were previously wrong (`0x8c0e156d` / `0x0b7bf5f1` against the real
 * `0x5b1ffcf2` / `0x88cb9474`), and because the only consumer is a bytecode
 * substring probe, a wrong value fails silently: `supportsRedeemMany` simply always
 * answered false and every claim fell back to one transaction per market. A selector
 * that cannot drift from its ABI is the fix.
 */
export const SELECTOR = {
  redeem: toFunctionSelector("function redeem(uint32,bytes32,bytes32,uint8,uint256)"),
  redeemMany: toFunctionSelector("function redeemMany(uint32,bytes32,bytes32[],uint8[],uint256[])"),
} as const;

/**
 * Does the deployed module actually implement `redeemMany`? The ABI says yes;
 * the bytecode is the authority (PROTOCOL_NOTES: never pin behaviour to an ABI).
 * Pass the module's runtime bytecode.
 *
 * CAVEAT: this cannot see through a proxy. A delegating stub carries no selectors,
 * so it answers false for every method — and the deployed BinaryMarketsModule on
 * Shannon is exactly that, 130 bytes. Against a proxy, probe by simulating the call
 * with `eth_call` instead; that is what the widget's claim path does.
 */
export function supportsRedeemMany(bytecode: string | null | undefined, selector = SELECTOR.redeemMany): boolean {
  if (!bytecode || bytecode.length < 10) return false;
  return bytecode.toLowerCase().includes(selector.slice(2).toLowerCase());
}
