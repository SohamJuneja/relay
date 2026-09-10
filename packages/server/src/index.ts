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

// FIRST, before anything can resolve a hostname. See the module for why.
import "@relay/telegram/ipv4-first";
import path from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApp } from "@relay/api/app";
import { createDeps } from "@relay/api/deps";
import { startIndexer } from "./indexer.js";
import { startBot } from "./bot.js";
import { startExampleAgent } from "./example-agent.js";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[server]", ...a);

/**
 * Everything the bundle requires by bare specifier at run time.
 *
 * esbuild inlines what it can see. These it cannot: ajv and fast-json-stringify
 * generate JavaScript that requires their own runtime helpers by name, so those
 * packages must be resolvable on disk from this file — which means declared as
 * dependencies of @relay/server, not merely present somewhere in the workspace.
 * pnpm's non-hoisted layout is unforgiving about the difference, and that is a good
 * thing: it fails here rather than on the first request in production.
 */
const RUNTIME_REQUIRES = [
  "ajv",
  "ajv/dist/runtime/equal",
  "ajv/dist/runtime/uri",
  "ajv-formats",
  "ajv-formats/dist/formats",
  "fast-json-stringify",
  "fast-json-stringify/lib/serializer",
  "fast-json-stringify/lib/validator",
];

/**
 * Where this bundle keeps its migrations: beside itself, always.
 *
 * Set at MODULE scope, not inside main(). The indexer's db client used to read this
 * into a module-level constant, which was evaluated while this file's imports were
 * still being wired up — before main() ever ran — so an assignment inside main() came
 * too late and the migrator looked in a directory that does not exist. The client now
 * reads it lazily too, and both halves of that fix are needed: this one so the value
 * exists early, that one so a late change would still be honoured.
 *
 * Resolved from `import.meta.url`, never from cwd. Render starts the process at the
 * repo root, so anything cwd-relative resolves somewhere else entirely.
 */
export const BUNDLED_MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "drizzle");
if (!process.env.MIGRATIONS_DIR) process.env.MIGRATIONS_DIR = BUNDLED_MIGRATIONS;

const PORT = Number(process.env.PORT || process.env.API_PORT || 8787);
const HOST = process.env.API_HOST || "0.0.0.0";

