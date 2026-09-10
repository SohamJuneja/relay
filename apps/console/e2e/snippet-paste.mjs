// The actual user journey for blocker 1: register, press Copy snippet, paste what is
// on the clipboard into a file, serve that file over http, and see whether the widget
// loads and attributes a trade.
//
// Reading the rendered <pre> would prove nothing — the bug was that the button copied
// something DIFFERENT from what the page displayed. So this reads the clipboard.

import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const CONSOLE = "https://relay-console-sohamjunejas-projects.vercel.app";
const API = "https://relay-server-htey.onrender.com";
const OUT = "E:/blockchain/somnia-relay/artifacts/phase6";
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const report = { clipboard: null, scriptUrl: null, scriptStatus: null, partner: null, builder: null, widgetLoaded: false, trade: null, fill: null, attributionOk: false, txs: [] };

const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 1000 },
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await ctx.newPage();

// ── register, then press the button a partner would press ───────────────────
const acct = privateKeyToAccount(generatePrivateKey());
report.builder = acct.address;
await page.goto(`${CONSOLE}/register`, { waitUntil: "domcontentloaded", timeout: 90_000 });
await page.getByLabel("Name").fill("Snippet Paste Check");
await page.getByLabel(/Homepage/).fill(CONSOLE);
await page.getByLabel("Builder address").fill(acct.address);
await page.getByRole("button", { name: "Register" }).click();
await page.getByTestId("api-key").waitFor({ state: "visible", timeout: 60_000 });
report.partner = Number(/partner \*?\*?(\d+)/i.exec(await page.locator("main").innerText())?.[1] ?? 0);
log(`registered partner ${report.partner}`);

await page.getByRole("button", { name: /Copy snippet/i }).first().click();
await page.waitForTimeout(800);
report.clipboard = await page.evaluate(() => navigator.clipboard.readText());
const rendered = (await page.getByTestId("snippet").innerText()).trim();
log("clipboard:");
for (const line of report.clipboard.split("\n")) log(`  ${line}`);
// The browser normalises clipboard line endings to CRLF on Windows, so compare the
// content rather than the separators.
const norm = (t) => t.replace(/\r/g, "").trim();
report.matchesRendered = norm(report.clipboard) === norm(rendered);
log(`clipboard === rendered block: ${report.matchesRendered}`);

report.scriptUrl = /src="([^"]+)"/.exec(report.clipboard)?.[1] ?? null;
log(`script URL: ${report.scriptUrl}`);

// Does that URL actually resolve? The bug was a hostname that does not.
try {
  const r = await fetch(report.scriptUrl);
  report.scriptStatus = r.status;
  log(`script URL fetch: ${r.status} (${(await r.text()).length} bytes)`);
} catch (e) {
  report.scriptStatus = `FETCH FAILED: ${e.message}`;
  log(`script URL fetch FAILED: ${e.message}`);
}

// ── paste it into a page and serve it over http ─────────────────────────────
const html = `<!doctype html><meta charset="utf-8"><title>Pasted snippet</title>
<body style="font:14px system-ui;padding:32px;max-width:760px;margin:0 auto">
<h1>A publisher's page</h1>
<p>Everything below the line is exactly what the console put on the clipboard.</p><hr>
${report.clipboard}
</body>`;
const file = path.join(OUT, "pasted-snippet.html");
writeFileSync(file, html);

const server = createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const url = `http://127.0.0.1:${server.address().port}/`;
log(`serving the pasted file at ${url}`);

const SEL = { "57915897": "faucet", "095ea7b3": "approve", "718c2d4d": "placeBinaryOrder" };
const seen = new Set();
const page2 = await ctx.newPage();
page2.on("response", async (res) => {
  try {
    if (res.request().method() !== "POST") return;
    const body = res.request().postData() ?? "";
    if (!body.includes("eth_sendRawTransaction")) return;
    const raw = (body.match(/0x[0-9a-fA-F]{100,}/) ?? [""])[0].toLowerCase();
    const hit = Object.keys(SEL).find((s) => raw.includes(s));
    const out = await res.json();
    const hash = Array.isArray(out) ? out[0]?.result : out?.result;
    if (hash && !seen.has(hash)) {
      seen.add(hash);
      report.txs.push({ what: hit ? SEL[hit] : "tx", hash });
      log(`  tx ${hit ? SEL[hit] : "?"} ${hash}`);
    }
  } catch {
    /* not JSON */
  }
});

