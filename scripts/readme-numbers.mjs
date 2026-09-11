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

/**
 * Quoted-but-untaken as a share of the zero-fill windows, not of all windows.
 *
 * Both are reported against all windows, so when every untraded window turns out to
 * have been quoted on both sides the two percentages coincide — and two identical
 * numbers in adjacent rows read as a copy-paste error rather than as the finding.
 * Expressed against zero-fill it says the thing plainly.
 */
const shareOfZeroFill = (s) => {
  const zero = Number(s.zeroFillPct24h);
  const untaken = Number(s.quotedButUntakenPct24h);
  if (!Number.isFinite(zero) || !Number.isFinite(untaken) || zero <= 0) return "—";
  const share = (untaken / zero) * 100;
  return `${share >= 99.5 ? "100" : share.toFixed(0)}% of them (${pct(untaken)} of all windows)`;
};

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const stampOf = (iso) => {
  const d = new Date(iso);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
};

const FIGURES = /From `GET \/v1\/stats\/overview` on the DreamDEX venue, \*\*[^*]+\*\*:\n\n\| \| \|\n\| --- \| --- \|\n(?:\|[^\n]*\n){3}/;

/** The same share, written out in prose, in the two places the README says it. */
// Whitespace-tolerant, because the replacements re-wrap to the README's ~90 columns
// and the next run has to match what the last one wrote.
// Each matches a WHOLE sentence and is replaced with a whole, freshly wrapped one.
// Splicing a few words into the middle of an existing paragraph leaves the untouched
// remainder on its own short line, which looks like a mistake in the diff.
const SHARE_PROSE =
  /A(?:lmost a quarter|\s+(?:third|quarter|sixth|tenth|meaningful share))\s+of this venue's markets are tradeable and go untraded\.\s+Every number\s+above is\s+derived from Somnia logs by Relay's own indexer, which does not depend on DreamDEX's\./;
const INTRO_SHARE =
  /and a(?:lmost a quarter|\s+(?:third|quarter|sixth|tenth|meaningful share))\s+of\s+them expire with liquidity quoted on both sides and nobody taking it\.\s+That is not a\s+liquidity problem; it is a distribution problem\.\s+Relay is two/;

/** Words for a percentage, so the prose cannot disagree with the table beneath it. */
const shareInWords = (pct) => {
  if (pct >= 30) return "A third";
  if (pct >= 21) return "Almost a quarter";
  if (pct >= 15) return "A sixth";
  if (pct >= 8) return "A tenth";
  return "A meaningful share";
};

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
| …of those, the share that had liquidity **quoted on both sides and refused** | **${shareOfZeroFill(s)}** |
| 24-hour notional on the venue | **${usd(s.notional24h)}** tUSDC across ${int(s.fills24h)} fills |`;

  let md = readFileSync(README, "utf8");
  if (!FIGURES.test(md)) throw new Error("could not find the figures block in README.md");
  md = md.replace(FIGURES, `${block}\n`);

  // The prose has to move with the number, or it becomes a claim the table directly
  // beneath it refutes: "A third of this venue's markets…" sat above a table reading
  // 23.3%. A number written out in words next to the same number in a table is not a
  // style choice, it is a second copy, and second copies drift.
  const words = shareInWords(Number(s.zeroFillPct24h));
  if (!SHARE_PROSE.test(md)) throw new Error("could not find the share sentence in README.md");
  md = md.replace(
    SHARE_PROSE,
    `${words} of this venue's markets are tradeable and go untraded. Every number above is\n` +
      `derived from Somnia logs by Relay's own indexer, which does not depend on DreamDEX's.`,
  );
  if (!INTRO_SHARE.test(md)) throw new Error("could not find the intro share phrase in README.md");
  md = md.replace(
    INTRO_SHARE,
    `and ${words.toLowerCase()} of\n` +
      `them expire with liquidity quoted on both sides and nobody taking it. That is not a\n` +
      `liquidity problem; it is a distribution problem. Relay is two`,
  );

  writeFileSync(README, md, "utf8");

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