async function main(): Promise<void> {
  log(`starting · node ${process.version} · ${process.env.NETWORK ?? "testnet"}`);


  // A dry start proves the bundle can actually run, without touching a database or
  // the chain. `pnpm smoke:prod` runs it in a fresh clone on every push.
  //
  // Loading this file is NOT the test. Both production failures we have had were
  // modules resolved later than that: PGlite behind an import inside openDb, and the
  // helpers ajv and fast-json-stringify require from code they generate when Fastify
  // compiles a route's schemas. So the dry start resolves the known runtime
  // specifiers explicitly, and then builds the whole app — which is what forces that
  // code generation to happen.
  if (process.env.RELAY_DRY_START === "1") {
    await dryStart();
    process.exit(0);
  }

  // The API's deps own the pg pool and the RPC client; the indexer borrows both.
  // One pool, sized for a 512 MB box — see PG_POOL_MAX in render.yaml.
  const deps = await createDeps();

  // Migrate before anything reads or writes. Render runs the same image on every
  // deploy, so this is the only place a schema change gets applied.
  const t0 = Date.now();
  await deps.migrate();
  log(`migrations applied in ${Date.now() - t0} ms`);

  // The bot starts after the app is built, so /health reads it through a holder
  // rather than a value captured before it exists.
  let botHandle: ReturnType<typeof startBot> | null = null;
  deps.botStatus = () => botHandle?.status() ?? null;

  const app = await buildApp(deps, { logger: process.env.LOG_REQUESTS === "true" });

  // The port comes up first. Render's health check has a deadline, and an instance
  // that is still backfilling is healthy — it says so in the lag field — whereas one
  // that has not bound a port yet gets killed and restarted forever.
  await app.listen({ port: PORT, host: HOST });
  log(`API listening on ${HOST}:${PORT} · docs /docs · ws /v1/stream`);

  const indexer = startIndexer({ db: deps.db, client: deps.client, log });
  const bot = startBot({ log });
  botHandle = bot;
  // Off unless RELAY_EXAMPLE_AGENT=1. See example-agent.ts: it spends real testnet
  // collateral from the server's wallet on a timer.
  const agent = startExampleAgent({ log });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    log(`${signal} — shutting down`);
    // Stop accepting first, then let the loops finish their current chunk. The
    // indexer's cursor only advances with the rows it wrote, so a mid-chunk exit
    // costs a re-scan, never a gap.
    const done = await Promise.allSettled([app.close(), indexer.stop(), bot.stop(), agent.stop()]);
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


async function dryStart(): Promise<void> {
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);
  const missing: string[] = [];
  for (const m of RUNTIME_REQUIRES) {
    try {
      req.resolve(m);
    } catch {
      missing.push(m);
    }
  }
  if (missing.length) {
    log(`FAIL — these are required at run time but cannot be resolved:\n  ${missing.join("\n  ")}`);
    log("Add them to packages/server's dependencies; a bundle does not make them optional.");
    process.exit(1);
  }
  log(`resolved ${RUNTIME_REQUIRES.length} runtime requires`);

  // The migrations, resolved exactly the way production resolves them — through the
  // indexer's own function, so this cannot pass while the real path is wrong. Reading
  // the journal is the specific check: `drizzle/` can exist with its .sql files and
  // still be useless, because drizzle-kit reads meta/_journal.json to know the order
  // and that is what a copy with the wrong glob silently drops.
  const { migrationsDir } = await import("@relay/indexer");
  const dir = migrationsDir();
  const journalPath = path.join(dir, "meta", "_journal.json");
  log(`migrations folder: ${dir}`);
  if (!existsSync(dir)) {
    log(`FAIL — the migrations folder does not exist. The build must copy drizzle/ next to the bundle.`);
    process.exit(1);
  }
  if (!existsSync(journalPath)) {
    log(`FAIL — ${path.relative(dir, journalPath)} is missing. The .sql files alone are not enough; drizzle reads the journal for their order.`);
    process.exit(1);
  }
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries?: unknown[] };
  const entries = journal.entries?.length ?? 0;
  if (entries === 0) {
    log("FAIL — the journal lists no migrations, so nothing would be applied");
    process.exit(1);
  }
  const sql = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  if (sql.length < entries) {
    log(`FAIL — the journal lists ${entries} migrations but only ${sql.length} .sql files were copied`);
    process.exit(1);
  }
  log(`migrations: ${entries} in the journal, ${sql.length} .sql files present`);

  // Build the real app against stub dependencies. This compiles every route's zod
  // schema through fast-json-stringify and ajv, which is the step that reaches for
  // the modules above. Nothing here opens a socket or a connection.
  const stub = {
    // A real network name: routes resolve chain endpoints from it while they register,
    // so a placeholder makes the app fail to build for a reason that has nothing to do
    // with what this is testing.
    cfg: { network: "testnet", decimals: 6, defaultVenueId: `0x${"0".repeat(64)}`, priceAssets: ["BTC"], builderFeeBps: 100, rpcUrl: process.env.RPC_URL, wsRpcUrl: process.env.WS_RPC_URL },
    db: { execute: async () => [], select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }), limit: async () => [] }) }) },
    client: { getBlockNumber: async () => 0n },
    ticker: { get: () => null, all: () => [] },
    books: { get: async () => null },
    outcomeToken: async () => `0x${"0".repeat(40)}`,
    migrate: async () => undefined,
    close: async () => undefined,
  } as unknown as Parameters<typeof buildApp>[0];

  const app = await buildApp(stub);
  await app.ready();
  const routes = Object.keys((app.swagger() as { paths?: Record<string, unknown> }).paths ?? {}).length;
  await app.close();
  log(`built the app and compiled ${routes} routes' schemas`);
  log("dry start OK — every module the server needs at run time is present");
}
