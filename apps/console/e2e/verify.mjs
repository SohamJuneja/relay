// Phase 5, Part A5 verification: registration with proof of control.
//
//   node e2e/verify.mjs
//
// Injects a minimal EIP-1193 provider backed by a generated key, registers through
// the real form, and checks the partner comes back verified — then that the badge
// says so on the dashboard and the leaderboard.
//
// The injected provider is the honest way to test this: the console asks a wallet to
// sign, and a wallet is exactly what this is, just one whose key the test owns.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const CONSOLE = process.env.CONSOLE_URL ?? "http://127.0.0.1:5179";
const API = (process.env.API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const OUT = path.resolve(process.cwd(), "../../artifacts/phase5");
const NAME = process.env.PARTNER_NAME ?? "Ledger Signals";
mkdirSync(OUT, { recursive: true });

const shots = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const report = { name: NAME, shots, partner: null, builder: null, verified: null, badge: null, leaderboard: null };

const pageShot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  shots.push(`artifacts/phase5/${name}.png`);
  log(`  ${name}.png`);
};

const account = privateKeyToAccount(generatePrivateKey());
report.builder = account.address;
log(`builder wallet ${account.address} (its key stays in this process)`);

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });

// A wallet the page can talk to. `personal_sign` is answered here in Node, so the
// signature is produced by a real key over the exact string the console builds.
await ctx.exposeFunction("__sign", async (message) => account.signMessage({ message }));
await ctx.exposeFunction("__accounts", async () => [account.address]);
await ctx.addInitScript(() => {
  window.ethereum = {
    isMetaMask: false,
    async request({ method, params }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return window.__accounts();
      if (method === "personal_sign") {
        // params is [message, address]; the message may arrive as hex or as text.
        const raw = params[0];
        const text = typeof raw === "string" && raw.startsWith("0x") ? new TextDecoder().decode(Uint8Array.from(raw.slice(2).match(/../g).map((b) => parseInt(b, 16)))) : raw;
        return window.__sign(text);
      }
      if (method === "eth_chainId") return "0xc488";
      throw new Error(`unsupported method ${method}`);
    },
    on() {},
    removeListener() {},
  };
});

const page = await ctx.newPage();
page.on("console", (m) => {
  if (m.type() === "error") log("  [browser error]", m.text().slice(0, 160));
});

log(`registering "${NAME}" with a connected wallet`);
await page.goto(`${CONSOLE}/register`, { waitUntil: "domcontentloaded" });
await page.getByLabel("Name").fill(NAME);
await page.getByRole("button", { name: "Use connected wallet" }).click();
await page.waitForTimeout(600);
const filled = await page.getByLabel("Builder address").inputValue();
log(`  form filled with ${filled}`);
await page.getByRole("button", { name: "Register" }).click();

await page.getByTestId("api-key").waitFor({ state: "visible", timeout: 30_000 });
const apiKey = (await page.getByTestId("api-key").innerText()).trim();
const state = (await page.getByTestId("verified-state").innerText()).trim();
report.partner = Number(/partner (\d+)/i.exec(await page.locator("main").innerText())?.[1] ?? 0);
report.verified = /^Verified/i.test(state);
log(`  partner ${report.partner} · "${state}"`);

await page.getByTestId("api-key").evaluate((el) => {
  el.textContent = "rk_" + "•".repeat(48);
});
await page.getByRole("checkbox").check();
await pageShot(page, "A5-register-verified");

// The API is the authority, not the page.
const card = await fetch(`${API}/v1/partners/${report.partner}/public`).then((r) => r.json());
report.apiVerified = card.verified === true;
log(`  /v1/partners/${report.partner}/public says verified: ${card.verified}`);

// ── the badge on the dashboard ─────────────────────────────────────────────
await page.goto(`${CONSOLE}/dashboard`, { waitUntil: "domcontentloaded" });
const prompt = page.getByRole("button", { name: "Open dashboard" });
if (await prompt.isVisible().catch(() => false)) {
  await page.getByLabel("Partner id").fill(String(report.partner));
  await page.getByLabel("API key").fill(apiKey);
  await prompt.click();
}
await page.getByRole("heading", { name: NAME }).waitFor({ timeout: 60_000 });
await page.waitForTimeout(1500);
report.badge = (await page.getByTestId("verified-badge").innerText().catch(() => null))?.trim() ?? null;
log(`  dashboard badge: ${report.badge ?? "(none)"}`);
await pageShot(page, "A5-dashboard-verified");

// ── and on the public leaderboard ──────────────────────────────────────────
await page.goto(`${CONSOLE}/ecosystem`, { waitUntil: "domcontentloaded" });
await page.getByTestId("builder-leaderboard").waitFor({ timeout: 60_000 });
await page.waitForTimeout(2500);
report.leaderboard = await page.locator('[data-testid="builder-leaderboard"] tbody tr').allInnerTexts().then((rows) => rows.map((r) => r.replace(/\s+/g, " ").trim()));
report.leaderboardRows = report.leaderboard.length;
report.verifiedOnLeaderboard = report.leaderboard.some((r) => /verified/i.test(r));
log(`  leaderboard has ${report.leaderboardRows} row(s); a verified one is listed: ${report.verifiedOnLeaderboard}`);
await pageShot(page, "A5-ecosystem-verified");

writeFileSync(path.join(OUT, "partA5.json"), JSON.stringify(report, null, 2));
log("wrote artifacts/phase5/partA5.json");
console.log("\n=== A5 SUMMARY ===");
console.log(JSON.stringify(report, null, 2));
await browser.close();
