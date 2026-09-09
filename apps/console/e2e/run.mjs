// Phase 4 verification: register a new partner in the real console, trade through
// the widget mounted on its own register page, and prove the dashboard shows that
// partner's fill — and only that partner's.
//
//   node e2e/run.mjs
//
// It generates a throwaway builder address (only the address is ever printed), does
// ONE real $1 trade with an instant wallet, measures how long the fill takes to
// appear over the socket and on a reload, and checks that partner 1 cannot see it.
// Screenshots land in artifacts/phase4/.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const CONSOLE = process.env.CONSOLE_URL ?? "http://127.0.0.1:5179";
const API = (process.env.API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const OUT = path.resolve(process.cwd(), "../../artifacts/phase4");
const PARTNER_NAME = process.env.PARTNER_NAME ?? "Demo News";

mkdirSync(OUT, { recursive: true });
const shots = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const report = { shots, partner: null, builder: null, trade: null, timing: {}, share: null, leaderboard: null, isolation: null, txs: [] };

async function shot(target, name) {
  await target.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: target.screenshot.length === undefined && name.startsWith("page-") });
  shots.push(`artifacts/phase4/${name}.png`);
  log(`  ${name}.png`);
}
const pageShot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  shots.push(`artifacts/phase4/${name}.png`);
  log(`  ${name}.png`);
};

