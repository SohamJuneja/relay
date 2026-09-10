// Does any page overflow its column, at any of the widths people actually use?
//
// The regression this exists for: the snippet gained a long data-api attribute, its
// min-content width widened the grid column, and the left column slid under the
// widget — so the third card and the "N fills · $N routed" line were hidden behind it.
//
// Measuring beats looking. For every page, at every width, in both themes: does the
// document scroll horizontally, and does any element stick out past the viewport?

import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const BASE = process.env.CONSOLE_URL ?? "http://127.0.0.1:4180";
const OUT = process.env.SHOT_DIR ?? "E:/blockchain/somnia-relay/artifacts/phase7";
mkdirSync(OUT, { recursive: true });

const WIDTHS = [1280, 1440, 1920];
const THEMES = ["light", "dark"];
const PAGES = [
  ["landing", "/"],
  ["register", "/register"],
  ["try", "/try"],
  ["docs", "/docs/embed"],
  ["dashboard", "/dashboard"],
  ["ecosystem", "/ecosystem"],
];

const log = (...a) => console.log(...a);
const browser = await chromium.launch();
let failures = 0;

for (const theme of THEMES) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: theme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  for (const [name, route] of PAGES) {
    for (const width of WIDTHS) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(`${BASE}${route}`, { waitUntil: "domcontentloaded", timeout: 60_000 });
      // Let the widget paint; an empty card has a different width to a full one.
      await page.waitForTimeout(route === "/" || route === "/try" ? 6000 : 1500);

      const m = await page.evaluate(() => {
        const doc = document.documentElement;
        const overflowing = [];
        for (const el of document.querySelectorAll("body *")) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 && r.height === 0) continue;
          // Past the right edge by more than a rounding error.
          if (r.right > doc.clientWidth + 1) {
            overflowing.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]} right=${Math.round(r.right)}`);
          }
        }
        // Does anything in the first column paint over the second?
        //
        // Comparing the two COLUMNS' rects does not find this: a grid item's rect is
        // its track, and content that cannot shrink overflows the track while the
        // track's own width stays correct. The overlap is between the left column's
        // DESCENDANTS and the right column's box, which is exactly what "the snippet
        // runs underneath the widget" looks like.
        const unders = [];
        for (const split of document.querySelectorAll(".split")) {
          const kids = [...split.children];
          if (kids.length < 2) continue;
          const right = kids[1].getBoundingClientRect();
          if (right.width === 0) continue;
          for (const el of kids[0].querySelectorAll("*")) {
            const r = el.getBoundingClientRect();
            if (r.width === 0 && r.height === 0) continue;
            const verticallyOverlapping = r.top < right.bottom && right.top < r.bottom;
            if (verticallyOverlapping && r.right > right.left + 1) {
              unders.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]} right=${Math.round(r.right)} over column at ${Math.round(right.left)}`);
              if (unders.length >= 3) break;
            }
          }
          if (unders.length >= 3) break;
        }
        // A box whose content is wider than itself, which is the cause rather than
        // the symptom.
        const clipped = [];
        for (const el of document.querySelectorAll("pre, .card, table")) {
          if (el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === "visible") {
            clipped.push(`${el.tagName.toLowerCase()}.${(el.className || "").toString().split(" ")[0]} content=${el.scrollWidth} box=${el.clientWidth}`);
          }
        }
        return {
          scrollW: doc.scrollWidth,
          clientW: doc.clientWidth,
          horizontalScroll: doc.scrollWidth > doc.clientWidth + 1,
          overflowing: overflowing.slice(0, 4),
          unders,
          clipped: clipped.slice(0, 3),
        };
      });

      const bad = m.horizontalScroll || m.overflowing.length > 0 || m.unders.length > 0 || m.clipped.length > 0;
      if (bad) failures++;
      log(
        `${bad ? "FAIL" : "ok  "} ${theme.padEnd(5)} ${String(width).padStart(4)} ${name.padEnd(10)} ` +
          `scroll=${m.scrollW}/${m.clientW}${m.unders.length ? ` · ${m.unders.join("; ")}` : ""}${m.overflowing.length ? ` · overflow: ${m.overflowing.join(", ")}` : ""}${m.clipped.length ? ` · clipped: ${m.clipped.join(", ")}` : ""}`,
      );

      if (width === 1440) {
        await page.screenshot({ path: path.join(OUT, `${name}-${width}-${theme}.png`), fullPage: true });
      }
    }
  }
  await ctx.close();
}

await browser.close();
console.log(`\n${failures === 0 ? "PASS — nothing overflows at any width in either theme" : `FAIL — ${failures} combination(s) overflow`}`);
process.exitCode = failures === 0 ? 0 : 1;
