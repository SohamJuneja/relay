// Refresh the dated figures in README.md from the live venue.
//
//   node scripts/readme-numbers.mjs [apiBase]
//
// The numbers in the README are a claim about a real venue on a real date, so they
// are rewritten from `GET /v1/stats/overview` together with the timestamp that
// produced them — never edited by hand, and never carried over from an older run.
//
// It refuses to write while the indexer is behind: a 24-hour window computed from a
// cursor that has not reached the last 24 hours is not a small error, it is a
// different question being answered.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const API = (process.argv[2] ?? process.env.API_URL ?? "https://relay-server-htey.onrender.com").replace(/\/$/, "");
const README = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "README.md");
const MAX_LAG = Number(process.env.MAX_LAG_BLOCKS ?? 2000);

// Formatted en-US on purpose: the README is one document, and its digits must not be
// grouped by the locale of whoever happened to run the script.
const pct = (n) => `${Number(n).toFixed(1)}%`;
const usd = (n) => `$${Math.round(Number(n)).toLocaleString("en-US")}`;
const int = (n) => Number(n).toLocaleString("en-US");

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const stampOf = (iso) => {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
};

const FIGURES = /From `GET \/v1\/stats\/overview` on the DreamDEX venue, \*\*[^*]+\*\*:\n\n\| \| \|\n\| --- \| --- \|\n(?:\|[^\n]*\n){3}/;

async function main() {
  const res = await fetch(`${API}/v1/stats/overview`, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`${API}/v1/stats/overview returned ${res.status}`);
  const s = await res.json();

  if (typeof s.lagBlocks === "number" && s.lagBlocks > MAX_LAG) {
    console.error(`refusing to write: the indexer is ${int(s.lagBlocks)} blocks behind.`);
    console.error("A 24-hour figure needs a cursor that has actually reached the last 24 hours.");
    return 1;
  }

  const stamp = stampOf(s.computedAt);
  const block = `From \`GET /v1/stats/overview\` on the DreamDEX venue, **${stamp}**:

| | |
| --- | --- |
| Windows that expired with **no trade at all** | **${pct(s.zeroFillPct24h)}** |
| …of which liquidity was **quoted on both sides and refused** | **${pct(s.quotedButUntakenPct24h)}** |
| 24-hour notional on the venue | **${usd(s.notional24h)}** tUSDC across ${int(s.fills24h)} fills |`;

  const md = readFileSync(README, "utf8");
  if (!FIGURES.test(md)) throw new Error("could not find the figures block in README.md");
  writeFileSync(README, md.replace(FIGURES, `${block}\n`), "utf8");

  console.log(`README figures rewritten from ${API}`);
  console.log(`  as of              ${stamp}`);
  console.log(`  zero-fill          ${pct(s.zeroFillPct24h)}`);
  console.log(`  quoted but untaken ${pct(s.quotedButUntakenPct24h)}`);
  console.log(`  24h notional       ${usd(s.notional24h)} across ${int(s.fills24h)} fills`);
  console.log(`  markets / takers   ${int(s.markets24h)} markets, ${int(s.uniqueTakers24h)} unique takers`);
  console.log(`  indexer lag        ${int(s.lagBlocks)} blocks`);
  return 0;
}

// The exit code is set, never forced: process.exit() tears down handles that are
// still closing, and Node on Windows aborts with a libuv assertion on the way out.
process.exitCode = await main();