async function main() {
  // A brand new builder code, so the leaderboard genuinely gains a second row.
  // The key is generated, used to derive an address, and never printed or sent.
  const builder = privateKeyToAccount(generatePrivateKey()).address;
  report.builder = builder;
  log(`throwaway builder address ${builder} (its key is never printed and never leaves this process)`);

  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") log("  [browser error]", m.text().slice(0, 160));
  });

  const SELECTORS = { "57915897": "tUSDC faucet", "095ea7b3": "approve", "718c2d4d": "placeBinaryOrder" };
  const seen = new Set();
  page.on("response", async (res) => {
    try {
      if (res.url().startsWith(API) && res.url().includes("/v1/gas-drip")) {
        const b = await res.json();
        if (b?.txHash && !seen.has(b.txHash)) {
          seen.add(b.txHash);
          report.txs.push(`gas drip ${b.txHash}`);
        }
        return;
      }
      const req = res.request();
      if (req.method() !== "POST") return;
      const body = req.postData() ?? "";
      if (!body.includes("eth_sendRawTransaction")) return;
      const raw = (body.match(/0x[0-9a-fA-F]{100,}/) ?? [""])[0].toLowerCase();
      const hit = Object.keys(SELECTORS).find((s) => raw.includes(s));
      const out = await res.json();
      const hash = Array.isArray(out) ? out[0]?.result : out?.result;
      if (hash && !seen.has(hash)) {
        seen.add(hash);
        report.txs.push(`${hit ? SELECTORS[hit] : "tx"} ${hash}`);
      }
    } catch {
      /* not JSON, or already consumed */
    }
  });

  // ── landing ──────────────────────────────────────────────────────────────
  log("opening the console");
  await page.goto(`${CONSOLE}/`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".wordmark", { timeout: 30_000 });
  await page.waitForTimeout(4000); // let the live widget paint
  await pageShot(page, "01-landing");

  // ── register ─────────────────────────────────────────────────────────────
  log(`registering "${PARTNER_NAME}"`);
  await page.goto(`${CONSOLE}/register`, { waitUntil: "domcontentloaded" });
  await page.getByLabel("Name").fill(PARTNER_NAME);
  await page.getByLabel(/Homepage/).fill("https://demo.example");
  await page.getByLabel("Builder address").fill(builder);
  await page.getByRole("button", { name: "Register" }).click();

  await page.getByTestId("api-key").waitFor({ state: "visible", timeout: 30_000 });
  const apiKey = (await page.getByTestId("api-key").innerText()).trim();
  const snippet = (await page.getByTestId("snippet").innerText()).trim();
  const heading = await page.locator("h1").first().innerText();
  report.partner = Number(/partner \*?\*?(\d+)/i.exec(await page.locator("main").innerText())?.[1] ?? 0);
  log(`  ${heading.trim()} — partner ${report.partner}`);
  log(`  key shown once: ${apiKey.slice(0, 6)}… (${apiKey.length} chars, not printed in full)`);

  report.snippet = snippet;
  report.snippetHasPartner = snippet.includes(`data-partner="${report.partner}"`);
  report.snippetHasBuilder = snippet.includes(builder);
  log(`  snippet carries partner ${report.partner}: ${report.snippetHasPartner}; builder: ${report.snippetHasBuilder}`);

  // The key must be shown exactly once and never again.
  report.keyShownOnce = (await page.locator(`text=${apiKey}`).count()) === 1;

  // Mask the key before the screenshot: an artifact in the repo must not carry a
  // live credential, even a testnet one.
  await page.getByTestId("api-key").evaluate((el) => {
    el.textContent = "rk_" + "•".repeat(48);
  });
  await page.getByRole("checkbox").check();
  await pageShot(page, "02-register-success");

  // ── one real trade, through the preview on this very page ────────────────
  log("onboarding an instant wallet in the register-page preview");
  const w = page.getByTestId("widget-preview");
  await w.locator(".card").waitFor({ timeout: 30_000 });
  await w.getByRole("button", { name: /Trade in one click/i }).click();
  await w
    .getByRole("button", { name: /Review (UP|DOWN)|Pick UP or DOWN/i })
    .first()
    .waitFor({ state: "visible", timeout: 240_000 });
  await page.waitForTimeout(2500);
  report.burner = await w.locator(".brand .mono").first().getAttribute("title").catch(() => null);
  log(`  burner ${report.burner}`);

  // The cheaper side: a 99¢ side is a $1 order for one share whose escrow rounds
  // past the budget and the pool refuses it.
  await w.locator(".side:not([disabled])").first().waitFor({ state: "visible", timeout: 120_000 });
  const priced = await w.locator(".side").evaluateAll((els) =>
    els.map((e, i) => ({ i, disabled: e.hasAttribute("disabled"), pct: Number((e.querySelector(".prob")?.textContent ?? "").replace("%", "")) })),
  );
  const pick = priced.filter((x) => !x.disabled && Number.isFinite(x.pct)).sort((a, b) => a.pct - b.pct)[0] ?? { i: 0 };
  log(`  sides ${priced.map((x) => `${x.pct}%${x.disabled ? " (off)" : ""}`).join(" / ")} → taking index ${pick.i}`);
  await w.locator(".side").nth(pick.i).click();
  await page.waitForTimeout(1200);
  await w.locator(".act .btn").first().click();
  await page.waitForTimeout(800);

  let landed = "timeout";
  for (let attempt = 1; attempt <= 4 && landed !== "receipt"; attempt++) {
    await w.locator(".act .btn").first().click();
    landed = await Promise.race([
      w.locator(".result .rows").first().waitFor({ state: "visible", timeout: 120_000 }).then(() => "receipt"),
      w.locator(".note[data-tone='warn']").first().waitFor({ state: "visible", timeout: 120_000 }).then(() => "rejected"),
    ]).catch(() => "timeout");
    if (landed === "receipt") break;
    const why = await w.locator(".note[data-tone='warn']").first().innerText().catch(() => "");
    log(`  attempt ${attempt} did not fill: "${why.replace(/\s+/g, " ").trim()}" — retrying`);
    await page.waitForTimeout(2500);
  }
  if (landed !== "receipt") throw new Error("the trade never reached a receipt");
  const tradedAt = Date.now();
  report.trade = (report.txs.find((t) => t.startsWith("placeBinaryOrder")) ?? "").split(" ")[1] ?? null;
  log(`  trade tx ${report.trade}`);
  await shot(w, "03-trade-receipt");

  // ── dashboard: live over the socket ──────────────────────────────────────
  log("opening the dashboard with the new key");
  await page.goto(`${CONSOLE}/dashboard`, { waitUntil: "domcontentloaded" });
  // The key is already in sessionStorage from registration, so the prompt should be
  // skipped entirely. If it is not, fall back to pasting it.
  const prompt = page.getByRole("button", { name: "Open dashboard" });
  if (await prompt.isVisible().catch(() => false)) {
    log("  (session was not carried; pasting the key)");
    await page.getByLabel("Partner id").fill(String(report.partner));
    await page.getByLabel("API key").fill(apiKey);
    await prompt.click();
  }
  await page.getByRole("heading", { name: PARTNER_NAME }).waitFor({ timeout: 60_000 });

  const rowSel = `table tbody tr`;
  const wsStart = Date.now();
  const appeared = await page
    .locator(rowSel)
    .first()
    .waitFor({ state: "visible", timeout: 120_000 })
    .then(() => true)
    .catch(() => false);
  report.timing.wsSeconds = appeared ? Number(((Date.now() - wsStart) / 1000).toFixed(1)) : null;
  report.timing.fromTradeSeconds = appeared ? Number(((Date.now() - tradedAt) / 1000).toFixed(1)) : null;
  log(`  fill visible on the dashboard ${report.timing.wsSeconds}s after opening it, ${report.timing.fromTradeSeconds}s after the trade`);

  await page.waitForTimeout(2500);
  const kpiText = await page.locator(".kpis").first().innerText();
  report.kpis = kpiText.replace(/\s+/g, " ").trim();
  log(`  KPIs: ${report.kpis}`);
  const shareTxt = /Share of venue flow ([\d.]+%|—)/.exec(kpiText);
  report.share = shareTxt?.[1] ?? null;
  await pageShot(page, "04-dashboard");

  // ── dashboard after a reload ─────────────────────────────────────────────
  const reloadStart = Date.now();
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(rowSel).first().waitFor({ state: "visible", timeout: 60_000 });
  report.timing.reloadSeconds = Number(((Date.now() - reloadStart) / 1000).toFixed(1));
  report.fillRows = await page.locator(rowSel).count();
  log(`  after a reload the fill is still there in ${report.timing.reloadSeconds}s (${report.fillRows} row(s))`);

  // dark, and narrow
  await page.locator('.seg button[aria-pressed="false"]').last().click().catch(() => undefined);
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
  await page.waitForTimeout(700);
  await pageShot(page, "05-dashboard-dark");
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.setViewportSize({ width: 375, height: 900 });
  await page.waitForTimeout(900);
  await pageShot(page, "06-dashboard-375");
  await page.setViewportSize({ width: 1440, height: 1100 });

  // ── ecosystem ────────────────────────────────────────────────────────────
  log("checking the public ecosystem page");
  await page.goto(`${CONSOLE}/ecosystem`, { waitUntil: "domcontentloaded" });
  await page.getByTestId("builder-leaderboard").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(2500);
  const builders = await page.locator('[data-testid="builder-leaderboard"] tbody tr').allInnerTexts();
  report.leaderboard = builders.map((b) => b.replace(/\s+/g, " ").trim());
  report.leaderboardRows = builders.length;
  report.leaderboardHasNewBuilder = builders.some((b) => b.toLowerCase().includes(builder.slice(2, 8).toLowerCase()));
  log(`  leaderboard has ${builders.length} builder(s); the new one is listed: ${report.leaderboardHasNewBuilder}`);
  await pageShot(page, "07-ecosystem");

  // ── docs ─────────────────────────────────────────────────────────────────
  await page.goto(`${CONSOLE}/docs/embed`, { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { level: 1 }).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(600);
  await pageShot(page, "08-docs-embed");

  // ── isolation: partner 1 must not see partner N's fill, and vice versa ───
  log("checking partner isolation");
  const p1key = process.env.PARTNER1_KEY ?? "";
  const mine = await fetch(`${API}/v1/partners/${report.partner}/fills?limit=50`, { headers: { "x-api-key": apiKey } }).then((r) => r.json());
  const mineHasTrade = Array.isArray(mine) && mine.some((f) => f.txHash === report.trade);
  let p1HasTrade = null;
  let p1KeyOnMine = null;
  if (p1key) {
    const theirs = await fetch(`${API}/v1/partners/1/fills?limit=50`, { headers: { "x-api-key": p1key } }).then((r) => r.json());
    p1HasTrade = Array.isArray(theirs) && theirs.some((f) => f.txHash === report.trade);
    // partner 1's key must not open partner N's data either.
    const cross = await fetch(`${API}/v1/partners/${report.partner}/fills?limit=5`, { headers: { "x-api-key": p1key } });
    p1KeyOnMine = cross.status;
  }
  report.isolation = {
    newPartnerSeesOwnFill: mineHasTrade,
    partner1SeesNewPartnersFill: p1HasTrade,
    partner1KeyOnNewPartnerRoute: p1KeyOnMine,
    newKeyOnPartner1Route: (await fetch(`${API}/v1/partners/1/fills?limit=5`, { headers: { "x-api-key": apiKey } })).status,
  };
  log(`  isolation ${JSON.stringify(report.isolation)}`);

  const share = await fetch(`${API}/v1/partners/${report.partner}/share?hours=24`, { headers: { "x-api-key": apiKey } }).then((r) => r.json());
  report.shareApi = share;
  log(`  share of venue flow: ${share.sharePct}% (${share.partnerNotional} of ${share.venueNotional})`);

  writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  log("wrote artifacts/phase4/report.json");
  console.log("\n=== PHASE 4 E2E SUMMARY ===");
  console.log(JSON.stringify({ ...report, snippet: undefined }, null, 2));
  await browser.close();
}

await main();
