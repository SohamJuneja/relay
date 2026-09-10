// The indexer, as a loop inside the server process.
//
// Same sequence as `pnpm indexer:tail`, with two differences: it borrows the API's
// database pool and RPC client instead of opening its own, and it is stoppable so the
// process can shut down between chunks rather than mid-write.

import type { PublicClient } from "viem";
import { loadConfig, type Db } from "@relay/indexer";
import { enrichMarkets, fillPendingOpenings } from "@relay/indexer";
import { loadCursor, loadState, tailOnce } from "@relay/indexer";
import { coveredHours, jumpLiveCursor, loadHistory, saveHistory, seedLiveCursor, walkHistoryBackwards } from "@relay/indexer";
import { computePartnerStats, computeVenueStats } from "@relay/indexer";
import { pruneOldRows } from "@relay/indexer";
import { PriceTicker } from "@relay/indexer";

export interface IndexerHandle {
  stop(): Promise<void>;
  /** Both cursors and how much history is actually covered, for /health. */
  progress(): IndexerProgress;
}

export interface IndexerProgress {
  liveCursor: bigint | null;
  historyCursor: bigint | null;
  historyTarget: bigint | null;
  historyCoveredHours: number;
  historyComplete: boolean;
}

/**
 * How far behind the live cursor may be before a restart jumps it to the head instead
 * of tailing forward through the gap. An hour of a 100 ms chain.
 */
const JUMP_IF_BEHIND = 36_000n;

