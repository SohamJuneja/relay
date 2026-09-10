// Bundle the server into one file.
//
// The workspace packages export TypeScript source (that is what makes the monorepo
// pleasant to work in), which Node cannot load. Rather than give every package its own
// declaration-and-dist build just to deploy one process, esbuild inlines them here.
//
// Only the things that must stay on disk are external: native modules, and anything
// that reads its own package layout at runtime.
import { build } from "esbuild";
import { readFileSync, readdirSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, "dist/index.js");
mkdirSync(path.dirname(out), { recursive: true });

const result = await build({
  entryPoints: [path.resolve(here, "src/index.ts")],
  outfile: out,
  platform: "node",
  target: "node20",
  format: "esm",
  bundle: true,
  sourcemap: true,
  minify: false, // a readable stack trace is worth more than the kilobytes
  logLevel: "info",
  // pg's native bindings and PGlite's wasm cannot be inlined; drizzle's migrator reads
  // migration files from disk, so those are copied below rather than bundled.
  // Never bundled, and never required at runtime either:
  //   pglite      — a ~100 MB WASM Postgres that only tests use. It is behind a lazy
  //                 import in openDb(), so marking it external keeps esbuild from
  //                 pulling it in AND leaves the import unreachable in production.
  //                 A static import here is what crashed the first Render deploy.
  //   pg-native   — optional native bindings postgres.js probes for.
  //   cpu-features— an optional native dep of a transitive package.
  external: [
    // Lazy and unreachable in production: PGlite is a ~100 MB WASM Postgres that only
    // tests use, behind an import inside openDb(). A static import of it is what
    // crashed the first Render deploy.
    "@electric-sql/pglite",
    "drizzle-orm/pglite",
    "drizzle-orm/pglite/migrator",
    // Reads its own static assets (the Swagger UI bundle, logo.svg) from __dirname.
    // Bundling relocates the code away from those files, and the resulting mix of
    // require() and top-level await also makes Node refuse to pick a module format.
    // It has to stay a real package in node_modules.
    "@fastify/swagger-ui",
    // grammY, and the two packages its Node shim pulls in.
    //
    // node-fetch v2 decides whether something is an AbortSignal BY CLASS NAME:
    //
    //     const isAbortSignal = o => Object.getPrototypeOf(o)?.constructor.name === "AbortSignal";
    //
    // A bundler is free to rename identifiers — esbuild renames on collision, and the
    // global AbortSignal guarantees one — so a check like that cannot survive
    // bundling. The symptom was a bot that never started, reporting
    // "Network request for 'getMe' failed! — TypeError: Expected signal to be an
    // instanceof AbortSignal" while a plain fetch of the identical getMe answered 200
    // from the same process.
    //
    // Left as real packages in node_modules, grammY loads the way its authors tested.
    "grammy",
    "node-fetch",
    "abort-controller",
    // Optional native bindings that their callers probe for behind try/catch.
    "pg-native",
    "cpu-features",
  ],
  banner: {
    // ESM has no require(); a few transitive CommonJS deps still reach for it.
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  metafile: true,
});

// Migrations are read at run time by drizzle's migrator, by path, so they have to
// travel with the bundle.
//
// The whole folder, not a glob of *.sql: drizzle reads meta/_journal.json to know
// which migrations exist and in what order, and a copy that takes only the SQL files
// produces a `drizzle/` that looks right and fails with "Can't find meta/_journal.json".
// The assertions below exist because that is a silent build-time mistake with a
// runtime-only symptom.
const migrations = path.resolve(here, "../indexer/drizzle");
const destMigrations = path.resolve(here, "dist/drizzle");
if (!existsSync(migrations)) {
  console.error(`[server] ${migrations} is missing — nothing to migrate with`);
  process.exit(1);
}
cpSync(migrations, destMigrations, { recursive: true });

const journal = path.join(destMigrations, "meta", "_journal.json");
if (!existsSync(journal)) {
  console.error("[server] copied drizzle/ but meta/_journal.json is not in it");
  process.exit(1);
}
const entries = JSON.parse(readFileSync(journal, "utf8")).entries ?? [];
const sqlFiles = readdirSync(destMigrations).filter((f) => f.endsWith(".sql"));
if (entries.length === 0 || sqlFiles.length < entries.length) {
  console.error(`[server] journal lists ${entries.length} migrations, ${sqlFiles.length} .sql files copied`);
  process.exit(1);
}
console.log(`[server] copied ${sqlFiles.length} migrations + journal to dist/drizzle`);

const bytes = readFileSync(out).length;
writeFileSync(path.resolve(here, "dist/meta.json"), JSON.stringify(result.metafile));
console.log(`[server] dist/index.js — ${(bytes / 1024 / 1024).toFixed(2)} MB`);
