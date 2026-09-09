// Proves @relay/core/browser is genuinely browser-safe: esbuild bundles it for
// platform=browser (which fails on any `node:` import) and the emitted bundle
// contains no Node globals. This is the guard that keeps the widget buildable.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { describe, expect, it } from "vitest";

// Each case runs a real esbuild bundle. Alone that is ~500 ms; under `pnpm -r test`,
// with six other packages compiling at once, it has been seen to take 11 s. The
// default 5 s timeout made this the one flaky test in the suite.
const BUNDLE_TIMEOUT_MS = 60_000;

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function bundle(entry: string) {
  const res = await build({
    entryPoints: [path.join(HERE, entry)],
    bundle: true,
    platform: "browser",
    format: "esm",
    target: "es2022",
    write: false,
    logLevel: "silent",
    // viem is a peer the widget provides; bundling it here would only slow the test
    external: ["viem", "viem/*"],
  });
  return res.outputFiles[0]!.text;
}

describe("@relay/core/browser", () => {
  it("bundles for the browser with no node: imports", async () => {
    const code = await bundle("browser.ts");
    expect(code.length).toBeGreaterThan(1000);
    expect(code).not.toMatch(/require\(["']node:/);
    expect(code).not.toMatch(/from\s*["']node:/);
    for (const forbidden of ["process.env", "__dirname", "__filename", '"fs"', "'fs'", "dotenv"]) {
      expect(code, `bundle must not reference ${forbidden}`).not.toContain(forbidden);
    }
  }, 60_000);

  it("exports the widget's surface", async () => {
    const mod = await import("./browser.js");
    for (const name of [
      "ADDRESSES",
      "CHAIN_IDS",
      "relayChain",
      "encodeUserData",
      "decodeUserData",
      "SURFACE",
      "buildTakerOrder",
      "buildPlaceOrderCall",
      "buildApproveCall",
      "buildFaucetCall",
      "buildSetOperatorCall",
      "buildRedeemCall",
      "buildRedeemManyCall",
      "supportsRedeemMany",
      "binaryPoolReadAbi",
      "binaryPoolWriteAbi",
      "binaryModuleWriteAbi",
      "erc20Abi",
      "outcomeToken6909Abi",
      "priceToProbability",
      "probabilityToPrice",
      "snapDown",
      "explainRevert",
      "MarketStatus",
      "toFourSided",
      "summarizeYes",
    ]) {
      expect(mod, `missing export ${name}`).toHaveProperty(name);
    }
  }, BUNDLE_TIMEOUT_MS);

  it("the NODE entry is the one that may use node built-ins", async () => {
    // sanity: the Node entry still exports the signer paths the scripts use
    const mod = await import("./index.js");
    expect(mod).toHaveProperty("placeTakerBuy");
    expect(mod).toHaveProperty("waitForResolution");
    expect(mod).toHaveProperty("scanLogs");
  }, BUNDLE_TIMEOUT_MS);
});
