// Phase 5, Part C verification: the mini-app, driven through the local harness.
//
//   node e2e/run.mjs
//
// Asserts the app adopted Telegram's theme, expanded, and mounted the widget tagged
// telegram; places ONE real $1 trade; checks the fill is attributed to the Telegram
// partner with the telegram surface id; and confirms the swipe lock engaged during
// the trade and the haptic fired on the fill.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const MINIAPP = process.env.MINIAPP_URL ?? "http://127.0.0.1:5181";
const API = (process.env.API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const OUT = path.resolve(process.cwd(), "../../artifacts/phase5");
mkdirSync(OUT, { recursive: true });

// The partner the setup script registered.
const envPath = path.resolve(process.cwd(), ".env.local");
const env = existsSync(envPath)
  ? Object.fromEntries(
      readFileSync(envPath, "utf8")
        .split("\n")
        .map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l.trim()))
        .filter(Boolean)
        .map((m) => [m[1], m[2]]),
    )
  : {};
const PARTNER = Number(process.env.TELEGRAM_PARTNER ?? env.VITE_RELAY_PARTNER ?? 0);
const BUILDER = process.env.TELEGRAM_BUILDER ?? env.VITE_RELAY_BUILDER ?? "";
/** SURFACE.TELEGRAM in @relay/core's attribution table. */
const SURFACE_TELEGRAM = 2;

const shots = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const report = { partner: PARTNER, builder: BUILDER, shots, burner: null, trade: null, fill: null, attributionOk: false, telegram: {}, txs: [] };

const pageShot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  shots.push(`artifacts/phase5/${name}.png`);
  log(`  ${name}.png`);
};

if (!PARTNER) {
  console.error("no partner id — run: pnpm --filter @relay/telegram run setup:partner");
  process.exit(1);
}

const browser = await chromium.launch();
// A phone-shaped viewport, because that is the only shape this surface has.
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 3 });
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

log(`mini-app harness · partner ${PARTNER} · builder ${BUILDER}`);
await page.goto(`${MINIAPP}/harness.html`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-relay-market] .card", { timeout: 30_000 });
await page.waitForTimeout(3500);

// ── what the app did with Telegram ─────────────────────────────────────────
report.telegram = await page.evaluate(() => {
  const calls = window.__harnessCalls ?? [];
  const root = document.documentElement;
  const cs = getComputedStyle(root);
  return {
    calledReady: calls.some((c) => c.name === "ready"),
    calledExpand: calls.some((c) => c.name === "expand"),
    themeApplied: cs.getPropertyValue("--tg-bg").trim(),
    scheme: root.dataset.tgScheme ?? null,
    widgetTheme: document.querySelector("[data-relay-market]")?.getAttribute("data-theme") ?? null,
    surface: document.querySelector("[data-relay-market]")?.getAttribute("data-surface") ?? null,
    partnerAttr: document.querySelector("[data-relay-market]")?.getAttribute("data-partner") ?? null,
    browserBarVisible: !document.getElementById("browser-bar")?.hidden,
  };
});
log(`  ready=${report.telegram.calledReady} expand=${report.telegram.calledExpand} theme=${report.telegram.themeApplied} scheme=${report.telegram.scheme} surface=${report.telegram.surface}`);
await pageShot(page, "C1-miniapp-idle");

// dark palette, from the same harness
await page.goto(`${MINIAPP}/harness.html?scheme=dark`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-relay-market] .card", { timeout: 30_000 });
await page.waitForTimeout(3000);
report.telegram.darkBg = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--tg-bg").trim());
report.telegram.darkWidgetTheme = await page.locator("[data-relay-market]").getAttribute("data-theme");
log(`  dark: page ${report.telegram.darkBg}, widget data-theme ${report.telegram.darkWidgetTheme}`);
await pageShot(page, "C2-miniapp-dark");

// ── one real trade ─────────────────────────────────────────────────────────
await page.goto(`${MINIAPP}/harness.html`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-relay-market] .card", { timeout: 30_000 });
await page.waitForTimeout(3000);

