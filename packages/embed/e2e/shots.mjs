// Phase 3.5 screenshot set: drive the polished widget through every screen and
// width that the eight fixes touch, and record how often a live window is seen
// without an opening price.
//
//   node e2e/shots.mjs
//
// It onboards an instant wallet, captures the trade / confirm / receipt screens,
// the positions strip with a real open position, both narrow columns, light and
// dark, and finally the settled result (claiming if the position won). One real
// $1 trade. The burner's private key is never printed.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const PLAYGROUND = process.env.PLAYGROUND ?? "http://127.0.0.1:5178/dev/index.html";
const API = (process.env.API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const OUT = path.resolve(process.cwd(), "../../artifacts/phase3b");
const RESOLVE_TIMEOUT_MS = Number(process.env.RESOLVE_TIMEOUT_MS ?? 15 * 60_000);

mkdirSync(OUT, { recursive: true });
const shots = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const report = { shots, burner: null, trade: null, verdict: null, claim: null, unknownOpen: null, txs: [] };

async function shot(target, name) {
  await target.screenshot({ path: path.join(OUT, `${name}.png`) });
  shots.push(`artifacts/phase3b/${name}.png`);
  log(`  ${name}.png`);
}

const widget = (page, id) => page.locator(`#${id} .card`);
const btn = (page, id, text) => page.locator(`#${id}`).getByRole("button", { name: text });

/**
 * How often a Trading window is visible with no opening price yet — the state fix 6
 * is about. Sampled straight from the API once a second for the length of the run,
 * so the number is what a reader could actually have seen, not what the indexer logged.
 */
function watchUnknownOpen() {
  const seen = { samples: 0, withGap: 0, markets: new Set() };
  const t = setInterval(async () => {
    try {
      const r = await fetch(`${API}/v1/markets/live?limit=10&book=false`);
      if (!r.ok) return;
      const rows = await r.json();
      const now = Math.floor(Date.now() / 1000);
      seen.samples++;
      let gap = false;
      for (const m of rows) {
        if (m.status === 1 && m.openingPriceRaw === null && now - m.tradingStart > 5) {
          gap = true;
          seen.markets.add(m.marketId);
        }
      }
      if (gap) seen.withGap++;
    } catch {
      /* the sampler must never break the run */
    }
  }, 1000);
  return {
    stop() {
      clearInterval(t);
      return { samples: seen.samples, samplesWithGap: seen.withGap, distinctMarkets: seen.markets.size };
    },
  };
}

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1100 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") log("  [browser error]", m.text().slice(0, 160));
  });

  const SELECTORS = { "57915897": "tUSDC faucet", "095ea7b3": "approve", "718c2d4d": "placeBinaryOrder", "558a7297": "setOperator", "5b1ffcf2": "redeem", "88cb9474": "redeemMany" };
  const seenTx = new Set();
  page.on("response", async (res) => {
    try {
      if (res.url().startsWith(API) && res.url().includes("/v1/gas-drip")) {
        const b = await res.json();
        if (b?.txHash && !seenTx.has(b.txHash)) {
          seenTx.add(b.txHash);
          report.txs.push(`gas drip ${b.txHash}`);
        }
        return;
      }
      const req = res.request();
      if (req.method() !== "POST") return;
      const body = req.postData() ?? "";
      if (!body.includes("eth_sendRawTransaction")) return;
      const raw = (body.match(/0x[0-9a-fA-F]{100,}/) ?? [""])[0].toLowerCase();
      const hit = Object.keys(SELECTORS).find((sel) => raw.includes(sel));
      const out = await res.json();
      const hash = Array.isArray(out) ? out[0]?.result : out?.result;
      if (hash && !seenTx.has(hash)) {
        seenTx.add(hash);
        report.txs.push(`${hit ? SELECTORS[hit] : "tx"} ${hash}`);
      }
    } catch {
      /* not JSON, or already consumed */
    }
  });

  const watcher = watchUnknownOpen();

  log("opening the playground");
  await page.goto(PLAYGROUND, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#w-script .card", { timeout: 30_000 });
  await page.waitForTimeout(4000);
  await shot(page, "01-playground");
  await shot(widget(page, "w-script"), "02-idle-light");

  // The question line is the headline fix: capture what it says.
  const q = await page.locator("#w-script .q").first().innerText().catch(() => "");
  const qTitle = await page.locator("#w-script .q").first().getAttribute("title").catch(() => "");
  report.question = { text: q.trim(), title: qTitle };
  log(`  question: "${q.trim()}" (title "${qTitle}")`);

  const sub = await page.locator("#w-script .side .sub").allInnerTexts().catch(() => []);
  report.sideCaptions = sub.map((x) => x.trim());
  log(`  side captions: ${report.sideCaptions.join(" | ")}`);

  // ── onboarding ──
  log("instant-wallet onboarding");
  await btn(page, "w-script", /Trade in one click/i).click();
  await page
    .locator("#w-script")
    .getByRole("button", { name: /Review (UP|DOWN)|Pick UP or DOWN/i })
    .first()
    .waitFor({ state: "visible", timeout: 240_000 });
  await page.waitForTimeout(2000);
  report.burner = await page.locator("#w-script .brand .mono").first().getAttribute("title").catch(() => null);
  log(`  burner ${report.burner} (its key never leaves the browser)`);
  await shot(widget(page, "w-script"), "03-ready-light");

  // ── the disabled CTA must be neutral, not a pale UP ──
  const ctaBg = await page.locator("#w-script .act .btn").first().evaluate((el) => getComputedStyle(el).backgroundColor);
  report.disabledCta = { text: (await page.locator("#w-script .act .btn").first().innerText()).trim(), background: ctaBg, disabled: await page.locator("#w-script .act .btn").first().isDisabled() };
  log(`  disabled CTA "${report.disabledCta.text}" background ${ctaBg}`);
  await shot(widget(page, "w-script"), "04-cta-disabled-neutral");

  // ── narrow widths ──
  for (const [id, name] of [["w-narrow", "05-narrow-300"], ["w-320", "06-narrow-320"]]) {
    await shot(widget(page, id), name);
    const overflow = await page.locator(`#${id} .card`).evaluate((el) => {
      const bad = [];
      for (const n of el.querySelectorAll("*")) {
        if (n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX === "visible") bad.push(`${n.className || n.tagName}:${n.scrollWidth}>${n.clientWidth}`);
      }
      return { cardOverflow: el.scrollWidth > el.clientWidth + 1, clipped: bad.slice(0, 6) };
    });
    report[name] = overflow;
    log(`  ${name}: card overflows ${overflow.cardOverflow}, clipped ${overflow.clipped.length ? overflow.clipped.join(", ") : "none"}`);
  }

  // ── dark ──
  await page.locator("#theme").click();
  await page.waitForTimeout(600);
  await shot(page, "07-dark-page");
  await shot(widget(page, "w-script"), "08-ready-dark");
  await shot(widget(page, "w-narrow"), "09-narrow-300-dark");
  await page.locator("#theme").click();
  await page.waitForTimeout(500);

  // ── pick a side and review ──
  log("placing a $1 trade");
  // Take the cheaper of the two quoted sides. A side trading at 99.9¢ is a $1 order
  // for one share whose escrow rounds past the budget, and the pool rejects it — a
  // real behaviour, but not the one these screenshots are for.
  await page.locator("#w-script .side:not([disabled])").first().waitFor({ state: "visible", timeout: 120_000 });
  const priced = await page.locator("#w-script .side").evaluateAll((els) =>
    els.map((e, i) => ({ i, disabled: e.hasAttribute("disabled"), pct: Number((e.querySelector(".prob")?.textContent ?? "").replace("%", "")) })),
  );
  // PREFER=favourite buys the higher-probability side. The claim path can only be
  // photographed on a win, and a screenshot run should not need five attempts of a
  // coin flip to get one. Anything at or above 95% is still excluded: a $1 order for
  // one share there rounds its escrow past the budget and the pool refuses it.
  const usable = priced.filter((x) => !x.disabled && Number.isFinite(x.pct) && x.pct < 95);
  const pick =
    (process.env.PREFER === "favourite"
      ? usable.sort((a, b) => b.pct - a.pct)[0]
      : usable.sort((a, b) => a.pct - b.pct)[0]) ?? { i: 0 };
  log(`  sides ${priced.map((x) => `${x.pct}%${x.disabled ? " (off)" : ""}`).join(" / ")} → taking index ${pick.i}`);
  await page.locator("#w-script .side").nth(pick.i).click();
  await page.waitForTimeout(1200);
  await shot(widget(page, "w-script"), "10-side-selected");

  await page.locator("#w-script .act .btn").first().click();
  await page.waitForTimeout(900);
  await shot(widget(page, "w-script"), "11-confirm");
  const rows = await page.locator("#w-script .row dt").allInnerTexts();
  report.confirmRows = rows.map((r) => r.trim());
  log(`  confirm rows: ${report.confirmRows.join(" | ")}`);

  // Confirm, and try again if the touch moves. An IOC that finds nothing left at its
  // limit is ordinary on a thin book — the widget already re-quotes once internally,
  // and a screenshot run should not fall over the second time it happens.
  let landed = "timeout";
  for (let attempt = 1; attempt <= 4 && landed !== "receipt"; attempt++) {
    await page.locator("#w-script .act .btn").first().click();
    if (attempt === 1) {
      await page.waitForTimeout(1200);
      await shot(widget(page, "w-script"), "12-pending");
    }
    landed = await Promise.race([
      page.locator("#w-script .result .rows").first().waitFor({ state: "visible", timeout: 120_000 }).then(() => "receipt"),
      page.locator("#w-script .note[data-tone='warn']").first().waitFor({ state: "visible", timeout: 120_000 }).then(() => "rejected"),
    ]).catch(() => "timeout");
    if (landed === "receipt") break;
    const why = await page.locator("#w-script .note[data-tone='warn']").first().innerText().catch(() => "");
    report.tradeRetries = (report.tradeRetries ?? 0) + 1;
    log(`  attempt ${attempt} did not fill: "${why.replace(/\s+/g, " ").trim()}" — retrying`);
    if (attempt === 1) await shot(widget(page, "w-script"), "12b-order-rejected");
    await page.waitForTimeout(2500);
  }
  if (landed !== "receipt") throw new Error("the order never reached a receipt");
  await page.waitForTimeout(1500);
  await shot(widget(page, "w-script"), "13-receipt");
  const attribution = await page.locator("#w-script .row", { hasText: "Attribution" }).first().innerText().catch(() => "");
  report.attribution = attribution.replace(/\s+/g, " ").trim();
  log(`  attribution line: "${report.attribution}"`);
  report.trade = (report.txs.find((t) => t.startsWith("placeBinaryOrder")) ?? "").split(" ")[1] ?? null;
  log(`  trade tx ${report.trade}`);

  // ── positions strip: go back to the trade screen while the position is open ──
  await page.locator("#w-script").getByRole("button", { name: /Place another/i }).click();
  await page.waitForTimeout(4000);
  const posText = await page.locator("#w-script .pos").first().innerText().catch(() => "");
  report.positionsStrip = posText.replace(/\s+/g, " ").trim();
  log(`  positions strip: "${report.positionsStrip}"`);
  await shot(widget(page, "w-script"), "14-positions-strip-open");
  await shot(widget(page, "w-narrow"), "15-narrow-300-with-position");

  // ── settle ──
  log("waiting for the window to settle");
  await page.locator("#w-script").getByRole("button", { name: /Place another|Review|Pick/i }).first().waitFor({ timeout: 5000 }).catch(() => undefined);
  const verdictLoc = page.locator("#w-script .verdict", { hasText: /^(WON|LOST|VOIDED)$/ }).first();
  const claimLoc = page.locator("#w-script").getByRole("button", { name: /^Claim/i }).first();
  // Reopen the receipt so the verdict can render there; the strip is the other route.
  const reopen = setInterval(() => {
    void page.locator("#w-script .pos[data-tap='true']").first().click({ timeout: 1000 }).catch(() => undefined);
  }, 5000);
  const how = await Promise.race([
    verdictLoc.waitFor({ state: "visible", timeout: RESOLVE_TIMEOUT_MS }).then(() => "verdict"),
    claimLoc.waitFor({ state: "visible", timeout: RESOLVE_TIMEOUT_MS }).then(() => "claim"),
  ]).catch(() => null);
  clearInterval(reopen);

  if (how) {
    await page.waitForTimeout(1200);
    const verdict = (await verdictLoc.innerText().catch(() => "WON")).trim();
    report.verdict = verdict;
    await shot(widget(page, "w-script"), "16-settled");
    log(`  verdict ${verdict} (via the ${how})`);
    if (verdict === "WON" || verdict === "VOIDED") {
      await shot(widget(page, "w-script"), "17-won-claimable");
      await claimLoc.click().catch(() => undefined);
      await page.waitForTimeout(18_000);
      await shot(widget(page, "w-script"), "18-claimed");
      const after = await fetch(`${API}/v1/wallets/${report.burner ?? "0x0"}/claimable`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      report.claim = { clicked: true, claimableAfter: after?.total ?? null, txs: report.txs.filter((t) => /redeem|setOperator/.test(t)) };
      log(`  claimed; claimable now ${after?.total ?? "?"}`);
    } else {
      await shot(widget(page, "w-script"), "17-lost");
      report.claim = { clicked: false, reason: "held the losing side" };
    }
  } else {
    log("  the window did not settle inside the timeout");
    await shot(widget(page, "w-script"), "16-still-open");
  }

  report.unknownOpen = watcher.stop();
  log(`  unknown-open: ${report.unknownOpen.samplesWithGap} of ${report.unknownOpen.samples} samples, ${report.unknownOpen.distinctMarkets} distinct market(s)`);

  writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  log("wrote artifacts/phase3b/report.json");
  console.log("\n=== SHOTS SUMMARY ===");
  console.log(JSON.stringify(report, null, 2));
  await browser.close();
}

await main();
