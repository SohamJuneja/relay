// pnpm indexer:tail — catch up, then follow the chain: new blocks every 1.5 s,
// enrichment every 5 s, missing opening prices every 2 s, stats every 60 s, price
// candles from the feed.

import { loadConfig, makePublicClient } from "../config.js";
import { openDb } from "../db/client.js";
import { enrichMarkets, fillPendingOpenings } from "../enrich/oracle.js";
import { pruneOldRows } from "../db/retention.js";
import { backfill, loadState, tailOnce } from "../ingest/runner.js";
import { PriceTicker } from "../price/ticker.js";
import { computePartnerStats, computeVenueStats } from "../stats/compute.js";

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
const cfg = loadConfig();
const client = makePublicClient(cfg);
const h = await openDb(cfg.databaseUrl);
await h.migrate();
const st = await loadState(h.db);
const deps = { cfg, client, db: h.db, log };

const bf = await backfill(deps, st);
log(`caught up: ${bf.blocks} blocks in ${(bf.durationMs / 1000).toFixed(1)}s`);

const ticker = new PriceTicker({ network: cfg.network, indexerUrl: cfg.indexerUrl, wsRpcUrl: cfg.wsRpcUrl, assets: cfg.priceAssets, db: h.db, log });
ticker.start();

let lastEnrich = 0;
let lastOpening = 0;
let lastStats = 0;
let lastPrune = 0;
/** How many times a live window was seen trading with no opening price yet. */
let openingGaps = 0;
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});

while (!stopping) {
  const t0 = Date.now();
  try {
    const r = await tailOnce(deps, st);
    if (r.applied > 0n || r.reorg) log(`tail: +${r.applied} blocks → cursor ${r.cursor} (head−${cfg.confirmations} = ${r.head}, lag ${r.head - r.cursor})${r.reorg ? " after REORG" : ""}`);
    // A trading window with no opening price is the one gap a reader can see, so it
    // gets its own faster loop rather than waiting for the 5 s pass.
    if (Date.now() - lastOpening > 2_000) {
      const o = await fillPendingOpenings(h.db, client, cfg.addresses.oracleHub);
      if (o.pending > 0) {
        openingGaps += o.pending;
        log(`opening pending: ${o.pending} trading market(s) without an opening price, filled ${o.filled} (${o.marketIds.map((m) => m.slice(-6)).join(",")}) · gaps seen ${openingGaps}`);
      }
      lastOpening = Date.now();
    }
    if (Date.now() - lastEnrich > 5_000) {
      const e = await enrichMarkets(h.db, client, cfg.addresses.oracleHub, { limit: 200 });
      if (e.openingFilled || e.closingFilled || e.lockedMarked) log(`enrich: opening +${e.openingFilled} closing +${e.closingFilled} locked +${e.lockedMarked}`);
      lastEnrich = Date.now();
    }
    // Retention, hourly. Orders and raw logs are the only tables that grow without
    // bound, and both are only useful while recent.
    if (Date.now() - lastPrune > 3_600_000) {
      const pr = await pruneOldRows(h.db);
      const pruned = pr.orders + pr.rawEvents + pr.blocks + pr.redemptions + pr.protocolFees + pr.otherVenueFills + pr.otherVenueMarkets;
      if (pruned) log(`prune: -${pr.orders} orders -${pr.rawEvents} raw -${pr.redemptions} redemptions -${pr.protocolFees} protocol-fees -${pr.otherVenueFills} other-venue fills -${pr.otherVenueMarkets} other-venue markets -${pr.blocks} block headers (${pr.ms} ms)`);
      lastPrune = Date.now();
    }
    if (Date.now() - lastStats > 60_000) {
      const t = Date.now();
      const v = await computeVenueStats(h.db, 3);
      const p = await computePartnerStats(h.db, cfg.builderFeeBps);
      log(`stats: ${v} venue rows, ${p} partner rows (${Date.now() - t} ms)`);
      lastStats = Date.now();
    }
  } catch (e) {
    log(`tail error: ${(e as Error).message.split("\n")[0]}`);
  }
  const wait = cfg.tailPollMs - (Date.now() - t0);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}
await ticker.stop();
await h.close();
process.exit(0);
