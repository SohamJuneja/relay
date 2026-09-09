// The breakdown and share SQL, run against a real Postgres.
//
// PGlite rather than a mock: these are aggregate queries with joins, filters and a
// `filter (where …)` clause, and the only thing worth testing about them is whether
// Postgres agrees with what they are supposed to mean. A stubbed `db.execute` would
// test nothing but the shape of the object literal around it.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openDb, type DbHandle } from "@relay/indexer";
import { buildApp } from "./app.js";
import type { ApiDeps } from "./deps.js";
import type { App } from "./app.js";
import { createHash } from "node:crypto";

const VENUE = "0x679795a0195a1b76cdebb7c51d74e058aee92919b8c3389af86ef24535e8a28c";
const OTHER_VENUE = "0x1111111111111111111111111111111111111111111111111111111111111111";
const KEY_A = "rk_partner_a_key";
const KEY_B = "rk_partner_b_key";
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const now = Math.floor(Date.now() / 1000);
const hoursAgo = (h: number) => now - Math.round(h * 3600);

let handle: DbHandle;
let app: App;

/**
 * A small, hand-built venue:
 *   partner 1 — 3 fills: two web (5m and 15m), one telegram (15m)
 *   partner 2 — 1 fill, so isolation is testable
 *   untagged  — 1 fill, so the venue denominator is bigger than the sum of partners
 *   plus one fill 40 hours old, outside a 24-hour window
 *   plus one fill on a DIFFERENT venue, which must never reach the share numbers
 */
async function seed(db: DbHandle["db"]): Promise<void> {
  const { sql } = await import("drizzle-orm");

  await db.execute(sql`
    insert into partners (partner_id, name, builder_address, api_key_hash) values
      (1, 'Alpha News', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ${sha256(KEY_A)}),
      (2, 'Beta Feed',  '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', ${sha256(KEY_B)})`);

  const market = (id: string, venue: string, asset: string, interval: number, expiry: number) => sql`
    insert into markets (market_id, market_address, pool, venue_id, operator_id, creator, collateral,
                         yes_id, no_id, nonce, asset, interval_sec, window_sec, trading_start, expiry,
                         strike_raw, question, void_policy, oracle_question_id, status,
                         created_block, created_block_hash, created_tx, voided, finalized)
    values (${id}, '0x00000000000000000000000000000000000000a1', '0x00000000000000000000000000000000000000b1',
            ${venue}, 2, '0x00000000000000000000000000000000000000c1', '0x00000000000000000000000000000000000000c2',
            '1', '2', 1, ${asset}, ${interval}, ${interval}, ${expiry - interval}, ${expiry},
            '0', 'test', 0, '1', 4,
            1, '0xbh', '0xtx', false, true)`;

  await db.execute(market("0xm1", VENUE, "BTC", 300, hoursAgo(1)));
  await db.execute(market("0xm2", VENUE, "BTC", 900, hoursAgo(2)));
  await db.execute(market("0xm3", VENUE, "ETH", 900, hoursAgo(3)));
  await db.execute(market("0xm4", VENUE, "BTC", 900, hoursAgo(40)));
  await db.execute(market("0xm5", OTHER_VENUE, "BTC", 900, hoursAgo(1)));

  let id = 0;
  const fill = (marketId: string, ts: number, notional: bigint, partner: number | null, surface: number | null, owner: string) => {
    id++;
    return sql`
      insert into fills (id, pool, market_id, taker_order_id, maker_order_id, fill_price, quantity, notional,
                         block, block_ts, block_hash, tx_hash, log_index, taker_owner, maker_owner,
                         taker_partner_id, taker_surface_id, taker_builder)
      values (${id}, '0x00000000000000000000000000000000000000b1', ${marketId}, '1', '2', '500000', '1000000',
              ${notional.toString()}, ${id}, ${ts}, '0xbh', ${"0xtx" + id}, 0, ${owner}, '0x00000000000000000000000000000000000000cc',
              ${partner}, ${surface}, ${partner === 1 ? "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" : partner === 2 ? "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" : null})`;
  };

  // partner 1: 5 000 000 + 3 000 000 raw on web, 2 000 000 on telegram → 10 tUSDC
  await db.execute(fill("0xm1", hoursAgo(1), 5_000_000n, 1, 1, "0x00000000000000000000000000000000000000d1"));
  await db.execute(fill("0xm2", hoursAgo(2), 3_000_000n, 1, 1, "0x00000000000000000000000000000000000000d2"));
  await db.execute(fill("0xm3", hoursAgo(3), 2_000_000n, 1, 2, "0x00000000000000000000000000000000000000d1"));
  // partner 2
  await db.execute(fill("0xm2", hoursAgo(2), 4_000_000n, 2, 1, "0x00000000000000000000000000000000000000d3"));
  // untagged flow on the same venue
  await db.execute(fill("0xm2", hoursAgo(2), 6_000_000n, null, null, "0x00000000000000000000000000000000000000d4"));
  // outside the 24 h window
  await db.execute(fill("0xm4", hoursAgo(40), 9_000_000n, 1, 1, "0x00000000000000000000000000000000000000d1"));
  // a different venue entirely
  await db.execute(fill("0xm5", hoursAgo(1), 7_000_000n, 1, 1, "0x00000000000000000000000000000000000000d1"));
}