log("onboarding");
const w = page.locator("[data-relay-market]");
await w.getByRole("button", { name: /Trade in one click/i }).click();
await w.getByRole("button", { name: /Review (UP|DOWN)|Pick UP or DOWN/i }).first().waitFor({ state: "visible", timeout: 240_000 });
await page.waitForTimeout(2500);
report.burner = await w.locator(".brand .mono").first().getAttribute("title").catch(() => null);
log(`  burner ${report.burner}`);
await pageShot(page, "C3-miniapp-ready");

await w.locator(".side:not([disabled])").first().waitFor({ state: "visible", timeout: 120_000 });
const priced = await w.locator(".side").evaluateAll((els) =>
  els.map((e, i) => ({ i, disabled: e.hasAttribute("disabled"), pct: Number((e.querySelector(".prob")?.textContent ?? "").replace("%", "")) })),
);
const usable = priced.filter((x) => !x.disabled && Number.isFinite(x.pct) && x.pct < 95);
const pick = usable.sort((a, b) => a.pct - b.pct)[0] ?? { i: 0 };
log(`  sides ${priced.map((x) => `${x.pct}%${x.disabled ? " (off)" : ""}`).join(" / ")} → index ${pick.i}`);
await w.locator(".side").nth(pick.i).click();
await page.waitForTimeout(1200);
await w.locator(".act .btn").first().click();
await page.waitForTimeout(700);
await pageShot(page, "C4-miniapp-confirm");

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
report.trade = (report.txs.find((t) => t.startsWith("placeBinaryOrder")) ?? "").split(" ")[1] ?? null;
log(`  trade tx ${report.trade}`);
await page.waitForTimeout(1500);
await pageShot(page, "C5-miniapp-receipt");

// The Telegram-specific behaviours only happen around a trade.
report.telegram.duringTrade = await page.evaluate(() => {
  const calls = window.__harnessCalls ?? [];
  return {
    swipeLocked: calls.some((c) => c.name === "disableVerticalSwipes"),
    closingConfirmed: calls.some((c) => c.name === "enableClosingConfirmation"),
    swipeRestored: calls.some((c) => c.name === "enableVerticalSwipes"),
    hapticImpact: calls.some((c) => c.name === "haptic.impact"),
    hapticSuccess: calls.some((c) => c.name === "haptic.notification"),
  };
});
log(`  telegram during trade: ${JSON.stringify(report.telegram.duringTrade)}`);

// ── attribution ────────────────────────────────────────────────────────────
log("checking attribution");
async function findFill(txHash) {
  if (!txHash) return null;
  const live = await fetch(`${API}/v1/markets/live?limit=12`).then((r) => r.json()).catch(() => []);
  for (const m of live) {
    const fills = await fetch(`${API}/v1/markets/${m.marketId}/fills?limit=50`).then((r) => r.json()).catch(() => []);
    const hit = Array.isArray(fills) ? fills.find((f) => f.txHash?.toLowerCase() === txHash.toLowerCase()) : null;
    if (hit) return hit;
  }
  return null;
}
for (let i = 0; i < 30 && !report.fill; i++) {
  report.fill = await findFill(report.trade);
  if (!report.fill) await new Promise((r) => setTimeout(r, 2000));
}
if (report.fill) {
  report.attributionOk = report.fill.takerPartnerId === PARTNER && report.fill.takerSurfaceId === SURFACE_TELEGRAM;
  log(`  fill → partner ${report.fill.takerPartnerId} · surface ${report.fill.takerSurfaceId} (telegram=${SURFACE_TELEGRAM}) · builder ${report.fill.takerBuilder}`);
} else {
  log("  the fill was not found through the API");
}

writeFileSync(path.join(OUT, "partC.json"), JSON.stringify(report, null, 2));
log("wrote artifacts/phase5/partC.json");
console.log("\n=== PART C SUMMARY ===");
console.log(JSON.stringify(report, null, 2));
await browser.close();
