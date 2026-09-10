// Backfill + tail. Both share `processRange`, which runs the two passes over a
// block range: (1) module + settlement (discovers pools / epochs), (2) every
// known pool. The cursor only advances after pass 2.

import type { Address, Hex, PublicClient } from "viem";
import type { Db } from "../db/client.js";
import type { IndexerConfig } from "../config.js";
import { applyPlan, knownPools, loadCursor, loadEpochs, rollbackTo, type ApplyCounts } from "./apply.js";
import { decodeLog, POOL_TOPICS } from "./decode.js";
import { EpochIndex } from "./epochs.js";
import { streamChunks, type Chunk } from "./fetch.js";
import { planChunk } from "./plan.js";
import { DEFAULT_RETENTION, pruneOldRows } from "../db/retention.js";

export interface RunnerDeps {
  cfg: IndexerConfig;
  client: PublicClient;
  db: Db;
  log: (s: string) => void;
}

export interface RunnerState {
  epochs: EpochIndex;
  pools: Set<string>;
}

const sumCounts = (a: ApplyCounts, b: ApplyCounts): ApplyCounts => ({
  markets: a.markets + b.markets,
  orders: a.orders + b.orders,
  fills: a.fills + b.fills,
  builderFees: a.builderFees + b.builderFees,
  protocolFees: a.protocolFees + b.protocolFees,
  redemptions: a.redemptions + b.redemptions,
  raw: a.raw + b.raw,
  orderUpdates: a.orderUpdates + b.orderUpdates,
});
export const zeroCounts = (): ApplyCounts => ({ markets: 0, orders: 0, fills: 0, builderFees: 0, protocolFees: 0, redemptions: 0, raw: 0, orderUpdates: 0 });

export async function loadState(db: Db): Promise<RunnerState> {
  const epochs = new EpochIndex(await loadEpochs(db));
  const pools = new Set<string>([...epochs.pools(), ...(await knownPools(db))].map((p) => p.toLowerCase()));
  return { epochs, pools };
}

async function header(client: PublicClient, n: bigint): Promise<{ hash: Hex; parentHash: Hex; timestamp: bigint }> {
  const b = await client.getBlock({ blockNumber: n });
  return { hash: b.hash, parentHash: b.parentHash, timestamp: b.timestamp };
}

/**
 * The oldest order worth writing: retention's cutoff, minus an hour of slack so an
 * order placed just inside the window is never dropped by rounding.
 */
function orderMinTs(): bigint {
  const days = DEFAULT_RETENTION.orderDays;
  if (!Number.isFinite(days) || days <= 0) return 0n;
  return BigInt(Math.floor(Date.now() / 1000 - days * 86_400) - 3_600);
}

/**
 * Two-pass ingest of [from, to]. Returns row counts. Headers for the two
 * boundary blocks give block-time interpolation and the reorg anchor.
 */
export async function processRange(d: RunnerDeps, st: RunnerState, from: bigint, to: bigint, startBlock: bigint): Promise<ApplyCounts> {
  const { cfg, client, db } = d;
  let counts = zeroCounts();
  const headerCache = new Map<bigint, { hash: Hex; parentHash: Hex; timestamp: bigint }>();
  const hdr = async (n: bigint) => {
    let h = headerCache.get(n);
    if (!h) {
      h = await header(client, n);
      headerCache.set(n, h);
    }
    return h;
  };
  const applyChunk = async (c: Chunk, advanceCursor: boolean) => {
    const [hf, ht] = await Promise.all([hdr(c.from), hdr(c.to)]);
    const plan = planChunk(c.logs.map(decodeLog), { binaryModule: cfg.addresses.binaryModule, binarySettlement: cfg.addresses.binarySettlement, one: cfg.one, epochs: st.epochs });
    for (const m of plan.markets) st.pools.add(m.pool.toLowerCase());
    const res = await applyPlan(db, plan, {
      network: cfg.network,
      from: c.from,
      to: c.to,
      toHash: ht.hash,
      toParentHash: ht.parentHash,
      toTs: ht.timestamp,
      fromTs: hf.timestamp,
      advanceCursor,
      startBlock,
      // Orders are stored only for the venue Relay reports on; fills, markets and
      // stats stay chain-wide. See db/retention.ts for why.
      ordersVenueId: cfg.defaultVenueId,
      // …and only as far back as retention keeps them. Writing an order the next
      // prune deletes costs storage and buys nothing.
      orderMinTs: orderMinTs(),
    });
    counts = sumCounts(counts, res);
  };
  // pass 1: module + settlement (all their events)
  await streamChunks(client, from, to, cfg.chunkSize, cfg.concurrency, () => ({ addresses: [cfg.addresses.binaryModule, cfg.addresses.binarySettlement] }), (c) => applyChunk(c, false));
  // pass 2: pools (address list = everything known after pass 1)
  const pools = [...st.pools] as Address[];
  if (pools.length > 0) {
    await streamChunks(client, from, to, cfg.chunkSize, cfg.concurrency, () => ({ addresses: pools, topics: POOL_TOPICS }), (c) => applyChunk(c, true));
  } else {
    // nothing to scan for pools yet, still advance the cursor
    const ht = await hdr(to);
    const hf = await hdr(from);
    await applyPlan(db, { markets: [], references: [], resolved: [], finalized: [], epochsOpened: [], epochsClosed: [], orders: [], orderUpdates: [], fills: [], builderFees: [], protocolFees: [], redemptions: [], raw: [], blockHashes: new Map(), unknownPoolLogs: 0 }, { network: cfg.network, from, to, toHash: ht.hash, toParentHash: ht.parentHash, toTs: ht.timestamp, fromTs: hf.timestamp, advanceCursor: true, startBlock });
  }
  return counts;
}

