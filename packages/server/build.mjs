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
  external: ["pg-native", "@electric-sql/pglite", "cpu-features"],
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