export function startIndexer(opts: { db: Db; client: PublicClient; log: (...a: unknown[]) => void }): IndexerHandle {
  const { db, client } = opts;
  const log = (...a: unknown[]) => opts.log("[indexer]", ...a);
  const cfg = loadConfig();

  let stopping = false;
  let ticker: PriceTicker | null = null;
  let liveCursor: bigint | null = null;
  let historyCursor: bigint | null = null;
  let historyTarget: bigint | null = null;
  let historyComplete = false;
  let liveStart: bigint | null = null;
  let historyLoop: Promise<void> | null = null;

  // The history walk is its own supervised loop. It is slow, it is allowed to fail,
  // and neither of those may affect the tail — which is the thing keeping the sites
  // alive.
  const startHistoryLoop = (deps: Parameters<typeof walkHistoryBackwards>[0], st: Parameters<typeof walkHistoryBackwards>[1]) => {
    if (historyLoop) return;
    historyLoop = (async () => {
      let delay = 5_000;
      while (!stopping && !historyComplete) {
        try {
          const res = await walkHistoryBackwards(deps, st, {
            liveStart: liveStart ?? 0n,
            target: historyTarget ?? 0n,
            segment: cfg.chunkSize * 20n,
            stopping: () => stopping,
          });
          historyCursor = res.covered.from;
          historyComplete = res.done;
          if (res.done) return;
          delay = 5_000;
        } catch (e) {
          if (stopping) return;
          log(`history: ${(e as Error).message.split("\n")[0]} — retrying in ${delay / 1000}s`);
          await sleep(delay, () => stopping);
          delay = Math.min(delay * 2, 120_000);
        }
      }
    })().catch((e) => log(`history supervisor crashed: ${(e as Error).message}`));
  };

  const run = async (): Promise<void> => {
    // A restart makes a fresh ticker, so the previous one must go first or the process
    // ends up with two WebSocket subscriptions writing the same candles.
    await ticker?.stop().catch(() => undefined);
    ticker = null;

    const st = await loadState(db);
    const deps = { cfg, client, db, log };

    // Tail first.
    //
    // This used to backfill 24 hours before serving anything, which meant a deploy
    // took the sites down for as long as the backfill ran: no live markets, no books,
    // a widget that could not paint. The chain's recent blocks are what every surface
    // actually reads, so the cursor is seeded just behind the head and the tail starts
    // at once. History is filled in behind it by a second loop.
    const head = (await client.getBlockNumber()) - cfg.confirmations;
    const seedAt = head - 50n;
    historyTarget = head - BigInt(Math.round(cfg.backfillHours * 3600 * 10));
    if (historyTarget < 1n) historyTarget = 1n;

    const existing = await loadCursor(db, cfg.network);
    let jumped = false;
    if (!existing) {
      const h = await client.getBlock({ blockNumber: seedAt });
      await seedLiveCursor(db, cfg.network, seedAt, h.hash);
      log(`live cursor seeded at ${seedAt} (head ${head}) — tailing now, history fills in behind`);
      jumped = true;
    } else if (head - existing.lastBlock > JUMP_IF_BEHIND) {
      // A cursor this far back means the process was away — a slept free instance, or
      // an outage. Tailing forward through the gap would keep every surface dark for
      // as long as it took; jumping to the head and handing the gap to the history
      // walk keeps the sites alive and loses nothing.
      const h = await client.getBlock({ blockNumber: seedAt });
      await jumpLiveCursor(db, cfg.network, seedAt, h.hash);
      log(`live cursor was ${head - existing.lastBlock} blocks behind — jumped to ${seedAt}; the gap is now the history walk's`);
      jumped = true;
    }
    liveStart = (await loadCursor(db, cfg.network))?.startBlock ?? seedAt;

    const stored = await loadHistory(db, cfg.network);
    if (jumped || !stored) {
      // Start the walk at the new live cursor so the skipped gap is covered. Below the
      // gap it will re-walk ground it already has; every write on that path is
      // idempotent, so this costs time and not correctness.
      await saveHistory(db, cfg.network, liveStart, historyTarget);
      historyCursor = liveStart;
      historyComplete = false;
    } else {
      // Report what the last run reached before this one's first segment lands, so
      // /health is right immediately after a restart rather than a minute later.
      historyCursor = stored.lowest;
      historyComplete = stored.lowest <= historyTarget;
    }

    ticker = new PriceTicker({ network: cfg.network, indexerUrl: cfg.indexerUrl, wsRpcUrl: cfg.wsRpcUrl, assets: cfg.priceAssets, db, log });
    ticker.start();

    startHistoryLoop(deps, st);

    let lastEnrich = 0;
    let lastOpening = 0;
    let lastStats = 0;
    let lastPrune = 0;

    while (!stopping) {
      const t = Date.now();
      try {
        const r = await tailOnce(deps, st);
        liveCursor = r.cursor;
        if (r.applied > 0n || r.reorg) log(`+${r.applied} blocks → ${r.cursor} (lag ${r.head - r.cursor})${r.reorg ? " after REORG" : ""}`);

        if (Date.now() - lastOpening > 2_000) {
          const o = await fillPendingOpenings(db, client, cfg.addresses.oracleHub);
          if (o.pending > 0) log(`opening pending on ${o.pending}, filled ${o.filled}`);
          lastOpening = Date.now();
        }
        if (Date.now() - lastEnrich > 5_000) {
          const e = await enrichMarkets(db, client, cfg.addresses.oracleHub, { limit: 200 });
          if (e.openingFilled || e.closingFilled || e.lockedMarked) log(`enrich: opening +${e.openingFilled} closing +${e.closingFilled} locked +${e.lockedMarked}`);
          lastEnrich = Date.now();
        }
        if (Date.now() - lastPrune > 3_600_000) {
          const pr = await pruneOldRows(db);
          const n = pr.orders + pr.rawEvents + pr.redemptions + pr.protocolFees + pr.otherVenueFills + pr.otherVenueMarkets + pr.blocks;
          if (n) log(`prune: -${pr.orders} orders -${pr.rawEvents} raw -${pr.redemptions} redemptions -${pr.protocolFees} fees -${pr.otherVenueFills}/${pr.otherVenueMarkets} other-venue fills/markets (${pr.ms} ms)`);
          lastPrune = Date.now();
        }
        if (Date.now() - lastStats > 60_000) {
          const v = await computeVenueStats(db, 3);
          const p = await computePartnerStats(db, cfg.builderFeeBps);
          log(`stats: ${v} venue rows, ${p} partner rows`);
          lastStats = Date.now();
        }
      } catch (e) {
        // One bad chunk must not end the loop: the next pass re-reads the same range.
        log(`tail error: ${(e as Error).message.split("\n")[0]}`);
      }
      const wait = cfg.tailPollMs - (Date.now() - t);
      if (wait > 0) await sleep(wait, () => stopping);
    }
  };

  // Supervised, not fire-and-forget. `run()` catches errors inside its tail loop, but
  // everything before that loop — loadState, and the whole backfill — was unguarded,
  // so a single failed chunk rejected run() and the indexer was gone for the life of
  // the process. It logged one `fatal:` line and the cursor never moved again, which
  // from outside is indistinguishable from an indexer that is merely behind.
  //
  // Restarting is cheap and correct: the cursor advances only with the rows a chunk
  // wrote, in the same transaction, so a restart resumes from the last complete chunk
  // and at worst re-reads one.
  const loop = (async () => {
    let delay = 1_000;
    while (!stopping) {
      const startedAt = Date.now();
      try {
        await run();
        if (stopping) return;
        log("loop returned unexpectedly — restarting");
      } catch (e) {
        if (stopping) return;
        log(`failed: ${(e as Error).message.split("\n")[0]} — restarting`);
      }
      // A run that stayed up for a minute was healthy; only repeated fast failures
      // should back off, so that a persistent fault does not spin the CPU.
      if (Date.now() - startedAt >= 60_000) delay = 1_000;
      await sleep(delay, () => stopping);
      delay = Math.min(delay * 2, 60_000);
    }
  })().catch((e) => log(`supervisor crashed: ${(e as Error).message}`));

  return {
    progress: () => ({
      liveCursor,
      historyCursor,
      historyTarget,
      historyCoveredHours: coveredHours(historyCursor, liveCursor),
      historyComplete,
    }),
    async stop() {
      stopping = true;
      await ticker?.stop().catch(() => undefined);
      await Promise.allSettled([loop, historyLoop ?? Promise.resolve()]);
    },
  };
}

/** Sleep that wakes early when the process is shutting down. */
function sleep(ms: number, cancelled: () => boolean): Promise<void> {
  return new Promise((resolve) => {
    const step = Math.min(ms, 200);
    let waited = 0;
    const t = setInterval(() => {
      waited += step;
      if (waited >= ms || cancelled()) {
        clearInterval(t);
        resolve();
      }
    }, step);
  });
}
