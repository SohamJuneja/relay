// The history walk: everything BEHIND the live cursor, filled in backwards.
//
// The old shape was backfill-then-tail, and it had a bad property on a cold start:
// nothing worked until the whole 24-hour window was ingested. A deploy meant an hour
// or more with no live markets, no books, and a widget that could not paint — the
// sites were down while the indexer read ancient history it did not need first.
//
// So the live cursor is seeded near the head and the tail starts immediately, and
// this walks the other way: from where the live cursor began, downwards, toward
// head − BACKFILL_HOURS. It has its own cursor row so the two never fight, and it
// writes the same tables through the same idempotent path.
//
// Walking BACKWARDS rather than forwards from the floor is what makes the sites
// usable early: the most recent history — the hour behind the cursor, which is what
// a chart or a 1-hour statistic reads — lands first, and the oldest, least useful
// blocks land last.

import type { Hex } from "viem";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { cursor } from "../db/schema.js";
import { pruneOldRows } from "../db/retention.js";
import { processRange, sumCounts, zeroCounts, type RunnerDeps, type RunnerState } from "./runner.js";
import type { ApplyCounts } from "./apply.js";

/** The history cursor lives in the same table, under its own key. No migration. */
export const historyKey = (network: string): string => `${network}:history`;

export interface HistoryProgress {
  /** Lowest block ingested so far. The walk moves this down. */
  lowest: bigint;
  /** The block it is walking down toward — head − BACKFILL_HOURS at the time it started. */
  target: bigint;
}

export async function loadHistory(db: Db, network: string): Promise<HistoryProgress | null> {
  const r = await db.select().from(cursor).where(eq(cursor.network, historyKey(network))).limit(1);
  const c = r[0];
  return c ? { lowest: c.lastBlock, target: c.startBlock } : null;
}

export async function saveHistory(db: Db, network: string, lowest: bigint, target: bigint): Promise<void> {
  await db
    .insert(cursor)
    .values({ network: historyKey(network), lastBlock: lowest, lastBlockHash: null, startBlock: target, updatedAt: new Date() })
    .onConflictDoUpdate({ target: cursor.network, set: { lastBlock: lowest, startBlock: target, updatedAt: new Date() } });
}

/** Seed the live cursor near the head so the tail can start without ingesting anything. */
export async function seedLiveCursor(db: Db, network: string, block: bigint, hash: Hex): Promise<void> {
  await db
    .insert(cursor)
    .values({ network, lastBlock: block, lastBlockHash: hash, startBlock: block, updatedAt: new Date() })
    .onConflictDoNothing();
}

/**
 * Move the live cursor forward to `block`, abandoning the gap below it.
 *
 * Used when a restart finds a cursor hours behind — a free instance that slept, or a
 * deploy after an outage. Tailing forward through that gap would keep every surface
 * dark for as long as it took, which is the whole thing tail-first exists to avoid.
 * The gap is not lost: it becomes the history walk's job.
 */
export async function jumpLiveCursor(db: Db, network: string, block: bigint, hash: Hex): Promise<void> {
  await db
    .insert(cursor)
    .values({ network, lastBlock: block, lastBlockHash: hash, startBlock: block, updatedAt: new Date() })
    .onConflictDoUpdate({ target: cursor.network, set: { lastBlock: block, lastBlockHash: hash, startBlock: block, updatedAt: new Date() } });
}

export interface HistoryResult {
  covered: { from: bigint; to: bigint };
  done: boolean;
  counts: ApplyCounts;
}

export interface HistoryOptions {
  /** Where the live cursor began; the walk fills downward from here. */
  liveStart: bigint;
  /** Stop when the walk reaches this block. */
  target: bigint;
  segment: bigint;
  /** Checked between segments so a shutdown does not wait for the whole walk. */
  stopping: () => boolean;
  pruneEverySegments?: number;
  /** Breather between segments, so the walk never starves the tail loop. */
  pauseMs?: number;
}

/**
 * Walk backwards from the live cursor's start toward `target`, one segment at a time,
 * recording progress after each. Returns when it reaches the target or is asked to
 * stop; a caller that wants it restarted on failure should supervise it.
 */
export async function walkHistoryBackwards(d: RunnerDeps, st: RunnerState, opts: HistoryOptions): Promise<HistoryResult> {
  const { db, log } = d;
  const { liveStart, target, segment, stopping } = opts;
  const pauseMs = opts.pauseMs ?? 250;

  let progress = await loadHistory(db, d.cfg.network);
  // A restart with a different window (BACKFILL_HOURS changed, or a fresh live cursor
  // after a database swap) invalidates the stored walk — start it again from the top.
  if (!progress || progress.lowest > liveStart) {
    progress = { lowest: liveStart, target };
    await saveHistory(db, d.cfg.network, progress.lowest, target);
  }

  let counts = zeroCounts();
  if (progress.lowest <= target) {
    return { covered: { from: progress.lowest, to: liveStart }, done: true, counts };
  }

  log(`history: ${progress.lowest} → ${target} (${progress.lowest - target} blocks to fill, backwards, segments of ${segment})`);
  let sincePrune = 0;

  while (progress.lowest > target && !stopping()) {
    const to: bigint = progress.lowest - 1n;
    const floor: bigint = to - segment + 1n;
    const from: bigint = floor < target ? target : floor;
    const t0 = Date.now();

    // advanceCursor: false — this range is behind the live cursor and must never
    // move it backwards.
    const c = await processRange(d, st, from, to, target, { advanceCursor: false });
    counts = sumCounts(counts, c);

    progress = { lowest: from, target };
    await saveHistory(db, d.cfg.network, from, target);
    log(`  history [${from}..${to}] +${c.markets} markets +${c.fills} fills +${c.orders} orders (${Date.now() - t0} ms) · ${from - target} to go`);

    if (++sincePrune >= (opts.pruneEverySegments ?? 5)) {
      sincePrune = 0;
      try {
        const pr = await pruneOldRows(db);
        const n = pr.orders + pr.rawEvents + pr.redemptions + pr.protocolFees + pr.blocks;
        if (n) log(`  history prune: -${pr.orders} orders -${pr.rawEvents} raw -${pr.blocks} blocks (${pr.ms} ms)`);
      } catch (err) {
        log(`  history prune failed: ${(err as Error).message.split("\n")[0]}`);
      }
    }

    if (pauseMs > 0 && !stopping()) await new Promise((r) => setTimeout(r, pauseMs));
  }

  const done = progress.lowest <= target;
  if (done) log(`history: complete — [${progress.lowest}..${liveStart}] covered`);
  return { covered: { from: progress.lowest, to: liveStart }, done, counts };
}

/**
 * How much history is actually available, in hours, given the two cursors.
 *
 * This is what stops the console showing a confident "24-hour" total computed from
 * two hours of data. On a 100 ms chain, blocks are hours × 36 000.
 */
export function coveredHours(historyLowest: bigint | null, liveCursor: bigint | null): number {
  if (historyLowest === null || liveCursor === null) return 0;
  const blocks = liveCursor - historyLowest;
  if (blocks <= 0n) return 0;
  return Number(blocks) / 36_000;
}
