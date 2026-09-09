// Phase 5, Part B verification: the widget inside a publisher's page.
//
//   node e2e/run.mjs
//
// Front page, article at desktop and 390 px in both themes, the mid-article call-out
// scrolling to the one card on the page, and ONE real $1 trade from that card checked
// against the API for attribution to the publisher's partner id.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const SITE = process.env.DEMO_SITE_URL ?? "http://127.0.0.1:5180";
const API = (process.env.API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const PARTNER = Number(process.env.DEMO_PARTNER ?? 3);
const OUT = path.resolve(process.cwd(), "../../artifacts/phase5");
mkdirSync(OUT, { recursive: true });

const shots = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const report = { partner: PARTNER, shots, trade: null, burner: null, fill: null, attributionOk: false, callout: null, mobile: null, txs: [] };

const pageShot = async (page, name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  shots.push(`artifacts/phase5/${name}.png`);
  log(`  ${name}.png`);
};
const elShot = async (loc, name) => {
  await loc.screenshot({ path: path.join(OUT, `${name}.png`) });
  shots.push(`artifacts/phase5/${name}.png`);
  log(`  ${name}.png`);
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 }, deviceScaleFactor: 2 });
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

// ── front page ─────────────────────────────────────────────────────────────
log("front page");
await page.goto(`${SITE}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".lead h1", { timeout: 30_000 });
await page.waitForTimeout(700);
report.frontHeadline = (await page.locator(".lead h1").innerText()).trim();
report.teaserCount = await page.locator("article.teaser").count();
log(`  "${report.frontHeadline}" · ${report.teaserCount} teasers`);
await pageShot(page, "B1-front-page");

// ── article, desktop ───────────────────────────────────────────────────────
log("article");
await page.goto(`${SITE}/btc-window/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".article-body h1", { timeout: 30_000 });
await page.waitForSelector("[data-relay-market] .card", { timeout: 30_000 });
await page.waitForTimeout(3500);

// Exactly one widget on the page: the call-out is a link, not a second mount.
report.widgetCount = await page.locator(".relay-widget-root").count();
report.wordCount = (await page.locator(".article-body").innerText()).split(/\s+/).filter(Boolean).length;
report.opinionFlag = (await page.locator(".opinion-flag").innerText()).trim();
log(`  ${report.widgetCount} widget(s), ~${report.wordCount} words, flag "${report.opinionFlag}"`);
await pageShot(page, "B2-article-desktop");
await elShot(page.locator("[data-relay-market] .card"), "B3-widget-in-rail");

// ── the mid-article call-out ───────────────────────────────────────────────
const before = await page.evaluate(() => window.scrollY);
await page.locator("[data-scroll-to-widget]").click();
await page.waitForTimeout(1200);
const after = await page.evaluate(() => window.scrollY);
const railVisible = await page.locator("#trade-window").isVisible();
report.callout = { scrolledFrom: Math.round(before), scrolledTo: Math.round(after), moved: after !== before, railVisible, widgetsAfterClick: await page.locator(".relay-widget-root").count() };
log(`  call-out scrolled ${Math.round(before)} → ${Math.round(after)}, still ${report.callout.widgetsAfterClick} widget(s)`);
await pageShot(page, "B4-callout-scrolled");

// ── dark ───────────────────────────────────────────────────────────────────
await page.emulateMedia({ colorScheme: "dark" });
await page.waitForTimeout(900);
await pageShot(page, "B5-article-dark");
await page.emulateMedia({ colorScheme: "light" });

// ── 390 px ─────────────────────────────────────────────────────────────────
log("mobile at 390 px");
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(1200);
report.mobile = await page.evaluate(() => {
  const rail = document.querySelector(".rail");
  const body = document.querySelector(".article-body");
  const r = rail?.getBoundingClientRect();
  const b = body?.getBoundingClientRect();
  const doc = document.documentElement;
  return {
    railBelowArticle: r && b ? r.top + window.scrollY > b.top + window.scrollY : null,
    railSticky: rail ? getComputedStyle(rail).position : null,
    horizontalOverflow: doc.scrollWidth > doc.clientWidth + 1,
    widgetWidth: Math.round(document.querySelector("[data-relay-market] .card")?.getBoundingClientRect().width ?? 0),
  };
});
log(`  rail below the article: ${report.mobile.railBelowArticle}, position ${report.mobile.railSticky}, page overflows: ${report.mobile.horizontalOverflow}`);
await pageShot(page, "B6-article-390");
await page.emulateMedia({ colorScheme: "dark" });
await page.waitForTimeout(700);
await pageShot(page, "B7-article-390-dark");
await page.emulateMedia({ colorScheme: "light" });
await page.setViewportSize({ width: 1400, height: 1100 });
await page.waitForTimeout(800);

// ── one real trade, from the article's card ────────────────────────────────
log("trading from the article's widget");
const w = page.locator("[data-relay-market]");
await w.getByRole("button", { name: /Trade in one click/i }).click();
await w.getByRole("button", { name: /Review (UP|DOWN)|Pick UP or DOWN/i }).first().waitFor({ state: "visible", timeout: 240_000 });
await page.waitForTimeout(2500);
report.burner = await w.locator(".brand .mono").first().getAttribute("title").catch(() => null);
log(`  burner ${report.burner} (its key never leaves the browser)`);

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
report.trade = (report.txs.find((t) => t.startsWith("placeBinaryOrder")) ?? "").split(" ")[1] ?? null;
log(`  trade tx ${report.trade}`);
await page.waitForTimeout(1200);
await elShot(page.locator("[data-relay-market] .card"), "B8-receipt-in-rail");
await pageShot(page, "B9-article-after-trade");

// ── attribution ────────────────────────────────────────────────────────────
log("checking attribution");
for (let i = 0; i < 30 && !report.fill; i++) {
  const rows = await fetch(`${API}/v1/markets/live?limit=1`).then(() => null).catch(() => null);
  void rows;
  const fills = await fetch(`${API}/v1/partners/${PARTNER}/public`).then((r) => r.json()).catch(() => null);
  void fills;
  // The public card has no tx list, so read the market's own fills and match the hash.
  const mk = await fetch(`${API}/v1/stats/builders?hours=1`).then((r) => r.json()).catch(() => null);
  void mk;
  const found = await findFill(report.trade);
  if (found) report.fill = found;
  else await new Promise((r) => setTimeout(r, 2000));
}
async function findFill(txHash) {
  if (!txHash) return null;
  const recent = await fetch(`${API}/v1/markets/live?limit=12`).then((r) => r.json()).catch(() => []);
  for (const m of recent) {
    const fills = await fetch(`${API}/v1/markets/${m.marketId}/fills?limit=50`).then((r) => r.json()).catch(() => []);
    const hit = Array.isArray(fills) ? fills.find((f) => f.txHash?.toLowerCase() === txHash.toLowerCase()) : null;
    if (hit) return hit;
  }
  return null;
}
if (report.fill) {
  report.attributionOk = report.fill.takerPartnerId === PARTNER;
  log(`  fill → partner ${report.fill.takerPartnerId} · surface ${report.fill.takerSurfaceId} · builder ${report.fill.takerBuilder} · ${report.fill.quantity} @ ${report.fill.price}`);
} else {
  log("  the fill was not found through the API");
}

writeFileSync(path.join(OUT, "partB.json"), JSON.stringify(report, null, 2));
log("wrote artifacts/phase5/partB.json");
console.log("\n=== PART B SUMMARY ===");
console.log(JSON.stringify(report, null, 2));
await browser.close();