export interface BackfillResult {
  from: bigint;
  to: bigint;
  blocks: bigint;
  durationMs: number;
  counts: ApplyCounts;
}

/** Catch up from the cursor (or START_BLOCK / now − BACKFILL_HOURS) to head − confirmations. */
export async function backfill(d: RunnerDeps, st: RunnerState, opts: { segmentChunks?: number; pruneEverySegments?: number } = {}): Promise<BackfillResult> {
  const { cfg, client, db, log } = d;
  const t0 = Date.now();
  const head = (await client.getBlockNumber()) - cfg.confirmations;
  const cur = await loadCursor(db, cfg.network);
  let from: bigint;
  let startBlock: bigint;
  if (cur) {
    from = cur.lastBlock + 1n;
    startBlock = cur.startBlock;
  } else {
    from = cfg.startBlock ?? head - BigInt(Math.round(cfg.backfillHours * 3600 * 10));
    if (from < 1n) from = 1n;
    startBlock = from;
  }
  if (head < from) return { from, to: head, blocks: 0n, durationMs: Date.now() - t0, counts: zeroCounts() };
  const segment = cfg.chunkSize * BigInt(opts.segmentChunks ?? 20);
  let counts = zeroCounts();
  log(`backfill ${from} → ${head} (${head - from + 1n} blocks, segments of ${segment})`);
  // Retention has to be enforced DURING the backfill, not after it. Pruning used to
  // live only in the tail loop, which runs once the backfill finishes — so a long
  // catch-up accumulated every row it touched and pruned none of them. On a 0.5 GB
  // database that ran out of storage before the backfill ever reached the tail.
  let sincePrune = 0;
  for (let s = from; s <= head; s += segment) {
    const e = s + segment - 1n < head ? s + segment - 1n : head;
    const t1 = Date.now();
    const c = await processRange(d, st, s, e, startBlock);
    counts = sumCounts(counts, c);
    log(`  [${s}..${e}] +${c.markets} markets +${c.orders} orders +${c.fills} fills +${c.orderUpdates} updates (${Date.now() - t1} ms) · pools ${st.pools.size}`);

    if (++sincePrune >= (opts.pruneEverySegments ?? 5) && e < head) {
      sincePrune = 0;
      try {
        const pr = await pruneOldRows(db);
        const n = pr.orders + pr.rawEvents + pr.redemptions + pr.protocolFees + pr.blocks;
        if (n) log(`  prune: -${pr.orders} orders -${pr.rawEvents} raw -${pr.redemptions} redemptions -${pr.protocolFees} fees -${pr.blocks} blocks (${pr.ms} ms)`);
      } catch (err) {
        // Housekeeping must not abort a catch-up that is otherwise working.
        log(`  prune failed: ${(err as Error).message.split("\n")[0]}`);
      }
    }
  }
  return { from, to: head, blocks: head - from + 1n, durationMs: Date.now() - t0, counts };
}

/**
 * One tail iteration: reorg check on the cursor block, then ingest new confirmed
 * blocks. Returns the number of blocks applied.
 */
export async function tailOnce(d: RunnerDeps, st: RunnerState): Promise<{ applied: bigint; reorg: boolean; head: bigint; cursor: bigint }> {
  const { cfg, client, db, log } = d;
  const head = (await client.getBlockNumber()) - cfg.confirmations;
  const cur = await loadCursor(db, cfg.network);
  if (!cur) throw new Error("tail needs a cursor — run backfill first");
  let reorg = false;
  if (cur.lastBlockHash) {
    const h = await header(client, cur.lastBlock);
    if (h.hash.toLowerCase() !== cur.lastBlockHash.toLowerCase()) {
      const back = cur.lastBlock - cfg.reorgDepth;
      const anchor = await header(client, back);
      log(`REORG at block ${cur.lastBlock}: stored ${cur.lastBlockHash} chain ${h.hash} — rolling back to ${back}`);
      await rollbackTo(db, cfg.network, back, anchor.hash);
      st.epochs.rollback(back);
      reorg = true;
    }
  }
  const cur2 = reorg ? await loadCursor(db, cfg.network) : cur;
  const from = cur2!.lastBlock + 1n;
  if (head < from) return { applied: 0n, reorg, head, cursor: cur2!.lastBlock };
  const to = head - from + 1n > cfg.chunkSize * 5n ? from + cfg.chunkSize * 5n - 1n : head;
  await processRange(d, st, from, to, cur2!.startBlock);
  return { applied: to - from + 1n, reorg, head, cursor: to };
}
