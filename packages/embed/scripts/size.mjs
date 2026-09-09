// Prints raw + gzip + brotli size of every build artifact and enforces the budget.
import { gzipSync, brotliCompressSync } from "node:zlib";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const DIST = path.resolve(process.cwd(), "dist");
const BUDGET_GZ = Number(process.env.RELAY_SIZE_BUDGET_KB ?? 70) * 1024;

const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
let iifeGz = 0;
const rows = [];
for (const f of readdirSync(DIST).sort()) {
  if (!f.endsWith(".js") && !f.endsWith(".css")) continue;
  const buf = readFileSync(path.join(DIST, f));
  const gz = gzipSync(buf, { level: 9 }).length;
  const br = brotliCompressSync(buf).length;
  rows.push({ file: f, raw: statSync(path.join(DIST, f)).size, gz, br });
  if (f === "relay.iife.js") iifeGz = gz;
}
const w = Math.max(...rows.map((r) => r.file.length), 12);
console.log(`\n${"artifact".padEnd(w)}  ${"raw".padStart(10)}  ${"gzip".padStart(10)}  ${"brotli".padStart(10)}`);
for (const r of rows) console.log(`${r.file.padEnd(w)}  ${kb(r.raw).padStart(10)}  ${kb(r.gz).padStart(10)}  ${kb(r.br).padStart(10)}`);
const ok = iifeGz > 0 && iifeGz <= BUDGET_GZ;
console.log(`\nIIFE budget: ${kb(iifeGz)} gzip vs ${kb(BUDGET_GZ)} → ${ok ? "OK" : "OVER"}\n`);
if (!ok && process.env.RELAY_SIZE_ENFORCE !== "false") process.exit(1);
