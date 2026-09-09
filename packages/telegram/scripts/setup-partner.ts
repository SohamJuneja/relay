// Register "Relay Telegram" as a partner and write its ids into .env.telegram.
//
//   pnpm --filter @relay/telegram setup
//
// The builder address is generated here and its private key is printed ONCE, because
// nobody has it otherwise and a builder address with a lost key cannot ever be
// verified. Everything else is written to disk.
//
// Re-running is safe: if .env.telegram already names a partner, the script checks it
// still resolves and stops rather than registering a second one.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "../../../.env") });

const API = (process.env.RELAY_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const OUT = path.resolve(here, "../.env.local");
const NAME = process.env.TELEGRAM_PARTNER_NAME ?? "Relay Telegram";

const readExisting = (): Record<string, string> => {
  if (!existsSync(OUT)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(OUT, "utf8").split("\n")) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (m) out[m[1]!] = m[2]!;
  }
  return out;
};

const existing = readExisting();
if (existing.VITE_RELAY_PARTNER) {
  const res = await fetch(`${API}/v1/partners/${existing.VITE_RELAY_PARTNER}/public`);
  if (res.ok) {
    const p = (await res.json()) as { partnerId: number; name: string; verified: boolean };
    console.log(`already registered: partner ${p.partnerId} "${p.name}" (verified: ${p.verified})`);
    console.log(`builder ${existing.VITE_RELAY_BUILDER}`);
    console.log(`nothing to do — delete ${path.relative(process.cwd(), OUT)} to register a new one`);
    process.exit(0);
  }
  console.log(`partner ${existing.VITE_RELAY_PARTNER} no longer resolves; registering again`);
}

// A throwaway builder address. Registering unverified is the honest state: this key
// exists only for a demo, and signing for it would claim a level of custody nobody
// actually has.
const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

const res = await fetch(`${API}/v1/partners`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ name: NAME, builderAddress: account.address, homepage: process.env.TELEGRAM_MINIAPP_URL || undefined }),
});
if (!res.ok) {
  console.error(`registration failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
const p = (await res.json()) as { partnerId: number; name: string; apiKey: string; builderAddress: string; verified: boolean; snippet: string };

writeFileSync(
  OUT,
  [
    "# Written by scripts/setup-partner.ts. The API key reads this partner's own",
    "# revenue data; the builder private key is NOT stored here and was printed once.",
    `VITE_RELAY_PARTNER=${p.partnerId}`,
    `VITE_RELAY_BUILDER=${p.builderAddress}`,
    `VITE_RELAY_API=${API}`,
    `TELEGRAM_PARTNER_API_KEY=${p.apiKey}`,
    "",
  ].join("\n"),
  "utf8",
);

console.log(`registered partner ${p.partnerId} "${p.name}" (verified: ${p.verified})`);
console.log(`builder address ${p.builderAddress}`);
console.log(`wrote ${path.relative(process.cwd(), OUT)} with the partner id, builder and API key`);
// stderr, not stdout: this is the one secret this script produces, and stdout is what
// gets piped into a log file, a CI artifact or a transcript. stderr keeps it on the
// operator's terminal and out of everything that records the run.
process.stderr.write("\nThe builder private key is printed once, to stderr, and stored nowhere." + "\n");
process.stderr.write("Keep it only if you intend to verify this partner later; otherwise discard it." + "\n");
process.stderr.write(`  ${privateKey}\n`);
