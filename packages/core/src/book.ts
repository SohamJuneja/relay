// Order-book reads. The pool stores ONE book in YES terms:
//   getBookLevels(true)  = resting YES bids  (best = highest price first)
//   getBookLevels(false) = resting YES asks  (best = lowest price first)
// The NO side is the complement (markets-sdk orders.ts toBinaryBook):
//   NO bids = YES asks at (one − price);  NO asks = YES bids at (one − price).
// A BUY_NO at p is economically a SELL_YES at 1−p, which is why the pool quotes
// every order on the YES side (kit gotcha #18).

import type { Address, PublicClient } from "viem";
import { binaryPoolReadAbi } from "./abi/index.js";
import { priceToProbability } from "./encoding.js";
import { batchRead, unwrap } from "./reads.js";

export interface BookLevel {
  price: bigint;
  quantity: bigint;
}

export interface YesBook {
  yesBids: BookLevel[];
  yesAsks: BookLevel[];
}

export interface FourSidedBook extends YesBook {
  noBids: BookLevel[];
  noAsks: BookLevel[];
}

/** Read YES bids+asks for many pools in one batch. `null` where a pool read failed. */
export async function readYesBooks(client: PublicClient, pools: readonly Address[], depth = 5): Promise<(YesBook | { error: string })[]> {
  const calls = pools.flatMap((address) => [
    { address, abi: binaryPoolReadAbi, functionName: "getBookLevels", args: [true, BigInt(depth)] },
    { address, abi: binaryPoolReadAbi, functionName: "getBookLevels", args: [false, BigInt(depth)] },
  ]);
  const res = await batchRead(client, calls);
  return pools.map((_, i) => {
    const bids = res[2 * i];
    const asks = res[2 * i + 1];
    if (!bids?.ok) return { error: bids?.ok === false ? bids.error : "no result" };
    if (!asks?.ok) return { error: asks?.ok === false ? asks.error : "no result" };
    const toLevels = (v: unknown): BookLevel[] =>
      (v as readonly { price: bigint; quantity: bigint }[]).map((l) => ({ price: l.price, quantity: l.quantity }));
    return { yesBids: toLevels(bids.value), yesAsks: toLevels(asks.value) };
  });
}

export function toFourSided(book: YesBook, one: bigint): FourSidedBook {
  const noBids = book.yesAsks.map((l) => ({ price: one - l.price, quantity: l.quantity })).sort((a, b) => (a.price > b.price ? -1 : 1));
  const noAsks = book.yesBids.map((l) => ({ price: one - l.price, quantity: l.quantity })).sort((a, b) => (a.price > b.price ? 1 : -1));
  return { ...book, noBids, noAsks };
}

export interface BookSummary {
  /** Probabilities in [0,1]; null when that side is empty. */
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  /** ask − bid in probability points (0.02 = 2 points); null unless two-sided. */
  spread: number | null;
  bidEmpty: boolean;
  askEmpty: boolean;
  /** Both sides empty. */
  empty: boolean;
  /** Sum of resting quantity per side (raw). */
  bidDepth: bigint;
  askDepth: bigint;
}

export function summarizeYes(book: YesBook, decimals: number): BookSummary {
  const bb = book.yesBids[0];
  const ba = book.yesAsks[0];
  const bestBid = bb ? priceToProbability(bb.price, decimals) : null;
  const bestAsk = ba ? priceToProbability(ba.price, decimals) : null;
  const mid = bestBid !== null && bestAsk !== null ? (bestBid + bestAsk) / 2 : (bestBid ?? bestAsk);
  const spread = bestBid !== null && bestAsk !== null ? bestAsk - bestBid : null;
  const sum = (ls: BookLevel[]) => ls.reduce((a, l) => a + l.quantity, 0n);
  return {
    bestBid,
    bestAsk,
    mid,
    spread,
    bidEmpty: !bb,
    askEmpty: !ba,
    empty: !bb && !ba,
    bidDepth: sum(book.yesBids),
    askDepth: sum(book.yesAsks),
  };
}
