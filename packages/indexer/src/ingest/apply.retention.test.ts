// Orders older than retention must not be written at all.
//
// This is the bug that took the deployed indexer down. Retention keeps orders for a
// few hours, but the backfill wrote every order in its whole window — a 24-hour
// catch-up meant ~800k rows and ~500 MB — and the first prune after the backfill
// finished deleted almost all of them. The database ran out of storage before the
// backfill ever reached the tail loop, and every write after that failed.
//
// The two things that must both hold: the old rows are not written, and the
// quoted-both-sides latch still fires for them, because that latch is what the
// zero-fill and quoted-but-untaken statistics read.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Address, Hex } from "viem";
import { openDb, type Db } from "../db/client.js";
import { applyPlan, type ChunkMeta } from "./apply.js";
import type { ChunkPlan, OrderRow } from "./plan.js";

const POOL = "0x00000000000000000000000000000000000000aa" as Address;
const OWNER = "0x00000000000000000000000000000000000000bb" as Address;
const MARKET = "0x00000000000000000000000000000000000000000000000000000000000000c1" as Hex;
const HASH = "0x1111111111111111111111111111111111111111111111111111111111111111" as Hex;

// The chunk spans one hour of blocks, so block→timestamp interpolation puts the
// first block an hour before the last.
const FROM_BLOCK = 1_000_000n;
const TO_BLOCK = 1_036_000n;
const NOW = 1_800_000_000n;
const FROM_TS = NOW - 3600n;

let dir: string;
let db: Db;
let close: () => Promise<void>;

const order = (id: bigint, block: bigint, over: Partial<OrderRow> = {}): OrderRow => ({
  key: `${POOL}:${id}`,
  pool: POOL,
  orderId: id,
  marketId: MARKET,
  owner: OWNER,
  isBid: true,
  kind: 0,
  price: 500_000n,
  quantity: 1_000_000n,
  userData: 0n,
  tagVersion: 1,
  partnerId: null,
  surfaceId: null,
  builder: null,
  expireNs: 0n,
  placedBlock: block,
  blockHash: HASH,
  txHash: `0x${id.toString(16).padStart(64, "0")}` as Hex,
  logIndex: Number(id),
  restedQty: 1_000_000n,
  filledQty: 0n,
  cancelled: false,
  expired: false,
  ...over,
});

const emptyPlan = (): ChunkPlan => ({
  markets: [],
  references: [],
  resolved: [],
  finalized: [],
  epochsOpened: [],
  epochsClosed: [],
  orders: [],
  orderUpdates: [],
  fills: [],
  builderFees: [],
  protocolFees: [],
  redemptions: [],
  raw: [],
  blockHashes: new Map(),
  unknownPoolLogs: 0,
});

const meta = (over: Partial<ChunkMeta> = {}): ChunkMeta => ({
  network: "testnet",
  from: FROM_BLOCK,
  to: TO_BLOCK,
  toHash: HASH,
  toParentHash: HASH,
  toTs: NOW,
  fromTs: FROM_TS,
  advanceCursor: false,
  startBlock: FROM_BLOCK,
  ...over,
});

const countOrders = async (): Promise<number> => {
  const r = (await db.execute(sql`select count(*)::int as n from orders`)) as unknown;
  const rows = (Array.isArray(r) ? r : ((r as { rows?: { n: number }[] }).rows ?? [])) as { n: number }[];
  return rows[0]?.n ?? 0;
};

/**
 * The latch is an UPDATE on an existing market, so one has to be there to latch. Only
 * the not-null columns matter here; nothing in this test reads the rest.
 */
const insertMarket = async (): Promise<void> => {
  await db.execute(sql`
    insert into markets (
      market_id, market_address, pool, venue_id, operator_id, creator, collateral,
      yes_id, no_id, nonce, asset, interval_sec, window_sec, trading_start, expiry,
      strike_raw, question, void_policy, oracle_question_id,
      created_block, created_block_hash, created_tx
    ) values (
      ${MARKET.toLowerCase()}, ${POOL}, ${POOL}, '0xvenue', 1, ${OWNER}, ${OWNER},
      1, 2, 1, 'BTC', 900, 900, ${Number(FROM_TS)}, ${Number(NOW)},
      0, 'will it', 0, 7,
      ${Number(FROM_BLOCK)}, ${HASH}, ${HASH}
    )
    on conflict (market_id) do nothing`);
};

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "relay-retention-"));
  const h = await openDb(`pglite://${dir}`);
  await h.migrate();
  db = h.db;
  close = h.close;
}, 120_000);

afterAll(async () => {
  await close?.();
  rmSync(dir, { recursive: true, force: true });
});

describe("orderMinTs", () => {
  it("writes only the orders retention would keep, and latches both sides regardless", async () => {
    await insertMarket();
    const plan = emptyPlan();
    // Placed at the start of the chunk — an hour old.
    plan.orders.push(order(1n, FROM_BLOCK, { isBid: true }));
    // Placed at the end of the chunk — now.
    plan.orders.push(order(2n, TO_BLOCK, { isBid: false }));

    // Keep half an hour. The first order falls outside it, the second inside.
    await applyPlan(db, plan, meta({ orderMinTs: NOW - 1800n }));

    expect(await countOrders()).toBe(1);
    const r = (await db.execute(sql`select order_id from orders`)) as unknown;
    const rows = (Array.isArray(r) ? r : ((r as { rows?: { order_id: string }[] }).rows ?? [])) as { order_id: string }[];
    expect(rows[0]?.order_id).toBe("2");

    // The statistic that matters is latched from plan.orders, not from the rows
    // written, so dropping the old row must not cost the market its bid side.
    const m = (await db.execute(sql`select had_bid, had_ask from markets where market_id = ${MARKET.toLowerCase()}`)) as unknown;
    const mrows = (Array.isArray(m) ? m : ((m as { rows?: Record<string, unknown>[] }).rows ?? [])) as Record<string, unknown>[];
    expect(mrows[0]?.had_bid).toBe(true);
    expect(mrows[0]?.had_ask).toBe(true);
  });

  it("writes everything when no cutoff is given", async () => {
    await db.execute(sql`delete from orders`);
    const plan = emptyPlan();
    plan.orders.push(order(10n, FROM_BLOCK));
    plan.orders.push(order(11n, TO_BLOCK));

    await applyPlan(db, plan, meta());

    expect(await countOrders()).toBe(2);
  });

  it("a cutoff past the whole chunk writes no orders at all", async () => {
    await db.execute(sql`delete from orders`);
    const plan = emptyPlan();
    plan.orders.push(order(20n, FROM_BLOCK));
    plan.orders.push(order(21n, TO_BLOCK));

    await applyPlan(db, plan, meta({ orderMinTs: NOW + 1n }));

    expect(await countOrders()).toBe(0);
  });
});
