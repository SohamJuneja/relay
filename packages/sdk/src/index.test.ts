// What an agent's order carries, and what the SDK refuses to guess.
//
// The whole point of the package is that a bot's flow is attributable to its operator,
// so the tag is the thing worth pinning: partner id, and surface=agent so agent flow is
// separable from a publisher's page.

import { afterEach, describe, expect, it, vi } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { decodeUserData, encodeUserData, SURFACE } from "@relay/core";
import { createRelay } from "./index.js";

const KEY = generatePrivateKey();
const ACCOUNT = privateKeyToAccount(KEY);
const BUILDER = "0x00000000000000000000000000000000000000bb" as const;

const make = (over: Partial<Parameters<typeof createRelay>[0]> = {}) =>
  createRelay({
    rpcUrl: "https://rpc.invalid",
    privateKey: KEY,
    apiUrl: "https://api.invalid/",
    partnerId: 14,
    builder: BUILDER,
    ...over,
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createRelay", () => {
  it("derives its address from the key and never needs it sent anywhere", () => {
    const relay = make();
    expect(relay.address).toBe(ACCOUNT.address);
    expect(relay.partnerId).toBe(14);
    expect(relay.builder).toBe(BUILDER);
  });

  it("defaults the builder to the zero address rather than inventing one", () => {
    // Built directly: under exactOptionalPropertyTypes, "absent" and "present and
    // undefined" are different types, and absent is the case that matters here.
    const relay = createRelay({ rpcUrl: "https://rpc.invalid", privateKey: KEY, apiUrl: "https://api.invalid", partnerId: 14 });
    expect(relay.builder).toBe("0x0000000000000000000000000000000000000000");
  });

  it("trims a trailing slash off the API base so paths do not double up", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      seen.push(String(u));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    });
    await make().markets.live({ asset: "btc", intervalSec: 300 });
    expect(seen[0]).toContain("https://api.invalid/v1/markets/live?");
    expect(seen[0]).not.toContain("//v1/");
  });

  it("upper-cases the asset and asks for books on live markets", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (u: string) => {
      seen.push(String(u));
      return new Response("[]", { status: 200, headers: { "content-type": "application/json" } });
    });
    await make().markets.live({ asset: "btc", intervalSec: 300 });
    expect(seen[0]).toContain("asset=BTC");
    expect(seen[0]).toContain("intervalSec=300");
    expect(seen[0]).toContain("book=true");
  });

  it("refuses to guess a market when given neither an id nor a series", async () => {
    await expect(make().buy({ side: "UP", budget: 1 } as never)).rejects.toThrow(/marketId or both asset and intervalSec/);
  });

  it("says which series had nothing trading rather than failing vaguely", async () => {
    vi.stubGlobal("fetch", async () => new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    await expect(make().buy({ asset: "BTC", intervalSec: 300, side: "UP", budget: 1 })).rejects.toThrow(/no live BTC 300s window/);
  });

  it("will not take a window about to close", async () => {
    // An IOC racing the close is a wasted transaction, not a fast one.
    const closing = [{ marketId: "0x01", asset: "BTC", intervalSec: 300, status: 1, secondsToExpiry: 4, expiry: 0, question: "", openingPriceRaw: null }];
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify(closing), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(make().buy({ asset: "BTC", intervalSec: 300, side: "UP", budget: 1 })).rejects.toThrow(/no live BTC 300s window/);
  });

  it("surfaces an API failure with its status instead of returning empty data", async () => {
    vi.stubGlobal("fetch", async () => new Response("nope", { status: 503 }));
    await expect(make().markets.live()).rejects.toThrow(/503/);
  });
});

describe("the tag every agent order carries", () => {
  it("encodes the operator's partner id and surface=agent", () => {
    const tag = encodeUserData({ partnerId: 14, surfaceId: SURFACE.AGENT });
    const d = decodeUserData(tag);
    expect(d.tagged).toBe(true);
    expect(d.partnerId).toBe(14);
    expect(d.surfaceId).toBe(SURFACE.AGENT);
  });

  it("is distinguishable from web and telegram flow", () => {
    const agent = decodeUserData(encodeUserData({ partnerId: 14, surfaceId: SURFACE.AGENT }));
    const web = decodeUserData(encodeUserData({ partnerId: 14, surfaceId: SURFACE.WEB }));
    const tg = decodeUserData(encodeUserData({ partnerId: 14, surfaceId: SURFACE.TELEGRAM }));
    // Same partner, three surfaces — one operator, not three partners.
    expect(new Set([agent.surfaceId, web.surfaceId, tg.surfaceId]).size).toBe(3);
    expect([agent.partnerId, web.partnerId, tg.partnerId]).toEqual([14, 14, 14]);
  });

  it("gives agent a stable id, so old fills keep meaning what they meant", () => {
    expect(SURFACE.AGENT).toBe(7);
  });
});

describe("configuration errors name the field", () => {
  // An unset env var used to surface as "Cannot read properties of undefined
  // (reading 'replace')" from inside a helper, which says nothing about what to fix.
  it("names a missing apiUrl", () => {
    expect(() => createRelay({ rpcUrl: "https://rpc.invalid", privateKey: KEY, apiUrl: undefined as never, partnerId: 1 })).toThrow(/apiUrl is required/);
  });

  it("names a missing rpcUrl", () => {
    expect(() => createRelay({ rpcUrl: "" as never, privateKey: KEY, apiUrl: "https://api.invalid", partnerId: 1 })).toThrow(/rpcUrl is required/);
  });

  it("rejects a partnerId that is not a positive integer, and says where to get one", () => {
    expect(() => createRelay({ rpcUrl: "https://rpc.invalid", privateKey: KEY, apiUrl: "https://api.invalid", partnerId: NaN })).toThrow(/partnerId must be a positive integer/);
    expect(() => createRelay({ rpcUrl: "https://rpc.invalid", privateKey: KEY, apiUrl: "https://api.invalid", partnerId: 0 })).toThrow(/POST \/v1\/partners/);
  });
});
