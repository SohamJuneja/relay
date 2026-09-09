// Print what a partner's browser would actually download.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync, brotliCompressSync } from "node:zlib";
import path from "node:path";

const dist = path.resolve(process.cwd(), "dist/assets");
const kb = (n) => `${(n / 1024).toFixed(1)} KB`;
let totalRaw = 0;
let totalGz = 0;
const rows = [];
for (const f of readdirSync(dist)) {
  if (!/\.(js|css)$/.test(f)) continue;
  const buf = readFileSync(path.join(dist, f));
  const gz = gzipSync(buf).length;
  const br = brotliCompressSync(buf).length;
  totalRaw += buf.length;
  totalGz += gz;
  rows.push([f, buf.length, gz, br]);
}
rows.sort((a, b) => b[2] - a[2]);
console.log("\nartifact".padEnd(42) + "raw".padStart(11) + "gzip".padStart(11) + "brotli".padStart(11));
for (const [f, raw, gz, br] of rows) console.log(f.padEnd(42) + kb(raw).padStart(11) + kb(gz).padStart(11) + kb(br).padStart(11));
console.log("-".repeat(75));
console.log("total".padEnd(42) + kb(totalRaw).padStart(11) + kb(totalGz).padStart(11));
const html = statSync(path.resolve(process.cwd(), "dist/index.html")).size;
console.log(`index.html ${kb(html)}\n`);
