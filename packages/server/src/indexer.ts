// The indexer, as a loop inside the server process.
//
// Same sequence as `pnpm indexer:tail`, with two differences: it borrows the API's
// database pool and RPC client instead of opening its own, and it is stoppable so the
// process can shut down between chunks rather than mid-write.

import type { PublicClient } from "viem";
import { loadConfig, type Db } from "@relay/indexer";
import { enrichMarkets, fillPendingOpenings } from "@relay/indexer";
import { backfill, loadState, tailOnce } from "@relay/indexer";
import { computePartnerStats, computeVenueStats } from "@relay/indexer";
import { pruneOldRows } from "@relay/indexer";
import { PriceTicker } from "@relay/indexer";

export interface IndexerHandle {
  stop(): Promise<void>;
}

export function startIndexer(opts: { db: Db; client: PublicClient; log: (...a: unknown[]) => void }): IndexerHandle {
  const { db, client } = opts;
  const log = (...a: unknown[]) => opts.log("[indexer]", ...a);
  const cfg = loadConfig();

  let stopping = false;
  let ticker: PriceTicker | null = null;

  const run = async (): Promise<void> => {
    const st = await loadState(db);
    const deps = { cfg, client, db, log };

    // Catch up. On a cold database this is the 24 hours the README promises; on a
    // restart the cursor is already there and this returns in a second.
    const t0 = Date.now();
    const bf = await backfill(deps, st);
    log(`caught up: ${bf.blocks} blocks in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

    ticker = new PriceTicker({ network: cfg.network, indexerUrl: cfg.indexerUrl, wsRpcUrl: cfg.wsRpcUrl, assets: cfg.priceAssets, db, log });
    ticker.start();

    let lastEnrich = 0;
    let lastOpening = 0;
    let lastStats = 0;
    let lastPrune = 0;

    while (!stopping) {
      const t = Date.now();
      try {
        const r = await tailOnce(deps, st);
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

  const loop = run().catch((e) => log(`fatal: ${(e as Error).message}`));

  return {
    async stop() {
      stopping = true;
      await ticker?.stop().catch(() => undefined);
      await loop;
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
