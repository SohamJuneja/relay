// Phase 6, Part D: the public end-to-end run, against the deployed URLs only.
//
//   node phase6-e2e.mjs
//
// Nothing here talks to localhost. A real reader's path: open the published article,
// onboard an instant wallet, take ONE $1 trade, and prove the fill carries the
// publisher's partner id on the public API and on the public console. Then register a
// brand-new partner through the live console and prove control of its builder address
// with a signature.
//
// The burner's private key is generated in the browser and never printed. The new
// partner's builder key is generated here, used to sign, and never printed either.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const API = "https://relay-server-htey.onrender.com";
const DEMO = "https://relay-demo-sohamjunejas-projects.vercel.app";
const CONSOLE = "https://relay-console-sohamjunejas-projects.vercel.app";
const CDN = "https://relay-cdn-sohamjunejas-projects.vercel.app";
const MINIAPP = "https://relay-miniapp-sohamjunejas-projects.vercel.app";
const PARTNER = 3;
const OUT = "E:/blockchain/somnia-relay/artifacts/phase6";

mkdirSync(OUT, { recursive: true });
const shots = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const report = {
  urls: { API, DEMO, CONSOLE, CDN, MINIAPP },
  shots, cdn: null, trade: null, burner: null, fill: null, attributionOk: false,
  ecosystem: null, newPartner: null, verify: null, dashboard: null, txs: [],
};

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const pageShot = async (p, name) => {
  await p.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  shots.push(`artifacts/phase6/${name}.png`);
  log(`  ${name}.png`);
};
const elShot = async (loc, name) => {
  await loc.screenshot({ path: path.join(OUT, `${name}.png`) });
  shots.push(`artifacts/phase6/${name}.png`);
  log(`  ${name}.png`);
};

// Watch the wire for the transactions the widget sends, so the receipt can be quoted
// by hash rather than described.
const SELECTORS = { "57915897": "tUSDC faucet", "095ea7b3": "approve", "718c2d4d": "placeBinaryOrder" };
const seen = new Set();
page.on("response", async (res) => {
  try {
    if (res.url().startsWith(API) && res.url().includes("/v1/gas-drip")) {
      const b = await res.json();
      if (b?.txHash && !seen.has(b.txHash)) { seen.add(b.txHash); report.txs.push(`gas drip ${b.txHash}`); }
      return;
    }
    if (res.request().method() !== "POST") return;
    const body = res.request().postData() ?? "";
    if (!body.includes("eth_sendRawTransaction")) return;
    const raw = (body.match(/0x[0-9a-fA-F]{100,}/) ?? [""])[0].toLowerCase();
    const hit = Object.keys(SELECTORS).find((s) => raw.includes(s));
    const out = await res.json();
    const hash = Array.isArray(out) ? out[0]?.result : out?.result;
    if (hash && !seen.has(hash)) { seen.add(hash); report.txs.push(`${hit ? SELECTORS[hit] : "tx"} ${hash}`); }
  } catch { /* not JSON, or already consumed */ }
});

// -- D1 the CDN bundle ------------------------------------------------------
log("CDN bundle");
{
  const r = await fetch(`${CDN}/relay.iife.js`);
  const src = await r.text();
  const blank = await ctx.newPage();
  await blank.setContent(`<script src="${CDN}/relay.iife.js"></script>`);
  await blank.waitForFunction(() => window.Relay?.version, { timeout: 30_000 });
  report.cdn = {
    status: r.status,
    bytes: src.length,
    cacheControl: r.headers.get("cache-control"),
    version: await blank.evaluate(() => window.Relay.version),
    api: await blank.evaluate(() => Object.keys(window.Relay).sort()),
  };
  await blank.close();
  log(`  ${r.status} - ${(src.length / 1024).toFixed(0)} KB - Relay.version ${report.cdn.version} - ${report.cdn.api.join(", ")}`);
}

