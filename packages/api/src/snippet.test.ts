// The snippet a partner pastes. Three places must agree on it — the register
// response, the console's copy button and the widget's README — so its exact shape
// is worth pinning: a missing data-partner is silent, and costs the partner every
// fill it brings in.

import { describe, expect, it } from "vitest";
import { assertEmbedScriptUrlConfigured, DEFAULT_SCRIPT_URL, embedScriptUrl, embedSnippet } from "./snippet.js";

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

describe("embedScriptUrl", () => {
  it("builds from CDN_URL, the same value the console gets", () => {
    expect(embedScriptUrl({ CDN_URL: "https://cdn.example-real.test" } as NodeJS.ProcessEnv)).toBe("https://cdn.example-real.test/relay.iife.js");
  });

  it("tolerates a trailing slash rather than doubling it", () => {
    expect(embedScriptUrl({ CDN_URL: "https://cdn.relay.test/" } as NodeJS.ProcessEnv)).toBe("https://cdn.relay.test/relay.iife.js");
  });

  it("lets EMBED_SCRIPT_URL override the conventional path", () => {
    expect(embedScriptUrl({ CDN_URL: "https://cdn.relay.test", EMBED_SCRIPT_URL: "https://x.test/v2/relay.js" } as NodeJS.ProcessEnv)).toBe("https://x.test/v2/relay.js");
  });

  it("falls back to the placeholder when nothing is set", () => {
    expect(embedScriptUrl({} as NodeJS.ProcessEnv)).toBe(DEFAULT_SCRIPT_URL);
  });
});

describe("assertEmbedScriptUrlConfigured", () => {
  it("refuses a production start with no CDN_URL", () => {
    expect(() => assertEmbedScriptUrlConfigured({ NODE_ENV: "production" } as NodeJS.ProcessEnv)).toThrow(/CDN_URL is not configured/);
  });

  it("refuses a production start pointing at an example hostname", () => {
    // This is the exact value that shipped: it resolves to nothing, and every partner
    // who copied it got ERR_NAME_NOT_RESOLVED on their own site.
    expect(() => assertEmbedScriptUrlConfigured({ NODE_ENV: "production", CDN_URL: "https://cdn.relay.example" } as NodeJS.ProcessEnv)).toThrow(/does not resolve|not configured/);
    expect(() => assertEmbedScriptUrlConfigured({ NODE_ENV: "production", EMBED_SCRIPT_URL: "https://cdn.example.com/relay.iife.js" } as NodeJS.ProcessEnv)).toThrow();
  });

  it("accepts a real origin", () => {
    expect(() =>
      assertEmbedScriptUrlConfigured({ NODE_ENV: "production", CDN_URL: "https://relay-cdn-sohamjunejas-projects.vercel.app" } as NodeJS.ProcessEnv),
    ).not.toThrow();
  });

  it("stays out of the way in development, where a placeholder is fine", () => {
    expect(() => assertEmbedScriptUrlConfigured({} as NodeJS.ProcessEnv)).not.toThrow();
    expect(() => assertEmbedScriptUrlConfigured({ NODE_ENV: "test" } as NodeJS.ProcessEnv)).not.toThrow();
  });
});
