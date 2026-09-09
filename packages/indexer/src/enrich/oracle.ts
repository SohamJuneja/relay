// Opening / closing prices from the OracleHub, straight from chain.
//   opening = hub.pullNumericAnswer(referenceQuestionId)  (answered ~1 s after tradingStart)
//   closing = hub.pullNumericAnswer(oracleQuestionId)     (answered at resolution)
// pullNumericAnswer REVERTS while unanswered — that is a state, not an error.

import { and, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { parseAbi, type Address, type PublicClient } from "viem";
import { batchRead } from "@relay/core";
import type { Db } from "../db/client.js";
import { markets } from "../db/schema.js";

const hubAbi = parseAbi(["function pullNumericAnswer(uint256 oracleQuestionId) view returns (int256 numericValue, bool voided)"]);

/**
 * The opening price of a market that is ALREADY TRADING and still has no baseline.
 *
 * The regular enrichment pass runs every 5 s, so a window can trade for up to 7 s
 * with no opening price — and during that time the widget cannot state its own
 * question ("above WHAT?"), show the move since open, or draw a direction. That is
 * the one state where a couple of extra RPC reads a second is obviously worth it, so
 * this runs on its own 2 s cadence and only ever looks at the handful of markets in
 * that gap. Returns how many were still waiting, so the gap can be measured rather
 * than assumed.
 */
export async function fillPendingOpenings(
  db: Db,
  client: PublicClient,
  hub: Address,
  opts: { nowSec?: number; olderThanSec?: number } = {},
): Promise<{ pending: number; filled: number; marketIds: string[] }> {
  const now = BigInt(opts.nowSec ?? Math.floor(Date.now() / 1000));
  const age = BigInt(opts.olderThanSec ?? 5);
  const rows = await db
    .select({ marketId: markets.marketId, q: markets.referenceQuestionId })
    .from(markets)
    .where(
      and(
        isNotNull(markets.referenceQuestionId),
        isNull(markets.openingPriceRaw),
        lte(markets.tradingStart, now - age),
        sql`status = 1`,
        sql`expiry > ${now.toString()}::bigint`,
      ),
    )
    .limit(40);
  if (rows.length === 0) return { pending: 0, filled: 0, marketIds: [] };

  const res = await batchRead(
    client,
    rows.map((m) => ({ address: hub, abi: hubAbi, functionName: "pullNumericAnswer", args: [BigInt(m.q!)] })),
  );
  let filled = 0;
  for (const [i, m] of rows.entries()) {
    const r = res[i];
    if (!r?.ok) continue; // pullNumericAnswer reverts while unanswered — a state, not an error
    const [v, voided] = r.value as readonly [bigint, boolean];
    if (voided) continue;
    await db.update(markets).set({ openingPriceRaw: v.toString(), updatedAt: new Date() }).where(sql`market_id = ${m.marketId}`);
    filled++;
  }
  return { pending: rows.length, filled, marketIds: rows.map((m) => m.marketId) };
}

export interface EnrichResult {
  openingFilled: number;
  closingFilled: number;
  lockedMarked: number;
}

export async function enrichMarkets(db: Db, client: PublicClient, hub: Address, opts: { limit?: number; nowSec?: number } = {}): Promise<EnrichResult> {
  const now = BigInt(opts.nowSec ?? Math.floor(Date.now() / 1000));
  const limit = opts.limit ?? 300;
  const out: EnrichResult = { openingFilled: 0, closingFilled: 0, lockedMarked: 0 };

  // Locked: expiry passed, not resolved yet.
  const locked = await db.execute(sql`update markets set status = 2, updated_at = now() where status = 1 and expiry < ${now.toString()}::bigint returning market_id`);
  out.lockedMarked = Array.isArray(locked) ? locked.length : ((locked as { rows?: unknown[] }).rows?.length ?? 0);

  // Opening prices.
  const needOpen = await db
    .select({ marketId: markets.marketId, q: markets.referenceQuestionId })
    .from(markets)
    .where(and(isNotNull(markets.referenceQuestionId), isNull(markets.openingPriceRaw), lte(markets.tradingStart, now - 2n)))
    .orderBy(sql`expiry desc`)
    .limit(limit);
  if (needOpen.length) {
    const res = await batchRead(
      client,
      needOpen.map((m) => ({ address: hub, abi: hubAbi, functionName: "pullNumericAnswer", args: [BigInt(m.q!)] })),
    );
    for (const [i, m] of needOpen.entries()) {
      const r = res[i];
      if (!r?.ok) continue;
      const [v, voided] = r.value as readonly [bigint, boolean];
      if (voided) continue;
      await db.update(markets).set({ openingPriceRaw: v.toString(), updatedAt: new Date() }).where(sql`market_id = ${m.marketId}`);
      out.openingFilled++;
    }
  }

  // Closing prices (once expiry + 2 s has passed; usually resolved a few seconds later).
  const needClose = await db
    .select({ marketId: markets.marketId, q: markets.oracleQuestionId })
    .from(markets)
    .where(and(isNull(markets.closingPriceRaw), lte(markets.expiry, now - 2n)))
    .orderBy(sql`expiry desc`)
    .limit(limit);
  if (needClose.length) {
    const res = await batchRead(
      client,
      needClose.map((m) => ({ address: hub, abi: hubAbi, functionName: "pullNumericAnswer", args: [BigInt(m.q)] })),
    );
    for (const [i, m] of needClose.entries()) {
      const r = res[i];
      if (!r?.ok) continue;
      const [v, voided] = r.value as readonly [bigint, boolean];
      if (voided) continue;
      await db.update(markets).set({ closingPriceRaw: v.toString(), updatedAt: new Date() }).where(sql`market_id = ${m.marketId}`);
      out.closingFilled++;
    }
  }
  return out;
}
