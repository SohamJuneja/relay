// Relay, as one process.
//
//   node packages/server/dist/index.js
//
// A free Render web service is one container with 512 MB and one port. Relay needs
// three things running — the HTTP API, the chain indexer, and the Telegram bot — and
// splitting them across services would need three containers and three database
// connections we do not have. So they share a process:
//
//   · the API owns the port and answers /health, which is what Render polls;
//   · the indexer runs its migrate → backfill → tail loop on the same pg pool;
//   · the bot long-polls, and is skipped entirely without a token.
//
// The parts are independent: the indexer falling over does not stop the API serving
// what is already in the database, and /health reports the lag so the failure is
// visible rather than silent.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildApp } from "@relay/api/app";
import { createDeps } from "@relay/api/deps";
import { startIndexer } from "./indexer.js";
import { startBot } from "./bot.js";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[server]", ...a);

const PORT = Number(process.env.PORT || process.env.API_PORT || 8787);
const HOST = process.env.API_HOST || "0.0.0.0";

async function main(): Promise<void> {
  log(`starting · node ${process.version} · ${process.env.NETWORK ?? "testnet"}`);

  // The migrator reads SQL files by path. Bundling moved the module that used to
  // resolve them, so the build copies `drizzle/` next to the bundle and this points
  // the migrator at it — before anything opens a database.
  if (!process.env.MIGRATIONS_DIR) {
    process.env.MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "drizzle");
  }

  // The API's deps own the pg pool and the RPC client; the indexer borrows both.
  // One pool, sized for a 512 MB box — see PG_POOL_MAX in render.yaml.
  const deps = await createDeps();

  // Migrate before anything reads or writes. Render runs the same image on every
  // deploy, so this is the only place a schema change gets applied.
  const t0 = Date.now();
  await deps.migrate();
  log(`migrations applied in ${Date.now() - t0} ms`);

  const app = await buildApp(deps, { logger: process.env.LOG_REQUESTS === "true" });

  // The port comes up first. Render's health check has a deadline, and an instance
  // that is still backfilling is healthy — it says so in the lag field — whereas one
  // that has not bound a port yet gets killed and restarted forever.
  await app.listen({ port: PORT, host: HOST });
  log(`API listening on ${HOST}:${PORT} · docs /docs · ws /v1/stream`);

  const indexer = startIndexer({ db: deps.db, client: deps.client, log });
  const bot = startBot({ log });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} — shutting down`);
    // Stop accepting first, then let the loops finish their current chunk. The
    // indexer's cursor only advances with the rows it wrote, so a mid-chunk exit
    // costs a re-scan, never a gap.
    const done = await Promise.allSettled([app.close(), indexer.stop(), bot.stop()]);
    for (const [i, r] of done.entries()) if (r.status === "rejected") log(`shutdown step ${i} failed:`, r.reason);
    await deps.close().catch((e) => log("pool close failed:", e));
    log("stopped");
    process.exit(0);
  };

  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
  // A rejection nobody handled has already broken an invariant somewhere. Log it
  // loudly and keep serving: on a free tier, a restart loop is worse than a bug.
  process.on("unhandledRejection", (e) => log("unhandled rejection:", e));
  process.on("uncaughtException", (e) => log("uncaught exception:", e));
}

await main();
