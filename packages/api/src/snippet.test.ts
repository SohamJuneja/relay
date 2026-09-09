// The snippet a partner pastes. Three places must agree on it — the register
// response, the console's copy button and the widget's README — so its exact shape
// is worth pinning: a missing data-partner is silent, and costs the partner every
// fill it brings in.

import { describe, expect, it } from "vitest";
import { DEFAULT_SCRIPT_URL, embedSnippet } from "./snippet.js";

const BUILDER = "0xb5eCf004491aa8589a82af91633D18867fcFF038";

describe("embedSnippet", () => {
  it("is two lines: the script, and the mount point", () => {
    const s = embedSnippet({ partnerId: 2, builderAddress: BUILDER });
    const lines = s.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe(`<script src="${DEFAULT_SCRIPT_URL}"></script>`);
    expect(lines[1]).toBe(`<div data-relay-market data-partner="2" data-builder="${BUILDER}"></div>`);
  });

  it("always carries the two attributes that decide who gets paid", () => {
    const s = embedSnippet({ partnerId: 7, builderAddress: BUILDER });
    expect(s).toContain('data-partner="7"');
    expect(s).toContain(`data-builder="${BUILDER}"`);
    expect(s).toContain("data-relay-market");
  });

  it("preserves the builder address exactly, checksum casing and all", () => {
    // Lowercasing an address is harmless on chain but makes the snippet look
    // different from what the partner pasted, which reads like a bug.
    expect(embedSnippet({ partnerId: 1, builderAddress: BUILDER })).toContain(BUILDER);
  });

  it("omits every attribute left at its default", () => {
    const s = embedSnippet({ partnerId: 1, builderAddress: BUILDER });
    expect(s).not.toContain("data-asset");
    expect(s).not.toContain("data-interval");
    expect(s).not.toContain("data-surface");
    expect(s).not.toContain("data-api");
  });

  it("adds only what was asked for, in scan order", () => {
    const s = embedSnippet({ partnerId: 3, builderAddress: BUILDER, asset: "ETH", intervalSec: 300, surface: "telegram", api: "https://api.example.com" });
    expect(s).toContain('data-asset="ETH"');
    expect(s).toContain('data-interval="300"');
    expect(s).toContain('data-surface="telegram"');
    expect(s).toContain('data-api="https://api.example.com"');
    // partner and builder come first, before the optional shape attributes
    expect(s.indexOf("data-partner")).toBeLessThan(s.indexOf("data-asset"));
    expect(s.indexOf("data-builder")).toBeLessThan(s.indexOf("data-asset"));
  });

  it("points the script tag wherever the deployment serves the bundle", () => {
    const s = embedSnippet({ partnerId: 1, builderAddress: BUILDER, scriptUrl: "https://cdn.example.org/relay.iife.js" });
    expect(s).toContain('<script src="https://cdn.example.org/relay.iife.js"></script>');
    expect(s).not.toContain(DEFAULT_SCRIPT_URL);
  });
});
