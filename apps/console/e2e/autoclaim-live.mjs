// Auto-claim, on the public console, with a real 5-minute window.
//
// Buys the cheaper side of a live 5m window with the instant wallet, waits out the
// close, and watches whether the card redeems on its own. A 5m window is roughly a
// coin flip, so this retries until one wins — a loss proves nothing either way.

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const CONSOLE = "https://relay-console-sohamjunejas-projects.vercel.app";
const OUT = "E:/blockchain/somnia-relay/artifacts/phase6";
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const ATTEMPTS = Number(process.env.ATTEMPTS ?? 4);

const report = { attempts: [], won: null, redeemTx: null, autoClaimed: false, burner: null };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1100 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();

const txs = [];
const SEL = { "57915897": "faucet", "095ea7b3": "approve", "718c2d4d": "placeBinaryOrder", "3d7d3f5a": "redeem" };
const seen = new Set();
page.on("response", async (res) => {
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
      txs.push({ what: hit ? SEL[hit] : "tx", hash });
      log(`  tx ${hit ? SEL[hit] : "?"} ${hash}`);
    }
  } catch {
    /* not JSON */
  }
});

await page.goto(`${CONSOLE}/`, { waitUntil: "domcontentloaded", timeout: 90_000 });
const w = page.locator('[data-testid="widget-preview"]');
await w.locator(".card").waitFor({ timeout: 60_000 });

// 5-minute windows: short enough to settle inside a run.
await w.locator(".seg").filter({ hasText: "5m" }).first().click().catch(() => undefined);
await page.waitForTimeout(2500);

log("onboarding the instant wallet");
await w.getByRole("button", { name: /Trade in one click/i }).click();
await w.getByRole("button", { name: /Review (UP|DOWN)|Pick UP or DOWN/i }).first().waitFor({ state: "visible", timeout: 300_000 });
await page.waitForTimeout(2500);
report.burner = await w.locator(".brand .mono").first().getAttribute("title").catch(() => null);
log(`  burner ${report.burner}`);

for (let attempt = 1; attempt <= ATTEMPTS && !report.won; attempt++) {
  log(`attempt ${attempt}`);
  // Back to the trade panel if a previous receipt is showing. The button is labelled
  // "Trade the next window", and a wrong selector here silently leaves the run stuck
  // on the receipt until the side locator times out.
  const back = w.getByRole("button", { name: /Trade the next window/i }).first();
  if (await back.isVisible().catch(() => false)) {
    await back.click();
    await page.waitForTimeout(2000);
  }
  // A 5m window may be between rounds; wait for a tradeable one rather than failing.
  const sides = w.locator(".side:not([disabled])").first();
  const ready = await sides.waitFor({ state: "visible", timeout: 200_000 }).then(() => true).catch(() => false);
  if (!ready) {
    log("  no tradeable side within 200s, moving to the next attempt");
    continue;
  }

  const priced = await w.locator(".side").evaluateAll((els) =>
    els.map((e, i) => ({ i, disabled: e.hasAttribute("disabled"), pct: Number((e.querySelector(".prob")?.textContent ?? "").replace("%", "")) })),
  );
  // The cheaper side: more upside if it lands, and a $1 order on a 99c side rounds
  // past the budget and the pool refuses it.
  const pick = priced.filter((x) => !x.disabled && Number.isFinite(x.pct) && x.pct < 95).sort((a, b) => a.pct - b.pct)[0];
  if (!pick) {
    log("  no usable side, waiting for the next window");
    await page.waitForTimeout(30_000);
    continue;
  }
  await w.locator(".side").nth(pick.i).click();
  await page.waitForTimeout(1200);
  await w.locator(".act .btn").first().click();
  await page.waitForTimeout(800);

  let landed = "timeout";
  for (let i = 0; i < 4 && landed !== "receipt"; i++) {
    await w.locator(".act .btn").first().click();
    landed = await Promise.race([
      w.locator(".result .rows").first().waitFor({ state: "visible", timeout: 120_000 }).then(() => "receipt"),
      w.locator(".note[data-tone='warn']").first().waitFor({ state: "visible", timeout: 120_000 }).then(() => "rejected"),
    ]).catch(() => "timeout");
    if (landed === "receipt") break;
    await page.waitForTimeout(3000);
  }
  const orderTx = txs.filter((t) => t.what === "placeBinaryOrder").pop()?.hash ?? null;
  log(`  ${landed} · ${orderTx}`);
  if (landed !== "receipt") continue;

  // Watch the receipt through settlement. Auto-claim, if it fires, does so here with
  // no interaction at all.
  const deadline = Date.now() + 9 * 60_000;
  let outcome = "pending";
  while (Date.now() < deadline) {
    await page.waitForTimeout(5000);
    const text = (await w.locator(".card").innerText().catch(() => "")).replace(/\s+/g, " ");
    if (/Claiming \$/.test(text)) {
      report.autoClaimed = true;
      log(`  AUTO-CLAIM: ${/Claiming \$[0-9.]+…?/.exec(text)?.[0]}`);
    }
    if (/Claimed/.test(text)) {
      outcome = "won";
      report.autoClaimed = true;
      log("  card shows Claimed");
      break;
    }
    if (/worth 0|Nothing to claim|closed against you/i.test(text)) {
      outcome = "lost";
      break;
    }
  }
  report.attempts.push({ attempt, orderTx, outcome });
  log(`  attempt ${attempt}: ${outcome}`);
  if (outcome === "won") {
    report.won = orderTx;
    report.redeemTx = txs.filter((t) => t.what === "redeem" || t.what === "tx").pop()?.hash ?? null;
    await w.locator(".card").screenshot({ path: path.join(OUT, "P2-autoclaim.png") });
    await page.screenshot({ path: path.join(OUT, "P2-autoclaim-page.png"), fullPage: true });
  }
}

report.txs = txs;
writeFileSync(path.join(OUT, "autoclaim.json"), JSON.stringify(report, null, 2));
console.log("\n=== AUTO-CLAIM RESULT ===");
console.log(JSON.stringify({ won: report.won, redeemTx: report.redeemTx, autoClaimed: report.autoClaimed, attempts: report.attempts, burner: report.burner }, null, 2));
await browser.close();
