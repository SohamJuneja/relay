// pnpm indexer:backfill — catch up from the cursor (or START_BLOCK / now − BACKFILL_HOURS)
// to head − confirmations, then enrich prices and compute stats once.

import { sql } from "drizzle-orm";
import { loadConfig, makePublicClient } from "../config.js";
import { openDb } from "../db/client.js";
import { enrichMarkets } from "../enrich/oracle.js";
import { backfill, loadState } from "../ingest/runner.js";
import { computePartnerStats, computeVenueStats } from "../stats/compute.js";

const log = (s: string) => console.log(`${new Date().toISOString()} ${s}`);
const cfg = loadConfig();
const client = makePublicClient(cfg);
const h = await openDb(cfg.databaseUrl);
await h.migrate();
const st = await loadState(h.db);
const res = await backfill({ cfg, client, db: h.db, log }, st);
log(`backfill done: ${res.blocks} blocks [${res.from}..${res.to}] in ${(res.durationMs / 1000).toFixed(1)}s · ${JSON.stringify(res.counts)}`);
const en = await enrichMarkets(h.db, client, cfg.addresses.oracleHub, { limit: 2000 });
log(`enrich: ${JSON.stringify(en)}`);
const v = await computeVenueStats(h.db, 3);
const p = await computePartnerStats(h.db, cfg.builderFeeBps);
log(`stats: ${v} venue rows, ${p} partner rows`);
for (const t of ["markets", "pool_epochs", "orders", "fills", "builder_fee_events", "protocol_fee_events", "redemptions", "raw_events", "partners", "price_candles", "stats_venue_daily", "stats_partner"]) {
  const r = (await h.db.execute(sql.raw(`select count(*)::int as n from ${t}`))) as unknown as { rows?: { n: number }[] } | { n: number }[];
  const n = Array.isArray(r) ? r[0]?.n : r.rows?.[0]?.n;
  log(`  rows ${t.padEnd(22)} ${n}`);
}
await h.close();
process.exit(0);
