// Phase 3 verification: drive the real widget in headless Chromium against the
// live Relay API and Somnia Shannon.
//
//   node e2e/run.mjs
//
// It runs instant-wallet onboarding (gas drip → tUSDC faucet → approve), places
// ONE $1 UP trade, checks the API attributed the fill to the partner, waits for
// the window to resolve and claims if we won. Screenshots of every screen state
// land in artifacts/phase3/. The burner's private key is never printed.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const PLAYGROUND = process.env.PLAYGROUND ?? "http://127.0.0.1:5178/dev/index.html";
const API = (process.env.API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const OUT = path.resolve(process.cwd(), "../../artifacts/phase3");
const BUILDER = "0xb5eCf004491aa8589a82af91633D18867fcFF038";
const TEST_VENUE = "0x1a1e6821cde7d0159c0d293177871e09677b4e42307c7db3ba94f8648a5a050f"; // 1-minute test venue: reliably thin books
const RESOLVE_TIMEOUT_MS = Number(process.env.RESOLVE_TIMEOUT_MS ?? 20 * 60_000);

mkdirSync(OUT, { recursive: true });
const shots = [];
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const report = { shots, states: {}, trade: null, burner: null, claim: null };

async function shot(target, name) {
  const file = path.join(OUT, `${name}.png`);
  await target.screenshot({ path: file });
  shots.push(`artifacts/phase3/${name}.png`);
  log(`  📷 ${name}.png`);
}

const widget = (page, id) => page.locator(`#${id} .card`);
const btn = (page, id, text) => page.locator(`#${id}`).getByRole("button", { name: text });

async function main() {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("console", (m) => {
    if (m.type() === "error") log("  [browser error]", m.text().slice(0, 200));
  });

  // Record the transactions the widget makes, so the report can cite the drip and
  // faucet hashes. The widget never puts them in the DOM — a partner does not care
  // which hash funded the burner — so read them off the wire instead of adding
  // test-only surface to the product. Signed transactions are identified by the
  // selector sitting in the raw hex; the drip comes back in the API's JSON.
  const SELECTORS = {
    "57915897": "tUSDC faucet(uint256)",
    "095ea7b3": "approve(pool)",
    "718c2d4d": "placeBinaryOrder",
    "558a7297": "setOperator",
    "8c0e156d": "redeem",
    "0b7bf5f1": "redeemMany",
  };
  report.onboarding = [];
  const seen = new Set();
  const record = (step, hash, note) => {
    if (!hash || seen.has(hash)) return;
    seen.add(hash);
    report.onboarding.push(note ? { step, hash, note } : { step, hash });
    log(`  tx ${step} ${hash}`);
  };
  page.on("response", async (res) => {
    try {
      if (res.url().startsWith(API) && res.url().includes("/v1/gas-drip")) {
        const b = await res.json();
        record("gas drip (API wallet → burner)", b?.txHash, `${b?.amount} STT from ${b?.from}`);
        return;
      }
      const req = res.request();
      if (req.method() !== "POST") return;
      const body = req.postData() ?? "";
      if (!body.includes("eth_sendRawTransaction")) return;
      const raw = (body.match(/0x[0-9a-fA-F]{100,}/) ?? [""])[0].toLowerCase();
      const hit = Object.keys(SELECTORS).find((sel) => raw.includes(sel));
      const out = await res.json();
      record(hit ? SELECTORS[hit] : "burner tx", (Array.isArray(out) ? out[0]?.result : out?.result));
    } catch {
      /* not JSON, or the body was already consumed — the run does not depend on it */
    }
  });

  log("opening the playground");
  await page.goto(PLAYGROUND, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#w-script .card", { timeout: 30_000 });
  await page.waitForTimeout(3500); // first book + price frames
  await shot(page, "01-playground-three-mounts");
  await shot(widget(page, "w-script"), "02-widget-idle");

  // ── instant wallet onboarding ─────────────────────────────────────────────
  log("instant-wallet onboarding");
  await btn(page, "w-script", /Trade in one click/i).click();
  await page.waitForSelector("#w-script .steps", { timeout: 15_000 });
  await page.waitForTimeout(900);
  await shot(widget(page, "w-script"), "03-onboarding-running");
  // Wait for the outcome, not the internals: the Review button only renders once a
  // wallet exists and the onboarding panel has closed. An error note ends it too.
  // The panel unmounts about a second after it succeeds, so sample it while it is
  // still alive; reading it after the wait returned an empty list every time.
  let stepStates = [];
  const sampler = setInterval(() => {
    void page
      .locator("#w-script .steps li")
      .evaluateAll((els) => els.map((e) => `${e.textContent.trim().split("·")[0].trim()}=${e.dataset.state}`))
      .then((s) => {
        if (s.length) stepStates = s;
      })
      .catch(() => {});
  }, 400);

  const ready = page.locator("#w-script").getByRole("button", { name: /Review (UP|DOWN)|Pick UP or DOWN/i }).first();
  const failed = page.locator("#w-script .steps + .note[data-tone='warn']").first();
  await Promise.race([
    ready.waitFor({ state: "visible", timeout: 240_000 }),
    failed.waitFor({ state: "visible", timeout: 240_000 }),
  ]).catch(() => log("  (onboarding did not finish in 240 s)"));
  clearInterval(sampler);
  if (stepStates.length) log(`  steps: ${stepStates.join(", ")}`);
  report.onboardingSteps = stepStates;
  await shot(widget(page, "w-script"), "04-onboarding-done");
  await page.waitForTimeout(1500);

  report.burner = (await page.locator("#w-script .brand .mono").first().getAttribute("title").catch(() => null)) ?? null;
  log(`  burner address: ${report.burner} (its key never leaves the browser and is never printed)`);

  await shot(widget(page, "w-script"), "05-ready-to-trade");

  // insufficient balance, checked on the funded burner BEFORE the trade — w-script is
  // still on the trade screen here, and after the trade it shows the receipt whose
  // verdict the run needs. No order is signed: the gate is client side, so this costs
  // nothing and reproduces every run.
  {
    const amountInput = page.locator("#w-script .amts input[type='number']").first();
    await amountInput.fill("500");
    await amountInput.dispatchEvent("input");
    const anySide = page.locator("#w-script .side:not([disabled])").first();
    if (await anySide.count()) await anySide.click();
    await page.waitForTimeout(2500);
    const cta = page.locator("#w-script .act .btn").first();
    report.states.insufficient = {
      note: (await page.locator("#w-script .note").allInnerTexts()).join(" | ").replace(/\s+/g, " ").slice(0, 140),
      cta: (await cta.innerText().catch(() => "")).trim(),
      ctaDisabled: await cta.isDisabled().catch(() => null),
    };
    await shot(widget(page, "w-script"), "22-insufficient-balance");
    log(`  insufficient: "${report.states.insufficient.cta}" disabled ${report.states.insufficient.ctaDisabled} — "${report.states.insufficient.note}"`);
    await amountInput.fill("1");
    await amountInput.dispatchEvent("input");
    await page.waitForTimeout(800);
  }

  // ── place ONE $1 trade ───────────────────────────────────────────────────
  // Prefer UP, but a side with no resting quotes is genuinely untradeable — the
  // widget disables it on purpose. Wait for liquidity, then take whichever side
  // the book actually offers.
  // Trade the 5-minute series: same code path, but the window settles inside the
  // run so the resolution and claim screens are exercised for real.
  await page.locator("#w-script .seg button", { hasText: /^5m$/ }).first().click();
  await page.waitForTimeout(4000);
  await shot(widget(page, "w-script"), "05c-5m-series");

  log("waiting for a tradeable side");
  const upBtn = page.locator("#w-script .side[data-side='UP']");
  const downBtn = page.locator("#w-script .side[data-side='DOWN']");
  let sideTaken = null;
  for (let i = 0; i < 120 && sideTaken === null; i++) {
    if (await upBtn.isEnabled().catch(() => false)) sideTaken = "UP";
    else if (await downBtn.isEnabled().catch(() => false)) sideTaken = "DOWN";
    else {
      if (i === 0) {
        await shot(widget(page, "w-script"), "05b-no-liquidity-both-sides");
        log("  both sides empty right now — the widget disabled them; waiting for a quote");
      }
      await page.waitForTimeout(1000);
    }
  }
  if (sideTaken === null) throw new Error("neither side had liquidity within 120 s");
  report.side = sideTaken;
  log(`placing a $1 ${sideTaken} trade`);
  await (sideTaken === "UP" ? upBtn : downBtn).click();
  await page.locator("#w-script .chip", { hasText: "$1" }).first().click();
  await page.waitForTimeout(400);
  await shot(widget(page, "w-script"), "06-quote-selected");

  await btn(page, "w-script", new RegExp(`Review ${sideTaken}`, "i")).click();
  await page.waitForSelector("#w-script .act button", { timeout: 10_000 });
  await shot(widget(page, "w-script"), "07-confirm");

  const pendingShot = page
    .waitForSelector("#w-script .verdict", { timeout: 20_000 })
    .then(() => shot(widget(page, "w-script"), "08-pending"))
    .catch(() => undefined);
  await page.locator("#w-script").getByRole("button", { name: new RegExp(`^Confirm ${sideTaken}`, "i") }).click();
  await pendingShot;

  // receipt shows a transaction link; if it does not, capture why before failing
  await page.waitForSelector("#w-script a[href*='/tx/0x']", { timeout: 150_000 }).catch(async (e) => {
    await shot(widget(page, "w-script"), "09-trade-failed");
    const note = await page.locator("#w-script .note[data-tone='warn']").first().innerText().catch(() => "");
    log(`  trade did not produce a receipt: ${note.trim().slice(0, 200)}`);
    throw e;
  });
  await page.waitForTimeout(600);
  await shot(widget(page, "w-script"), "09-receipt");
  const txHref = await page.locator("#w-script a[href*='/tx/0x']").first().getAttribute("href");
  const txHash = txHref?.match(/0x[0-9a-fA-F]{64}/)?.[0] ?? null;
  log(`  trade tx ${txHash}`);
  report.trade = { txHash, explorer: txHref };

  // ── the API must show it attributed ─────────────────────────────────────
  log("checking attribution through the API");
  const apiKey = readPartnerKey();
  let fill = null;
  for (let i = 0; i < 90 && !fill; i++) {
    const rows = await fetch(`${API}/v1/partners/1/fills?limit=50`, { headers: apiKey ? { "x-api-key": apiKey } : {} })
      .then((r) => (r.ok ? r.json() : []))
      .catch(() => []);
    fill = Array.isArray(rows) ? rows.find((f) => f.txHash?.toLowerCase() === txHash?.toLowerCase()) : null;
    if (!fill) await new Promise((r) => setTimeout(r, 1000));
  }
  report.fill = fill ?? null;
  if (fill) {
    log(`  fill attributed → partner ${fill.takerPartnerId} · surface ${fill.takerSurfaceId} · builder ${fill.takerBuilder} · ${fill.quantity} @ ${fill.price}`);
    const ok = fill.takerPartnerId === 1 && fill.takerSurfaceId === 1 && String(fill.takerBuilder).toLowerCase() === BUILDER.toLowerCase();
    report.attributionOk = ok;
    if (!ok) log("  !! attribution does not match partner 1 / surface web / the builder address");
  } else {
    report.attributionOk = false;
    log("  fill NOT found through /v1/partners/1/fills");
  }

  // ── other states, on separate mounts ────────────────────────────────────
  log("capturing the remaining states");
  await page.locator("#theme").click();
  await page.waitForTimeout(500);
  await shot(page, "10-dark-theme");
  await shot(widget(page, "w-api"), "11-dark-widget");
  await page.locator("#theme").click();
  await page.waitForTimeout(400);

  await shot(widget(page, "w-narrow"), "12-narrow-300px");

  // empty-book / disabled side: the 1-minute test venue routinely has one-sided books
  await page.evaluate(
    ({ venue, api }) => window.__relayRemount("w-api", { venue, intervalSec: 60, asset: "ETH", api }),
    { venue: TEST_VENUE, api: API },
  );
  await page.waitForTimeout(6000);
  // Poll rather than sample once. A 1-minute window spends part of its life Locked,
  // and in Locked BOTH sides are off for a different reason — a single snapshot that
  // happens to land there reports "0 disabled" and proves nothing about an empty book.
  // Wait for the state we actually claim: Trading, with a side off for lack of offers.
  let emptyBook = { disabledSides: 0, note: "", status: "" };
  for (let i = 0; i < 60; i++) {
    // Playwright's CSS engine pierces the shadow root; document.querySelector does not.
    emptyBook = {
      status: (await page.locator("#w-api .pill").first().innerText().catch(() => "")).trim(),
      disabledSides: await page.locator("#w-api .side[disabled]").count(),
      note: (await page.locator("#w-api .note").first().innerText().catch(() => "")).trim().slice(0, 140),
    };
    if (emptyBook.status === "Trading" && emptyBook.disabledSides > 0) break;
    await page.waitForTimeout(2000);
  }
  report.states.emptyBook = emptyBook;
  await shot(widget(page, "w-api"), "13-empty-book-side-disabled");
  log(`  empty-book: status ${emptyBook.status}, ${emptyBook.disabledSides} side(s) disabled — "${emptyBook.note}"`);

  // locked window: 1-minute markets flip to Locked constantly
  const locked = await page
    .locator("#w-api .pill", { hasText: /^Locked$/ })
    .first()
    .waitFor({ state: "visible", timeout: 90_000 })
    .then(() => true)
    .catch(() => false);
  if (locked) await shot(widget(page, "w-api"), "14-locked-window");
  report.states.locked = locked;
  log(`  locked state ${locked ? "captured" : "not seen in 70 s"}`);

  // ── WS blocked → REST fallback ──────────────────────────────────────────
  log("WS blocked → REST fallback");
  const ctx2 = await browser.newContext({ viewport: { width: 460, height: 900 }, deviceScaleFactor: 2 });
  await ctx2.route("**/v1/stream", (route) => route.abort());
  const page2 = await ctx2.newPage();
  await page2.addInitScript(() => {
    // belt and braces: some browsers bypass route() for ws://
    const OrigWS = window.WebSocket;
    window.WebSocket = function () {
      const o = { readyState: 3, close() {}, send() {}, addEventListener() {} };
      setTimeout(() => o.onclose?.(), 10);
      return o;
    };
    window.WebSocket.OPEN = OrigWS.OPEN;
  });
  await page2.goto(PLAYGROUND, { waitUntil: "domcontentloaded" });
  await page2.waitForSelector("#w-script .card", { timeout: 30_000 });
  await page2.waitForTimeout(7000);
  const badge = await page2.locator("#w-script .brand span").first().innerText().catch(() => "");
  const priceText = await page2.locator("#w-script .px").first().innerText().catch(() => "");
  report.states.wsDown = { badge: badge.trim(), price: priceText.replace(/\s+/g, " ").trim() };
  await shot(widget(page2, "w-script"), "15-ws-down-rest-fallback");
  log(`  ws-down badge "${report.states.wsDown.badge}", price still "${report.states.wsDown.price}" (REST poll)`);
  await ctx2.close();

  // ── wait for resolution, then claim ─────────────────────────────────────
  log("waiting for the window to resolve");
  // Two ways the result can surface, and BOTH must be watched. The receipt flips to
  // a verdict, but the card also rolls forward to the next window on its own — and a
  // win then lives in the wallet-scoped claim banner instead. Watching only the
  // verdict made a real winning position look like "resolution not seen".
  const verdictLoc = page.locator("#w-script .verdict", { hasText: /^(WON|LOST|VOIDED)$/ }).first();
  const bannerLoc = page.locator("#w-script").getByRole("button", { name: /^Claim/i }).first();
  const resolved = await Promise.race([
    verdictLoc.waitFor({ state: "visible", timeout: RESOLVE_TIMEOUT_MS }).then(() => "verdict"),
    bannerLoc.waitFor({ state: "visible", timeout: RESOLVE_TIMEOUT_MS }).then(() => "banner"),
  ]).catch(() => false);

  if (resolved) {
    const verdict =
      resolved === "verdict"
        ? (await verdictLoc.innerText()).trim()
        : (await page.locator("#w-script .verdict", { hasText: /^(WON|LOST|VOIDED)$/ }).first().innerText().catch(() => "WON")).trim();
    report.verdict = verdict;
    report.resolvedVia = resolved;
    await shot(widget(page, "w-script"), "16-resolved");
    log(`  verdict: ${verdict} (via the ${resolved})`);
    if (verdict === "WON" || verdict === "VOIDED") {
      const claimBtn = page.locator("#w-script").getByRole("button", { name: /^Claim/i }).first();
      await claimBtn.waitFor({ timeout: 120_000 }).catch(() => undefined);
      await shot(widget(page, "w-script"), "17-claimable-banner");
      await claimBtn.click().catch(() => undefined);
      await page.waitForTimeout(15_000);
      await shot(widget(page, "w-script"), "18-claimed");
      const after = await fetch(`${API}/v1/wallets/${report.burner ?? "0x0"}/claimable`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      report.claim = {
        clicked: true,
        claimableAfter: after?.total ?? null,
        txs: report.onboarding.filter((t) => /redeem|setOperator/i.test(t.step)).map((t) => `${t.step} ${t.hash}`),
      };
      log(`  claim clicked; claimable now ${after?.total ?? "?"} · ${report.claim.txs.join(" · ") || "no redeem tx seen"}`);
    } else {
      await shot(widget(page, "w-script"), "17-lost-worth-zero");
      report.claim = { clicked: false, reason: "held the losing side — position worth 0" };
    }
  } else {
    log("  resolution not seen inside the timeout");
    await shot(widget(page, "w-script"), "16-still-open");
  }

  writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  log("wrote artifacts/phase3/report.json");
  await browser.close();
  console.log("\n=== E2E SUMMARY ===");
  console.log(JSON.stringify(report, null, 2));
}

/** The key POST /v1/partners handed us in Phase 2; it is stored hashed server-side. */
function readPartnerKey() {
  if (process.env.PARTNER_API_KEY) return process.env.PARTNER_API_KEY;
  try {
    return JSON.parse(readFileSync(path.resolve(process.cwd(), "../../artifacts/phase2-partner.json"), "utf8")).partner.apiKey;
  } catch {
    return null;
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    writeFileSync(path.join(OUT, "report.json"), JSON.stringify({ ...report, error: String(e) }, null, 2));
    process.exit(1);
  },
);
