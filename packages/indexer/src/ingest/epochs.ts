// pool_epochs in memory: (pool, block) → the market bound to that pool at that block.
// Pools are recycled (nonce++), so this is the ONLY correct way to attribute a
// pool event to a market.

import type { Address, Hex } from "viem";

export interface Epoch {
  pool: Address;
  marketId: Hex;
  nonce: bigint;
  fromBlock: bigint;
  toBlock: bigint | null;
}

export class EpochIndex {
  private byPool = new Map<string, Epoch[]>();
  private byMarket = new Map<string, Epoch>();

  constructor(initial: Epoch[] = []) {
    for (const e of [...initial].sort((a, b) => (a.fromBlock < b.fromBlock ? -1 : a.fromBlock > b.fromBlock ? 1 : 0))) this.push(e);
  }

  private push(e: Epoch): void {
    const k = e.pool.toLowerCase();
    const arr = this.byPool.get(k) ?? [];
    arr.push(e);
    this.byPool.set(k, arr);
    this.byMarket.set(e.marketId.toLowerCase(), e);
  }

  pools(): Address[] {
    return [...this.byPool.keys()] as Address[];
  }

  /** The market active on `pool` at `block`: the latest epoch with fromBlock ≤ block. */
  resolve(pool: string, block: bigint): Epoch | null {
    const arr = this.byPool.get(pool.toLowerCase());
    if (!arr) return null;
    for (let i = arr.length - 1; i >= 0; i--) {
      const e = arr[i]!;
      if (e.fromBlock <= block) return e.toBlock !== null && block > e.toBlock ? null : e;
    }
    return null;
  }

  byMarketId(marketId: string): Epoch | null {
    return this.byMarket.get(marketId.toLowerCase()) ?? null;
  }

  /** (pool, nonce) → epoch; settlement events key markets by marketKey = pool<<64 | nonce. */
  byPoolNonce(pool: string, nonce: bigint): Epoch | null {
    return (this.byPool.get(pool.toLowerCase()) ?? []).find((e) => e.nonce === nonce) ?? null;
  }

  /**
   * Open a new epoch (MarketCreated on `pool` at `fromBlock`). Closes the previous
   * open epoch on that pool at fromBlock − 1. Returns what changed so the DB can
   * mirror it. Idempotent for an already-known market.
   */
  open(e: Omit<Epoch, "toBlock">): { opened: Epoch | null; closed: Epoch | null } {
    if (this.byMarket.has(e.marketId.toLowerCase())) return { opened: null, closed: null };
    const arr = this.byPool.get(e.pool.toLowerCase()) ?? [];
    const prev = arr[arr.length - 1] ?? null;
    let closed: Epoch | null = null;
    if (prev && prev.toBlock === null) {
      prev.toBlock = e.fromBlock - 1n >= prev.fromBlock ? e.fromBlock - 1n : prev.fromBlock;
      closed = prev;
    }
    const opened: Epoch = { ...e, toBlock: null };
    this.push(opened);
    return { opened, closed };
  }

  /** Drop epochs opened after `block` and reopen ones closed after it (reorg rollback). */
  rollback(block: bigint): void {
    for (const [k, arr] of this.byPool) {
      const kept = arr.filter((e) => e.fromBlock <= block);
      for (const e of arr) if (e.fromBlock > block) this.byMarket.delete(e.marketId.toLowerCase());
      for (const e of kept) if (e.toBlock !== null && e.toBlock > block) e.toBlock = null;
      if (kept.length === 0) this.byPool.delete(k);
      else this.byPool.set(k, kept);
    }
  }
}