// -- D2 the published article, and one real trade ---------------------------
log("the published article");
await page.goto(`${DEMO}/btc-window/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("[data-relay-market] .card", { timeout: 60_000 });
await page.waitForTimeout(4000);
report.widgetCount = await page.locator(".relay-widget-root").count();
await pageShot(page, "D1-article-live");
await elShot(page.locator("[data-relay-market] .card"), "D2-widget-live");

log("onboarding an instant wallet");
const w = page.locator("[data-relay-market]");
await w.getByRole("button", { name: /Trade in one click/i }).click();
await w.getByRole("button", { name: /Review (UP|DOWN)|Pick UP or DOWN/i }).first()
  .waitFor({ state: "visible", timeout: 300_000 });
await page.waitForTimeout(2500);
report.burner = await w.locator(".brand .mono").first().getAttribute("title").catch(() => null);
log(`  burner ${report.burner} (its key stays in the browser and is never printed)`);
await elShot(page.locator("[data-relay-market] .card"), "D3-wallet-ready");

await w.locator(".side:not([disabled])").first().waitFor({ state: "visible", timeout: 180_000 });
const priced = await w.locator(".side").evaluateAll((els) =>
  els.map((e, i) => ({ i, disabled: e.hasAttribute("disabled"), pct: Number((e.querySelector(".prob")?.textContent ?? "").replace("%", "")) })));
const usable = priced.filter((x) => !x.disabled && Number.isFinite(x.pct) && x.pct < 95);
const pick = usable.sort((a, b) => a.pct - b.pct)[0] ?? { i: 0 };
log(`  sides ${priced.map((x) => `${x.pct}%${x.disabled ? " (off)" : ""}`).join(" / ")} -> index ${pick.i}`);
await w.locator(".side").nth(pick.i).click();
await page.waitForTimeout(1200);
await w.locator(".act .btn").first().click();
await page.waitForTimeout(800);

let landed = "timeout";
for (let attempt = 1; attempt <= 5 && landed !== "receipt"; attempt++) {
  await w.locator(".act .btn").first().click();
  landed = await Promise.race([
    w.locator(".result .rows").first().waitFor({ state: "visible", timeout: 150_000 }).then(() => "receipt"),
    w.locator(".note[data-tone='warn']").first().waitFor({ state: "visible", timeout: 150_000 }).then(() => "rejected"),
  ]).catch(() => "timeout");
  if (landed === "receipt") break;
  const why = await w.locator(".note[data-tone='warn']").first().innerText().catch(() => "");
  log(`  attempt ${attempt} did not fill: "${why.replace(/\s+/g, " ").trim()}" - retrying`);
  await page.waitForTimeout(3000);
}
if (landed !== "receipt") throw new Error("the trade never reached a receipt");
// Every placeBinaryOrder the widget sent, not the first. The retry loop can send
// several — an attempt that crosses nothing produces a transaction and no fill —
// and picking one by position looks for a fill that never existed.
report.orderTxs = report.txs.filter((t) => t.startsWith("placeBinaryOrder")).map((t) => t.split(" ")[1]);
report.trade = report.orderTxs[report.orderTxs.length - 1] ?? null;
log(`  ${report.orderTxs.length} order tx(s): ${report.orderTxs.join(", ")}`);
await elShot(page.locator("[data-relay-market] .card"), "D4-receipt-live");

// -- D3 attribution on the public API ---------------------------------------
log("attribution on the public API");
// Match on any of the order transactions, and on the burner as a fallback: the
// fill is the burner's whether or not the hash bookkeeping was perfect.
const findFill = async (hashes, burner) => {
  const want = new Set((hashes ?? []).filter(Boolean).map((h) => h.toLowerCase()));
  const who = burner?.toLowerCase();
  const live = await fetch(`${API}/v1/markets/live?limit=25`).then((r) => r.json()).catch(() => []);
  const recent = await fetch(`${API}/v1/markets/recent?limit=40`).then((r) => r.json()).catch(() => []);
  const all = [...(Array.isArray(live) ? live : []), ...(Array.isArray(recent) ? recent : [])];
  for (const m of all) {
    const fills = await fetch(`${API}/v1/markets/${m.marketId}/fills?limit=100`).then((r) => r.json()).catch(() => []);
    if (!Array.isArray(fills)) continue;
    const hit = fills.find((f) => want.has((f.txHash ?? "").toLowerCase()) || (who && (f.takerOwner ?? "").toLowerCase() === who));
    if (hit) return hit;
  }
  return null;
};
const t0 = Date.now();
for (let i = 0; i < 45 && !report.fill; i++) {
  report.fill = await findFill(report.orderTxs, report.burner);
  if (!report.fill) await new Promise((r) => setTimeout(r, 2000));
}
if (report.fill) {
  report.indexLatencyMs = Date.now() - t0;
  report.attributionOk = report.fill.takerPartnerId === PARTNER;
  log(`  fill -> partner ${report.fill.takerPartnerId} - surface ${report.fill.takerSurfaceId} - builder ${report.fill.takerBuilder} - ${report.fill.quantity} @ ${report.fill.price} (found in ${report.indexLatencyMs} ms)`);
} else {
  log("  the fill was NOT found through the public API");
}
report.partnerPublic = await fetch(`${API}/v1/partners/${PARTNER}/public`).then((r) => r.json()).catch(() => null);
report.builders = await fetch(`${API}/v1/stats/builders?hours=24`).then((r) => r.json()).catch(() => null);

// -- D4 the public console --------------------------------------------------
log("the public console");
await page.goto(`${CONSOLE}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(".wordmark", { timeout: 60_000 });
await page.waitForTimeout(5000);
await pageShot(page, "D5-console-landing");

await page.goto(`${CONSOLE}/ecosystem`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
report.ecosystem = await page.evaluate(() => {
  const rows = [...document.querySelectorAll("tbody tr")].map((tr) =>
    [...tr.querySelectorAll("td,th")].map((td) => td.textContent.trim()).filter(Boolean).join(" | "));
  return { rowCount: rows.length, rows: rows.slice(0, 8) };
});
log(`  leaderboard rows: ${report.ecosystem.rowCount}`);
for (const r of report.ecosystem.rows) log(`    ${r}`);
await pageShot(page, "D6-ecosystem-live");

// -- D5 register a new partner, then prove control of the address -----------
log("registering a new partner on the live console");
const key = generatePrivateKey();
const acct = privateKeyToAccount(key);
log(`  new builder address ${acct.address} (its key is generated here, never printed, never sent)`);
await page.goto(`${CONSOLE}/register`, { waitUntil: "domcontentloaded" });
await page.getByLabel("Name").fill("Phase 6 Live Check");
await page.getByLabel(/Homepage/).fill(DEMO);
await page.getByLabel("Builder address").fill(acct.address);
await page.getByRole("button", { name: "Register" }).click();
await page.getByTestId("api-key").waitFor({ state: "visible", timeout: 60_000 });
const apiKey = (await page.getByTestId("api-key").innerText()).trim();
const snippet = (await page.getByTestId("snippet").innerText()).trim();
const mainText = await page.locator("main").innerText();
const newId = Number(/partner \*?\*?(\d+)/i.exec(mainText)?.[1] ?? 0);
report.newPartner = {
  partnerId: newId,
  builder: acct.address,
  keyLength: apiKey.length,
  keyPrefix: apiKey.slice(0, 3),
  snippetHasPartner: snippet.includes(`data-partner="${newId}"`),
  snippetHasBuilder: snippet.toLowerCase().includes(acct.address.toLowerCase()),
};
log(`  partner ${newId} - key ${apiKey.slice(0, 3)}... (${apiKey.length} chars, not printed in full)`);
log(`  snippet carries partner ${newId}: ${report.newPartner.snippetHasPartner}, builder: ${report.newPartner.snippetHasBuilder}`);
// Never let a live credential into a screenshot in the repo.
await page.getByTestId("api-key").evaluate((el) => { el.textContent = "rk_" + "\u2022".repeat(48); });
await page.getByRole("checkbox").check();
await pageShot(page, "D7-register-live");

log("proving control of the builder address");
const vm = await fetch(`${API}/v1/partners/${newId}/verification-message`).then((r) => r.json());
const signature = await acct.signMessage({ message: vm.message });
const vr = await fetch(`${API}/v1/partners/${newId}/verify`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-api-key": apiKey },
  body: JSON.stringify({ signature, nonce: vm.nonce, issued: vm.issued }),
});
report.verify = { status: vr.status, body: await vr.json().catch(() => null) };
log(`  verify -> ${vr.status} ${JSON.stringify(report.verify.body)}`);
report.newPartnerPublic = await fetch(`${API}/v1/partners/${newId}/public`).then((r) => r.json()).catch(() => null);
log(`  public card verified flag: ${report.newPartnerPublic?.verified}`);

// The dashboard, on the session key the console just stored.
await page.goto(`${CONSOLE}/dashboard`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(6000);
report.dashboard = await page.evaluate(() => ({
  heading: document.querySelector("h1")?.textContent?.trim() ?? null,
  hasVerifiedBadge: /verified/i.test(document.body.innerText),
}));
log(`  dashboard "${report.dashboard.heading}" - verified badge: ${report.dashboard.hasVerifiedBadge}`);
await pageShot(page, "D8-dashboard-live");

// -- D6 the mini-app, at a phone size ---------------------------------------
log("the Telegram mini-app");
const mp = await ctx.newPage();
await mp.setViewportSize({ width: 390, height: 780 });
await mp.goto(MINIAPP, { waitUntil: "domcontentloaded" });
await mp.waitForTimeout(7000);
report.miniapp = {
  hasCard: (await mp.locator(".card").count()) > 0,
  overflows: await mp.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1),
};
log(`  card painted: ${report.miniapp.hasCard} - horizontal overflow: ${report.miniapp.overflows}`);
await mp.screenshot({ path: path.join(OUT, "D9-miniapp-live.png"), fullPage: true });
shots.push("artifacts/phase6/D9-miniapp-live.png");
await mp.close();

report.health = await fetch(`${API}/health`).then((r) => r.json()).catch(() => null);
writeFileSync(path.join(OUT, "partD.json"), JSON.stringify(report, null, 2));
log("wrote artifacts/phase6/partD.json");
console.log("\n=== PART D SUMMARY ===");
console.log(JSON.stringify(report, null, 2));
await browser.close();
