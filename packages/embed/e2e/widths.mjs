// Part A checks that only need a browser and a ruler: the countdown must never wrap
// at any width, nothing may overflow, and the question line must not carry a numeric
// timezone offset.
//
//   node e2e/widths.mjs

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const PLAYGROUND = process.env.PLAYGROUND ?? "http://127.0.0.1:5178/dev/index.html";
const OUT = path.resolve(process.cwd(), "../../artifacts/phase5");
mkdirSync(OUT, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 1400, height: 1200 }, deviceScaleFactor: 2 })).newPage();
await page.goto(PLAYGROUND, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#w-script .card", { timeout: 30_000 });
await page.waitForTimeout(4500);

const report = { widths: {}, question: null, shots: [] };

for (const [id, label] of [
  ["w-script", "380"],
  ["w-360", "360"],
  ["w-340", "340"],
  ["w-320", "320"],
  ["w-narrow", "300"],
]) {
  const card = page.locator(`#${id} .card`);
  if ((await card.count()) === 0) continue;
  const m = await card.evaluate((el) => {
    const clock = el.querySelector(".clock");
    const pill = el.querySelector(".pill");
    const cs = clock ? getComputedStyle(clock) : null;
    const r = clock?.getBoundingClientRect();
    // One line high means one line: a wrapped "14:05 left" is two line-boxes tall.
    const lineHeight = cs ? parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.2 : 0;
    const overflowing = [];
    for (const n of el.querySelectorAll("*")) {
      if (n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX === "visible") overflowing.push(n.className || n.tagName);
    }
    return {
      cardWidth: Math.round(el.clientWidth),
      clockText: clock?.textContent?.trim() ?? null,
      clockWhiteSpace: cs?.whiteSpace ?? null,
      clockHeight: r ? Math.round(r.height) : null,
      clockWrapped: r && lineHeight ? r.height > lineHeight * 1.6 : null,
      pillWidth: pill ? Math.round(pill.getBoundingClientRect().width) : null,
      pillIsDot: pill ? getComputedStyle(pill).fontSize === "0px" : null,
      cardOverflows: el.scrollWidth > el.clientWidth + 1,
      overflowing: overflowing.slice(0, 5),
    };
  });
  report.widths[label] = m;
  log(`${label}px → card ${m.cardWidth}, clock "${m.clockText}" wrapped=${m.clockWrapped}, pill ${m.pillIsDot ? "dot" : `${m.pillWidth}px`}, overflow=${m.cardOverflows} ${m.overflowing.join(",")}`);
  await card.screenshot({ path: path.join(OUT, `A1-width-${label}.png`) });
  report.shots.push(`artifacts/phase5/A1-width-${label}.png`);
}

const q = await page.locator("#w-script .q").first().innerText().catch(() => "");
const title = await page.locator("#w-script .q").first().getAttribute("title").catch(() => "");
report.question = { text: q.trim(), title };
// "GMT+5:30" is the thing this check exists to prevent.
report.questionHasNumericOffset = /GMT[+-]|UTC[+-]\d/.test(q);
log(`question "${q.trim()}" | title "${title}" | numeric offset: ${report.questionHasNumericOffset}`);

writeFileSync(path.join(OUT, "partA.json"), JSON.stringify(report, null, 2));
log("wrote artifacts/phase5/partA.json");
await browser.close();
