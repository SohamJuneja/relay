// Boots the app with stub dependencies and checks the OpenAPI 3.1 document and
// validation without a database.

import { describe, expect, it } from "vitest";
import { buildApp } from "./app.js";
import type { ApiDeps } from "./deps.js";

const stub = {
  cfg: { network: "testnet", decimals: 6, defaultVenueId: "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c", priceAssets: ["BTC", "ETH"], builderFeeBps: 100 },
  db: { execute: async () => [], select: () => ({ from: () => ({ where: () => ({ limit: async () => [], orderBy: () => ({ limit: async () => [] }) }), limit: async () => [] }) }) },
  client: { getBlockNumber: async () => 123n },
  ticker: { get: () => null, all: () => [] },
  books: { get: async () => null },
  outcomeToken: async () => "0x0000000000000000000000000000000000000000",
  close: async () => undefined,
} as unknown as ApiDeps;

describe("api app", () => {
  it("serves an OpenAPI 3.1 document with every public route", async () => {
    const app = await buildApp(stub);
    await app.ready();
    const doc = app.swagger() as { openapi: string; paths: Record<string, unknown> };
    expect(doc.openapi).toBe("3.1.0");
    for (const p of [
      "/health",
      "/v1/venues",
      "/v1/markets/live",
      "/v1/markets/recent",
      "/v1/markets/{marketId}",
      "/v1/markets/{marketId}/book",
      "/v1/markets/{marketId}/fills",
      "/v1/price/{asset}",
      "/v1/stats/venue/{venueId}",
      "/v1/partners",
      "/v1/partners/{partnerId}/public",
      "/v1/partners/{partnerId}/stats",
      "/v1/partners/{partnerId}/fills",
      "/v1/orders/{orderId}",
      "/v1/wallets/{address}/positions",
    ]) {
      expect(doc.paths[p], p).toBeDefined();
    }
    const ui = await app.inject({ method: "GET", url: "/docs/json" });
    expect(ui.statusCode).toBe(200);
    await app.close();
  });

  it("rejects malformed params with a 400 and no DB access", async () => {
    const app = await buildApp(stub);
    const r = await app.inject({ method: "GET", url: "/v1/markets/not-a-market-id" });
    expect(r.statusCode).toBe(400);
    const r2 = await app.inject({ method: "POST", url: "/v1/partners", payload: { name: "x", builderAddress: "nope" } });
    expect(r2.statusCode).toBe(400);
    const r3 = await app.inject({ method: "GET", url: "/v1/price/BTC" });
    expect(r3.statusCode).toBe(404);
    await app.close();
  });
});