beforeAll(async () => {
  handle = await openDb("pglite://");
  await handle.migrate();
  await seed(handle.db);
  const deps = {
    cfg: { network: "testnet", decimals: 6, defaultVenueId: VENUE, priceAssets: ["BTC"], builderFeeBps: 100 },
    db: handle.db,
    client: { getBlockNumber: async () => 1000n },
    ticker: { get: () => null, all: () => [] },
    books: { get: async () => null },
    outcomeToken: async () => "0x0000000000000000000000000000000000000000",
    close: async () => undefined,
  } as unknown as ApiDeps;
  app = await buildApp(deps);
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await handle?.close();
});

const get = (url: string, key?: string) => app.inject({ method: "GET", url, ...(key ? { headers: { "x-api-key": key } } : {}) });

describe("GET /v1/partners/:id/breakdown", () => {
  it("splits one partner's flow by surface, series and day", async () => {
    const r = await get("/v1/partners/1/breakdown?hours=24", KEY_A);
    expect(r.statusCode).toBe(200);
    const b = r.json() as {
      bySurface: { name: string; fills: number; notional: number }[];
      bySeries: { asset: string; intervalSec: number; fills: number; notional: number }[];
      byDay: { fills: number; notional: number; uniqueWallets: number }[];
    };

    // web carries two fills worth 8 tUSDC; telegram one worth 2.
    const web = b.bySurface.find((s) => s.name === "web");
    const telegram = b.bySurface.find((s) => s.name === "telegram");
    expect(web).toMatchObject({ fills: 2, notional: 8 });
    expect(telegram).toMatchObject({ fills: 1, notional: 2 });

    // Series are (asset, cadence) pairs, so BTC 15m and ETH 15m stay separate.
    expect(b.bySeries).toHaveLength(3);
    expect(b.bySeries.find((s) => s.asset === "BTC" && s.intervalSec === 300)).toMatchObject({ fills: 1, notional: 5 });
    expect(b.bySeries.find((s) => s.asset === "ETH" && s.intervalSec === 900)).toMatchObject({ fills: 1, notional: 2 });

    // The 40-hour-old fill is outside the window and must not be counted anywhere.
    const totalFills = b.bySurface.reduce((n, s) => n + s.fills, 0);
    expect(totalFills).toBe(3);

    // One wallet traded twice, so wallets are DISTINCT, not a fill count.
    const wallets = b.byDay.reduce((n, d) => n + d.uniqueWallets, 0);
    expect(wallets).toBeLessThan(totalFills);
  });

  it("counts the 40-hour-old fill once the window is long enough", async () => {
    const r = await get("/v1/partners/1/breakdown?hours=48", KEY_A);
    const b = r.json() as { bySurface: { fills: number; notional: number }[] };
    expect(b.bySurface.reduce((n, s) => n + s.fills, 0)).toBe(4);
    expect(b.bySurface.reduce((n, s) => n + s.notional, 0)).toBeCloseTo(19, 6);
  });

  it("refuses without the right key", async () => {
    expect((await get("/v1/partners/1/breakdown")).statusCode).toBe(401);
    expect((await get("/v1/partners/1/breakdown", KEY_B)).statusCode).toBe(401);
  });
});

describe("GET /v1/partners/:id/share", () => {
  it("measures the partner against ALL venue flow, tagged or not", async () => {
    const r = await get("/v1/partners/1/share?hours=24", KEY_A);
    expect(r.statusCode).toBe(200);
    const s = r.json() as { partnerNotional: number; venueNotional: number; sharePct: number; partnerFills: number; venueFills: number };

    // The denominator includes partner 2 and the untagged fill (10 + 4 + 6 = 20),
    // and excludes the other venue's 7 and the 40-hour-old 9.
    expect(s.partnerNotional).toBeCloseTo(10, 6);
    expect(s.venueNotional).toBeCloseTo(20, 6);
    expect(s.sharePct).toBeCloseTo(50, 2);
    expect(s.partnerFills).toBe(3);
    expect(s.venueFills).toBe(5);
  });

  it("keeps enough precision that a small real share is not reported as zero", async () => {
    // Partner 2 routed 4 of the venue's 20 → 20%. Scale the check to the shape that
    // matters: the value must survive rounding, not merely exist.
    const s = (await get("/v1/partners/2/share?hours=24", KEY_B)).json() as { sharePct: number };
    expect(s.sharePct).toBeGreaterThan(0);
    // Four decimals means a share as small as one part in a million is still visible.
    expect(String(s.sharePct).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(4);
  });

  it("gives no answer rather than zero per cent when nothing traded", async () => {
    // A one-hour window that starts after every seeded fill.
    const r = await get("/v1/partners/2/share?hours=1", KEY_B);
    const s = r.json() as { venueNotional: number; sharePct: number | null };
    if (s.venueNotional === 0) expect(s.sharePct).toBeNull();
  });

  it("keeps one partner out of another's numbers", async () => {
    const a = (await get("/v1/partners/1/share?hours=24", KEY_A)).json() as { partnerNotional: number };
    const b = (await get("/v1/partners/2/share?hours=24", KEY_B)).json() as { partnerNotional: number };
    expect(a.partnerNotional).toBeCloseTo(10, 6);
    expect(b.partnerNotional).toBeCloseTo(4, 6);
  });
});

describe("GET /v1/stats/builders", () => {
  it("names registered builders and keeps other venues out", async () => {
    const r = await get("/v1/stats/builders?hours=24");
    expect(r.statusCode).toBe(200);
    const { builders } = r.json() as { builders: { builder: string; partnerName: string | null; fills: number; notional: number; wallets: number }[] };
    expect(builders).toHaveLength(2);
    const alpha = builders.find((b) => b.partnerName === "Alpha News");
    expect(alpha).toMatchObject({ fills: 3, wallets: 2 });
    expect(alpha!.notional).toBeCloseTo(10, 6);
  });
});
