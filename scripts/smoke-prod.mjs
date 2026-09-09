// Build and start the server exactly the way the host does, in a clean clone.
//
//   pnpm smoke:prod
//
// This exists because of a real deploy failure. The server bundle is one file, but a
// bundle is not self-contained: fastify's validator and serialiser generate code that
// `require`s ajv and fast-json-stringify by bare specifier at runtime, and the indexer
// used to import PGlite statically. None of that is visible to a typecheck, a unit
// test, or a build — only to a process that actually starts, in a directory laid out
// the way pnpm lays it out, with dependencies it actually declared.
//
// So: clone from git (never the working tree, which has hoisted junk a fresh checkout
// will not), install frozen, build, and start with RELAY_DRY_START=1 — which brings up
// every module and exits 0 without touching a database.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const KEEP = process.env.SMOKE_KEEP === "1";
const log = (...a) => console.log("[smoke]", ...a);

const run = (cmd, args, opts = {}) => {
  log(`$ ${cmd} ${args.join(" ")}`);
  execFileSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32", ...opts });
};

const work = mkdtempSync(path.join(tmpdir(), "relay-smoke-"));
const clone = path.join(work, "relay");
let failed = false;

try {
  // A local clone of HEAD, not a copy of the working tree: this is the whole point.
  // Anything not committed, or accidentally resolvable only because of a stray
  // node_modules, must not be able to make this pass.
  log(`cloning into ${clone}`);
  run("git", ["clone", "--quiet", "--depth", "1", "--no-hardlinks", `file://${repoRoot.replace(/\\/g, "/")}`, clone]);

  // Render runs this to provision pnpm. Locally pnpm is already on PATH and enabling
  // corepack needs administrator rights on Windows, so a failure here is not the
  // thing being tested — as long as pnpm resolves afterwards.
  try {
    run("corepack", ["enable"], { cwd: clone });
  } catch {
    log("corepack enable failed (fine if pnpm is already installed) — continuing");
  }
  // --ignore-scripts, and the deploy uses the same flag. No dependency here needs a
  // postinstall: esbuild resolves its platform binary through optional dependencies,
  // and ws's native accelerators are optional by design. pnpm otherwise FAILS the
  // install over unapproved build scripts, which is a deploy that dies before it
  // starts. Not running them also means a deploy never compiles C++.
  run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"], { cwd: clone });
  run("pnpm", ["-r", "build"], { cwd: clone });

  const entry = path.join(clone, "packages/server/dist/index.js");
  if (!existsSync(entry)) throw new Error(`the build produced no ${path.relative(clone, entry)}`);

  // Syntax first — a cheap check that fails clearly before the slower one.
  run("node", ["--check", entry]);

  // Migrations have to travel with the bundle; the migrator reads them by path.
  const migrations = path.join(clone, "packages/server/dist/drizzle");
  if (!existsSync(migrations)) throw new Error("dist/drizzle is missing — the migrator would find nothing to apply");

  // The real test: start it. Every module loads, every generated require resolves,
  // the migrations are where the migrator will look, and the entry exits 0 on its own.
  //
  // Run from SEVERAL working directories, because that is precisely what the last
  // production failure turned on: a path that resolved correctly when the process
  // happened to start inside the package, and pointed at nothing when Render started
  // it from the repo root. Anything resolved from cwd passes one of these and fails
  // another, which is the only way to catch it without deploying.
  const started = Date.now();
  const cwds = [
    ["repo root", clone],
    ["package dir", path.join(clone, "packages", "server")],
    ["an unrelated dir", tmpdir()],
  ];

  for (const [label, dir] of cwds) {
    log(`dry start from ${label} — ${dir}`);
    const child = spawn(process.execPath, [entry], {
      cwd: dir,
      env: {
        ...process.env,
        RELAY_DRY_START: "1",
        NODE_ENV: "production",
        // Nothing here is contacted in a dry start; they exist so config loading,
        // which validates required variables, gets past its checks.
        DATABASE_URL: "postgres://smoke:smoke@127.0.0.1:5432/smoke",
        RPC_URL: process.env.RPC_URL ?? "https://dream-rpc.somnia.network",
        NETWORK: "testnet",
        TELEGRAM_BOT_TOKEN: "",
        // Deliberately absent: the bundle must locate its own migrations unaided.
        MIGRATIONS_DIR: "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let out = "";
    child.stdout.on("data", (d) => {
      out += d;
      process.stdout.write(d);
    });
    child.stderr.on("data", (d) => {
      out += d;
      process.stderr.write(d);
    });

    const code = await new Promise((resolve) => {
      const kill = setTimeout(() => {
        log("dry start did not exit within 90 s — killing");
        child.kill("SIGKILL");
        resolve(124);
      }, 90_000);
      child.on("exit", (c) => {
        clearTimeout(kill);
        resolve(c ?? 0);
      });
    });

    if (code !== 0) throw new Error(`dry start from ${label} exited ${code}`);
    if (/ERR_MODULE_NOT_FOUND|Cannot find (module|package)/i.test(out)) {
      throw new Error(`a module failed to resolve during the dry start from ${label}`);
    }
    if (!/migrations: \d+ in the journal/.test(out)) {
      throw new Error(`the dry start from ${label} never confirmed the migrations journal`);
    }
  }

  log(`dry start OK in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  log("PASS — a fresh clone builds and the server's every import resolves");
} catch (e) {
  failed = true;
  console.error(`\n[smoke] FAIL: ${e instanceof Error ? e.message : e}`);
} finally {
  if (KEEP) log(`left the clone at ${clone} (SMOKE_KEEP=1)`);
  else rmSync(work, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
