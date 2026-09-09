// Fill scanning + attribution from chain logs.
//
// `OrderFilled(takerOrderId, makerOrderId, quantityFilled, takerRemaining,
// makerRemaining, fillPrice)` fires on the POOL. The kit says: for attribution,
// PnL or volume, read this from chain — the REST/indexer trade feeds can stall
// (kit gotchas #11, docs/24-7-operations.md). `fillPrice` is the execution price
// in YES terms; notional = fillPrice × quantityFilled / one.
//
// Attribution to a MARKET: a pool is recycled across successive markets, so a
// fill at block B on pool P belongs to the latest market created on P at a
// block <= B. Fills on a pool before any creation we saw in the window belong
// to a pre-window market and are reported as unattributed.

import type { Address, Hex, PublicClient } from "viem";
import { orderFilledEvent } from "./abi/index.js";
import type { DiscoveredMarket } from "./discovery.js";
import { scanLogs, type ScanProgress } from "./logs.js";

export interface Fill {
  pool: Address;
  takerOrderId: bigint;
  makerOrderId: bigint;
  quantityFilled: bigint;
  takerRemainingQuantity: bigint;
  makerRemainingQuantity: bigint;
  fillPrice: bigint;
  blockNumber: bigint;
  txHash: Hex;
  logIndex: number;
}

export interface ScanFillsOptions {
  client: PublicClient;
  pools: readonly Address[];
  fromBlock: bigint;
  toBlock: bigint;
  concurrency?: number;
  onProgress?: (p: ScanProgress) => void;
}

export async function scanFills(opts: ScanFillsOptions): Promise<Fill[]> {
  if (opts.pools.length === 0) return [];
  const logs = await scanLogs({
    client: opts.client,
    address: [...opts.pools],
    events: [orderFilledEvent] as const,
    fromBlock: opts.fromBlock,
    toBlock: opts.toBlock,
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });
  const out: Fill[] = [];
  for (const log of logs) {
    const a = log.args as Record<string, bigint | undefined>;
    if (a.quantityFilled === undefined || a.fillPrice === undefined) continue;
    out.push({
      pool: log.address,
      takerOrderId: a.takerOrderId ?? 0n,
      makerOrderId: a.makerOrderId ?? 0n,
      quantityFilled: a.quantityFilled,
      takerRemainingQuantity: a.takerRemainingQuantity ?? 0n,
      makerRemainingQuantity: a.makerRemainingQuantity ?? 0n,
      fillPrice: a.fillPrice,
      blockNumber: log.blockNumber ?? 0n,
      txHash: (log.transactionHash ?? "0x") as Hex,
      logIndex: log.logIndex ?? 0,
    });
  }
  return out;
}

export interface FillAttribution {
  /** marketId → fills. Every discovered market has an entry (possibly empty). */
  byMarket: Map<Hex, Fill[]>;
  /** Fills on a known pool that predate every creation we saw on that pool. */
  unattributed: Fill[];
}

export function attributeFills(fills: readonly Fill[], markets: readonly DiscoveredMarket[]): FillAttribution {
  const byPool = new Map<string, DiscoveredMarket[]>();
  for (const m of markets) {
    const k = m.pool.toLowerCase();
    const arr = byPool.get(k) ?? [];
    arr.push(m);
    byPool.set(k, arr);
  }
  for (const arr of byPool.values()) arr.sort((a, b) => (a.createdAtBlock < b.createdAtBlock ? -1 : a.createdAtBlock > b.createdAtBlock ? 1 : a.logIndex - b.logIndex));

  const byMarket = new Map<Hex, Fill[]>();
  for (const m of markets) byMarket.set(m.marketId, []);
  const unattributed: Fill[] = [];

  for (const f of fills) {
    const candidates = byPool.get(f.pool.toLowerCase()) ?? [];
    let owner: DiscoveredMarket | null = null;
    for (const m of candidates) {
      if (m.createdAtBlock <= f.blockNumber) owner = m;
      else break;
    }
    if (!owner) {
      unattributed.push(f);
      continue;
    }
    byMarket.get(owner.marketId)?.push(f);
  }
  return { byMarket, unattributed };
}

/** Notional in raw collateral units: Σ fillPrice × qty / one. */
export function fillsNotional(fills: readonly Fill[], one: bigint): bigint {
  let n = 0n;
  for (const f of fills) n += (f.fillPrice * f.quantityFilled) / one;
  return n;
}
