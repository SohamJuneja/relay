// Bundle the server into one file.
//
// The workspace packages export TypeScript source (that is what makes the monorepo
// pleasant to work in), which Node cannot load. Rather than give every package its own
// declaration-and-dist build just to deploy one process, esbuild inlines them here.
//
// Only the things that must stay on disk are external: native modules, and anything
// that reads its own package layout at runtime.
import { build } from "esbuild";
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync } from "node:fs";
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

// Migrations are read at runtime by drizzle's migrator, by path.
const migrations = path.resolve(here, "../indexer/drizzle");
if (existsSync(migrations)) {
  cpSync(migrations, path.resolve(here, "dist/drizzle"), { recursive: true });
  console.log("[server] copied migrations to dist/drizzle");
}

const bytes = readFileSync(out).length;
writeFileSync(path.resolve(here, "dist/meta.json"), JSON.stringify(result.metafile));
console.log(`[server] dist/index.js — ${(bytes / 1024 / 1024).toFixed(2)} MB`);