await page2.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
const w = page2.locator("[data-relay-market]");
const loaded = await w.locator(".card").waitFor({ state: "visible", timeout: 60_000 }).then(() => true).catch(() => false);
report.widgetLoaded = loaded;
log(`widget loaded from the pasted snippet: ${loaded}`);
if (loaded) await w.locator(".card").screenshot({ path: path.join(OUT, "P1-pasted-snippet.png") });

// ── one trade, to prove the attribution the snippet carries ─────────────────
if (loaded) {
  await w.getByRole("button", { name: /Trade in one click/i }).click();
  await w.getByRole("button", { name: /Review (UP|DOWN)|Pick UP or DOWN/i }).first().waitFor({ state: "visible", timeout: 300_000 });
  await page2.waitForTimeout(2500);
  await w.locator(".side:not([disabled])").first().waitFor({ state: "visible", timeout: 180_000 });
  const priced = await w.locator(".side").evaluateAll((els) =>
    els.map((e, i) => ({ i, disabled: e.hasAttribute("disabled"), pct: Number((e.querySelector(".prob")?.textContent ?? "").replace("%", "")) })),
  );
  const pick = priced.filter((x) => !x.disabled && Number.isFinite(x.pct) && x.pct < 95).sort((a, b) => a.pct - b.pct)[0] ?? { i: 0 };
  await w.locator(".side").nth(pick.i).click();
  await page2.waitForTimeout(1200);
  await w.locator(".act .btn").first().click();
  await page2.waitForTimeout(800);
  let landed = "timeout";
  for (let i = 0; i < 5 && landed !== "receipt"; i++) {
    await w.locator(".act .btn").first().click();
    landed = await Promise.race([
      w.locator(".result .rows").first().waitFor({ state: "visible", timeout: 150_000 }).then(() => "receipt"),
      w.locator(".note[data-tone='warn']").first().waitFor({ state: "visible", timeout: 150_000 }).then(() => "rejected"),
    ]).catch(() => "timeout");
    if (landed === "receipt") break;
    await page2.waitForTimeout(3000);
  }
  const orderTxs = report.txs.filter((t) => t.what === "placeBinaryOrder").map((t) => t.hash);
  report.trade = orderTxs[orderTxs.length - 1] ?? null;
  log(`trade ${landed} · ${report.trade}`);

  if (landed === "receipt") {
    const want = new Set(orderTxs.map((h) => h.toLowerCase()));
    for (let i = 0; i < 40 && !report.fill; i++) {
      const live = await fetch(`${API}/v1/markets/live?limit=20`).then((r) => r.json()).catch(() => []);
      const rec = await fetch(`${API}/v1/markets/recent?limit=20`).then((r) => r.json()).catch(() => []);
      for (const m of [...(Array.isArray(live) ? live : []), ...(Array.isArray(rec) ? rec : [])]) {
        const fills = await fetch(`${API}/v1/markets/${m.marketId}/fills?limit=100`).then((r) => r.json()).catch(() => []);
        if (!Array.isArray(fills)) continue;
        const hit = fills.find((f) => want.has((f.txHash ?? "").toLowerCase()));
        if (hit) {
          report.fill = hit;
          break;
        }
      }
      if (!report.fill) await new Promise((r) => setTimeout(r, 3000));
    }
    if (report.fill) {
      report.attributionOk = report.fill.takerPartnerId === report.partner;
      log(`fill → partner ${report.fill.takerPartnerId} surface ${report.fill.takerSurfaceId} builder ${report.fill.takerBuilder}`);
    }
  }
}

server.close();
writeFileSync(path.join(OUT, "snippet-paste.json"), JSON.stringify(report, null, 2));
console.log("\n=== PASTED SNIPPET RESULT ===");
console.log(
  JSON.stringify(
    {
      clipboard: report.clipboard,
      matchesRendered: report.matchesRendered,
      scriptUrl: report.scriptUrl,
      scriptStatus: report.scriptStatus,
      widgetLoaded: report.widgetLoaded,
      partner: report.partner,
      trade: report.trade,
      attributionOk: report.attributionOk,
      fillPartner: report.fill?.takerPartnerId ?? null,
      fillSurface: report.fill?.takerSurfaceId ?? null,
    },
    null,
    2,
  ),
);
await browser.close();
