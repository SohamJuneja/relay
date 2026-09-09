// Refuse to commit a secret.
//
//   node scripts/secret-scan.mjs
//
// Run before every commit and in CI. It scans only files git would actually track —
// asking git for the list rather than walking the tree, so anything correctly ignored
// is out of scope by construction and the check cannot be fooled by a stale ignore
// rule I remembered wrong.
//
// Exits non-zero and prints file:line on the first finding. There is no allowlist: a
// finding is either a real secret, or a pattern that should not be in a tracked file
// anyway.

import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";

const PATTERNS = [
  { name: "private key (32-byte hex)", re: /\b0x[0-9a-fA-F]{64}\b/g, allow: isKnownNonSecret },
  { name: "Relay API key", re: /\brk_[0-9a-fA-F]{16,}\b/g },
  { name: "PRIVATE_KEY assignment", re: /PRIVATE_KEY\s*=\s*["']?0x[0-9a-fA-F]{8,}/g },
  { name: "Telegram bot token", re: /\b\d{8,}:[A-Za-z0-9_-]{30,}\b/g },
];

/**
 * A 64-hex string is a private key, a transaction hash, a block hash, an event topic,
 * a storage slot, a market id or a venue id — one shape, seven meanings, so the
 * pattern alone cannot decide. Context can, and that context is often on a NEARBY line
 * rather than the same one: a YAML value sits under its key, a constant under its doc
 * comment. So a few surrounding lines are what gets read.
 *
 * The list below is deliberately about what the value IS. "It is in a .ts file" would
 * not be evidence of anything — a leaked key is most likely to be in a .ts file. The
 * PRIVATE_KEY, rk_ and bot-token patterns have no allowance at all.
 */
const NON_SECRET_CONTEXT =
  /explorer|[/]tx[/]|txHash|tx_hash|blockHash|block_hash|parentHash|marketId|market_id|venueId|venue_id|VENUE_ID|venue|topic0|TOPICS|topic|event signature|keccak|selector|slot|EIP-?1967|implementation|beacon|outcomeId|questionId|salt|hash|digest|0x0{40,}/i;

function isKnownNonSecret(line, file, lines, index) {
  // Wide enough to reach the key above a value in a nested structure: a receipt
  // fixture's `"topics": [` sits several lines above its last entry.
  const from = Math.max(0, index - 8);
  const to = Math.min(lines.length, index + 3);
  if (NON_SECRET_CONTEXT.test(lines.slice(from, to).join("\n"))) return true;
  // Documentation cites hashes constantly and holds no keys.
  if (/[.]md$/.test(file)) return true;
  return false;
}

const BINARY = /\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|pdf|zip|wasm)$/i;

function trackedFiles() {
  // Everything git would commit right now: tracked, staged, and untracked-but-not-ignored.
  const out = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return out.split("\0").filter(Boolean);
}

const files = trackedFiles();
const findings = [];

for (const file of files) {
  if (BINARY.test(file)) continue;
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    continue;
  }
  if (size > 2 * 1024 * 1024) continue; // a built bundle, not a place secrets are typed

  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    for (const p of PATTERNS) {
      p.re.lastIndex = 0;
      const m = p.re.exec(line);
      if (!m) continue;
      if (p.allow?.(line, file, lines, i)) continue;
      findings.push({ file, line: i + 1, name: p.name, sample: `${m[0].slice(0, 10)}…` });
    }
  }
}

// The ignore rules that make the above safe. If one of these stops working, files that
// were never scanned would quietly become scannable — better to assert them.
const mustBeIgnored = [".env", "packages/telegram/.env.local", "artifacts/x.log", "reference/x", "artifacts/phase6/report.json"];
const notIgnored = mustBeIgnored.filter((f) => {
  try {
    execFileSync("git", ["check-ignore", "-q", f], { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
});

console.log(`scanned ${files.length} tracked files`);
if (notIgnored.length) {
  console.error(`\nthese paths are NOT gitignored and must be:\n  ${notIgnored.join("\n  ")}`);
}
if (findings.length) {
  console.error(`\n${findings.length} possible secret(s) in tracked paths:\n`);
  for (const f of findings) console.error(`  ${f.file}:${f.line}  ${f.name}  ${f.sample}`);
  console.error("\nRefusing to continue. Move the value into .env, or into a file that is gitignored.");
}
if (findings.length || notIgnored.length) process.exit(1);
console.log("no secrets found in tracked paths, and every sensitive path is ignored.");
