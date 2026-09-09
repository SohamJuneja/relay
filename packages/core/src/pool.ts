// Pool parameter reads: fee config (incl. the builder-fee cap), tick/lot grid,
// expiry cap. All fee rates are bps × 1000 (100000 = 1 %).

import type { Address, PublicClient } from "viem";
import { binaryMarketReadAbi, binaryPoolReadAbi } from "./abi/index.js";
import { batchRead, unwrap } from "./reads.js";

export interface BinaryPoolParams {
  collateralToken: Address;
  market: Address;
  outcomeToken: Address;
  yesId: bigint;
  noId: bigint;
  oneCollateral: bigint;
  setBacking: bigint;
  feeRecipient: Address;
  makerFeeBpsTimes1k: bigint;
  takerFeeBpsTimes1k: bigint;
  maxBuilderFeeBpsTimes1k: bigint;
  settlementFeeBpsTimes1k: bigint;
  settlement: Address;
  marketNonce: bigint;
  finalized: boolean;
}

export interface OrderBookParams {
  tickSize: bigint;
  minQuantity: bigint;
  lotSize: bigint;
}

export interface PoolSnapshot {
  pool: Address;
  params: BinaryPoolParams;
  bookParams: OrderBookParams | null;
  /** Standalone getter — should equal params.maxBuilderFeeBpsTimes1k. */
  maxBuilderFeeBpsTimes1k: bigint | null;
  marketExpiryNs: bigint | null;
  booksEmpty: boolean | null;
  /** From the market clone: seconds after expiry the oracle may still answer. */
  settlementWindowSec: bigint | null;
  errors: string[];
}

export async function readPoolSnapshot(client: PublicClient, pool: Address): Promise<PoolSnapshot> {
  const res = await batchRead(client, [
    { address: pool, abi: binaryPoolReadAbi, functionName: "getBinaryPoolParams" },
    { address: pool, abi: binaryPoolReadAbi, functionName: "getOrderBookParameters" },
    { address: pool, abi: binaryPoolReadAbi, functionName: "getMaxBuilderFeeBpsTimes1k" },
    { address: pool, abi: binaryPoolReadAbi, functionName: "marketExpiryNs" },
    { address: pool, abi: binaryPoolReadAbi, functionName: "booksEmpty" },
  ]);
  const errors: string[] = [];
  const p = unwrap<BinaryPoolParams>(res[0]);
  if (!p) throw new Error(`getBinaryPoolParams failed on ${pool}: ${res[0]?.ok === false ? res[0].error : "no result"}`);
  for (const [i, name] of ["getBinaryPoolParams", "getOrderBookParameters", "getMaxBuilderFeeBpsTimes1k", "marketExpiryNs", "booksEmpty"].entries()) {
    const r = res[i];
    if (r && !r.ok) errors.push(`${name}: ${r.error}`);
  }
  const sw = await batchRead(client, [{ address: p.market, abi: binaryMarketReadAbi, functionName: "settlementWindow" }]);
  const swv = unwrap<bigint>(sw[0]);
  if (sw[0] && !sw[0].ok) errors.push(`market.settlementWindow: ${sw[0].error}`);
  return {
    pool,
    params: p,
    bookParams: unwrap<OrderBookParams>(res[1]),
    maxBuilderFeeBpsTimes1k: unwrap<bigint>(res[2]),
    marketExpiryNs: unwrap<bigint>(res[3]),
    booksEmpty: unwrap<boolean>(res[4]),
    settlementWindowSec: swv,
    errors,
  };
}
