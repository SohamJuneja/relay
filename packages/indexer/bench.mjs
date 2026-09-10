// Round trips per 20 000-block segment, before and after the batching change.
//
//   BENCH_FROM=<block> DATABASE_URL=pglite://<dir> node --import tsx bench.mjs
//
// Wall time is measured too, but the number that matters is the STATEMENT COUNT.
// The change removed per-row UPDATE loops; against a local database that is nearly
// free and the improvement would look like noise, while across a region boundary
// each statement is a ~65 ms round trip. Counting statements measures the thing that
// changed, independently of where the database happens to be.
import { loadConfig, makePublicClient } from "./src/config.js";
import { openDb } from "./src/db/client.js";
import { loadState, processRange } from "./src/ingest/runner.js";

const FROM = BigInt(process.env.BENCH_FROM);
const SIZE = BigInt(process.env.BENCH_SIZE ?? 20000);
const cfg = loadConfig();
const client = makePublicClient(cfg);
const h = await openDb(cfg.databaseUrl);
await h.migrate();

// Count every statement, through drizzle's own logger rather than by patching the
// driver: the driver has several entry points and a transaction does not use the
// same one as a bare query, so patching one of them undercounts badly.
let statements = 0;
const { drizzle } = await import("drizzle-orm/pglite");
const schema = await import("./src/db/schema.js");
const db = drizzle(h.db.$client, { schema, logger: { logQuery: () => { statements += 1; } } });

const st = await loadState(db);
statements = 0; // ignore setup

const to = FROM + SIZE - 1n;
const t0 = Date.now();
const c = await processRange({ cfg, client, db, log: () => {} }, st, FROM, to, FROM, { advanceCursor: false });
const ms = Date.now() - t0;

console.log(`range           [${FROM}..${to}]  (${SIZE} blocks)`);
console.log(`statements      ${statements}`);
console.log(`duration        ${(ms / 1000).toFixed(1)} s (local database)`);
console.log(`rows            ${c.markets} markets · ${c.orders} orders · ${c.fills} fills · ${c.orderUpdates} order updates`);
console.log(`at 65 ms RTT    ${((statements * 65) / 1000).toFixed(0)} s would be spent waiting`);
await h.close();
