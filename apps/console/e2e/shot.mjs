// Screenshot helpers that wait for DATA, not for a timeout.
//
// Every skeleton in this console is a real element with a class, so "the page has
// loaded" is a question with an answer: no `.skel` on screen, the partner's name in
// the heading instead of "Partner 3", and the tables rendered. Sleeping for two
// seconds and hoping was producing screenshots of loading states, which is the one
// thing a screenshot must never show.

/** No skeletons anywhere, and at least one real value painted. */
export async function waitForData(page, opts = {}) {
  const timeout = opts.timeout ?? 60_000;
  const deadline = Date.now() + timeout;

  // 1. every skeleton gone
  await page.waitForFunction(() => document.querySelectorAll(".skel").length === 0, undefined, { timeout });

  // 2. the specific thing this page is about, when the caller names it
  if (opts.heading) {
    await page.getByRole("heading", { name: opts.heading }).waitFor({ timeout: Math.max(1000, deadline - Date.now()) });
  }
  if (opts.testId) {
    await page.getByTestId(opts.testId).waitFor({ timeout: Math.max(1000, deadline - Date.now()) });
  }
  if (opts.rowsIn) {
    await page.locator(`${opts.rowsIn} tbody tr`).first().waitFor({ timeout: Math.max(1000, deadline - Date.now()) });
  }

  // 3. no KPI still showing a placeholder dash where a number belongs
  if (opts.kpisFilled !== false) {
    await page
      .waitForFunction(
        () => {
          const dds = [...document.querySelectorAll(".kpi dd")];
          return dds.length === 0 || dds.every((d) => (d.textContent ?? "").trim() !== "" && (d.textContent ?? "").trim() !== "—");
        },
        undefined,
        { timeout: Math.max(1000, deadline - Date.now()) },
      )
      .catch(() => undefined); // a genuinely empty account has legitimate dashes
  }

  // 4. charts draw to canvas after their container measures; one frame is enough
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  // 5. fonts, or the first paint measures at fallback metrics and reflows
  await page.evaluate(() => document.fonts?.ready).catch(() => undefined);
}

/** A full-page screenshot taken only once the page has real data on it. */
export async function shotWhenReady(page, file, opts = {}) {
  await waitForData(page, opts);
  await page.screenshot({ path: file, fullPage: opts.fullPage !== false });
  return file;
}
