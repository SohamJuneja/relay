// Phase 7A verification, on the public URLs only.
//
// Re-captures the three screenshots the bugs were found in, plus the dashboard with
// a partner that has exactly one fill — which is the case that produced the
// single-bar, years-wide x axis.
//
// Deliberately gentle with the API: the previous run exhausted a 120/min rate limit
// with a brute-force fill search and then blamed the widget for what it saw.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const API = "https://relay-server-htey.onrender.com";
const CONSOLE = "https://relay-console-sohamjunejas-projects.vercel.app";
const OUT = "E:/blockchain/somnia-relay/artifacts/phase6";
mkdirSync(OUT, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const report = { shots: [], partner: null, builder: null, trade: null, txs: [], chart: null, ecosystem: null, widgetStates: [] };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 1100 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
const shot = async (name) => {
  await page.screenshot({ path: path.join(OUT, `${name}.png`), fullPage: true });
  report.shots.push(name);
  log(`  ${name}.png`);
};

const SELECTORS = { "57915897": "tUSDC faucet", "095ea7b3": "approve", "718c2d4d": "placeBinaryOrder" };
const seen = new Set();
page.on("response", async (res) => {
  try {
    if (res.request().method() !== "POST") return;
    const body = res.request().postData() ?? "";
    if (!body.includes("eth_sendRawTransaction")) return;
    const raw = (body.match(/0x[0-9a-fA-F]{100,}/) ?? [""])[0].toLowerCase();
    const hit = Object.keys(SELECTORS).find((sel) => raw.includes(sel));
    const out = await res.json();
    const hash = Array.isArray(out) ? out[0]?.result : out?.result;
    if (hash && !seen.has(hash)) {
      seen.add(hash);
      report.txs.push(`${hit ? SELECTORS[hit] : "tx"} ${hash}`);
    }
  } catch {
    /* not JSON */
  }
});

// ── D6: ecosystem, with the series table that used to contradict the KPI ─────
log("ecosystem");
await page.goto(`${CONSOLE}/ecosystem`, { waitUntil: "domcontentloaded", timeout: 90_000 });
await page.waitForTimeout(9000);
report.ecosystem = await page.evaluate(() => {
  const kpi = [...document.querySelectorAll(".kpi, [class*='kpi']")].map((e) => e.textContent.replace(/\s+/g, " ").trim());
  const rows = [...document.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td,th")].map((td) => td.textContent.trim()).filter(Boolean).join(" | "));
  return { kpis: kpi.filter((t) => /zero-fill|untaken/i.test(t)).slice(0, 4), rows: rows.slice(0, 6), rowCount: rows.length };
});
log(`  KPIs: ${report.ecosystem.kpis.join("  ·  ")}`);
for (const r of report.ecosystem.rows) log(`    ${r}`);
await shot("D6-ecosystem-live");

// ── D7: register, screenshotted after the widget has actually loaded ─────────
log("register");
const acct = privateKeyToAccount(generatePrivateKey());
report.builder = acct.address;
await page.goto(`${CONSOLE}/register`, { waitUntil: "domcontentloaded", timeout: 90_000 });
await page.getByLabel("Name").fill("Relay Live Check");
await page.getByLabel(/Homepage/).fill(CONSOLE);
await page.getByLabel("Builder address").fill(acct.address);
await page.getByRole("button", { name: "Register" }).click();
await page.getByTestId("api-key").waitFor({ state: "visible", timeout: 60_000 });
const apiKey = (await page.getByTestId("api-key").innerText()).trim();
report.partner = Number(/partner \*?\*?(\d+)/i.exec(await page.locator("main").innerText())?.[1] ?? 0);
log(`  partner ${report.partner}, builder ${acct.address}`);

// The bug was a claim made before the first lookup returned. Record what the card
// says over the first seconds, so the screenshot is not the only evidence.
const card = page.locator('[data-testid="widget-preview"] .card');
for (const ms of [400, 400, 400, 800, 1000, 3000]) {
  await page.waitForTimeout(ms);
  const t = (await card.first().innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  report.widgetStates.push(/No live .* window right now/.test(t) ? "EMPTY-STATE" : /Loading the live/.test(t) ? "loading" : "market");
}
log(`  widget over the first ~6s: ${report.widgetStates.join(" → ")}`);
await page.getByTestId("api-key").evaluate((el) => {
  el.textContent = "rk_" + "\u2022".repeat(48);
});
await page.getByRole("checkbox").check();
await shot("D7-register-live");

// ── one $1 trade, so the dashboard chart has exactly one non-zero bucket ─────
log("one trade from the register preview");
const w = page.getByTestId("widget-preview");
await w.getByRole("button", { name: /Trade in one click/i }).click();
await w.getByRole("button", { name: /Review (UP|DOWN)|Pick UP or DOWN/i }).first().waitFor({ state: "visible", timeout: 300_000 });
await page.waitForTimeout(2500);
await w.locator(".side:not([disabled])").first().waitFor({ state: "visible", timeout: 180_000 });
const priced = await w.locator(".side").evaluateAll((els) =>
  els.map((e, i) => ({ i, disabled: e.hasAttribute("disabled"), pct: Number((e.querySelector(".prob")?.textContent ?? "").replace("%", "")) })),
);
const pick = priced.filter((x) => !x.disabled && Number.isFinite(x.pct) && x.pct < 95).sort((a, b) => a.pct - b.pct)[0] ?? { i: 0 };
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
  await page.waitForTimeout(3000);
}
report.trade = (report.txs.filter((t) => t.startsWith("placeBinaryOrder")).pop() ?? "").split(" ")[1] ?? null;
log(`  trade ${landed} · ${report.trade}`);

// ── D8 / A2: the dashboard, once the fill is indexed ────────────────────────
log("waiting for the fill to be indexed, then the dashboard");
for (let i = 0; i < 30; i++) {
  const s = await fetch(`${API}/v1/partners/${report.partner}/public`).then((r) => r.json()).catch(() => null);
  if (s?.fills > 0) break;
  await new Promise((r) => setTimeout(r, 3000));
}
await page.goto(`${CONSOLE}/dashboard`, { waitUntil: "domcontentloaded", timeout: 90_000 });
await page.waitForTimeout(9000);

report.chart = await page.evaluate(() => {
  const heading = [...document.querySelectorAll("h2")].find((h) => /routed notional per hour/i.test(h.textContent));
  const cardEl = heading?.closest(".card");
  const labels = [...(cardEl?.querySelectorAll(".u-axis") ?? [])];
  const svgText = cardEl ? cardEl.textContent.replace(/\s+/g, " ").trim() : "(no card)";
  return { present: !!cardEl, axisNodes: labels.length, text: svgText.slice(0, 160) };
});
const ticks = await page.evaluate(() => {
  const c = [...document.querySelectorAll("canvas")].length;
  return { canvases: c };
});
log(`  chart present=${report.chart.present} canvases=${ticks.canvases}`);
await shot("D8-dashboard-live");
await shot("A2-dashboard");

const bd = await fetch(`${API}/v1/partners/${report.partner}/breakdown?hours=24`, { headers: { "x-api-key": apiKey } }).then((r) => r.json()).catch(() => null);
if (bd?.byHour) {
  const nz = bd.byHour.filter((h) => h.notional > 0 || h.fills > 0);
  report.byHour = { buckets: bd.byHour.length, nonZero: nz.length, firstTs: bd.byHour[0]?.hourTs, lastTs: bd.byHour[bd.byHour.length - 1]?.hourTs };
  log(`  byHour: ${report.byHour.buckets} buckets, ${report.byHour.nonZero} non-zero`);
  log(`  span: ${new Date(report.byHour.firstTs * 1000).toISOString()} → ${new Date(report.byHour.lastTs * 1000).toISOString()}`);
}

writeFileSync(path.join(OUT, "phase7a.json"), JSON.stringify(report, null, 2));
log("wrote artifacts/phase6/phase7a.json");
console.log("\n=== SUMMARY ===");
console.log(JSON.stringify({ ...report, txs: report.txs }, null, 2));
await browser.close();
