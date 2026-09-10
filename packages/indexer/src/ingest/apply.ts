// Persist a ChunkPlan. One transaction per chunk: rows + cursor move together, so
// a crash never leaves the cursor ahead of the data.

import { and, eq, inArray, sql } from "drizzle-orm";
import type { Address, Hex } from "viem";
import type { Db } from "../db/client.js";
import { blocks, builderFeeEvents, cursor, fills, markets, orders, poolEpochs, protocolFeeEvents, rawEvents, redemptions } from "../db/schema.js";
import { attributeFills, lookupFromOrders, type ChunkPlan, type OrderLookup, type OrderUpdate } from "./plan.js";

export interface ChunkMeta {
  network: string;
  from: bigint;
  to: bigint;
  /** Header of `to` (hash + parentHash + timestamp) and timestamp of `from`, for block_ts interpolation + reorg anchor. */
  toHash: Hex;
  toParentHash: Hex;
  toTs: bigint;
  fromTs: bigint;
  /** Only the final pass over a range moves the cursor. */
  advanceCursor: boolean;
  startBlock: bigint;
  /**
   * Keep `orders` rows only for markets on this venue.
   *
   * Orders are by far the largest table — several per market per window across every
   * venue on the chain — and Relay only ever reads them for its own venue's books and
   * quoted-but-untaken stats. Fills, markets and stats stay chain-wide. Undefined
   * keeps everything, which is what a general-purpose indexer would want.
   */
  ordersVenueId?: string | undefined;
  /**
   * Skip `orders` rows placed before this unix second.
   *
   * Retention keeps orders for hours, but the backfill ignored it completely: a
   * 24-hour catch-up wrote every order in that window — ~800k rows, ~500 MB — and
   * the first prune after it finished deleted almost all of them. That filled a
   * 0.5 GB Neon project mid-backfill, and the writes it could not finish are what
   * stopped the indexer.
   *
   * Not writing a row that the next prune would delete costs nothing real. The
   * quoted-both-sides latch reads `plan.orders`, not the rows written here, so the
   * zero-fill and quoted-but-untaken statistics are unaffected. What is given up is
   * attribution for a fill whose order is older than the retention window — and that
   * order was going to be deleted within the hour regardless.
   *
   * Undefined writes everything, which is what a one-off archival run would want.
   */
  orderMinTs?: bigint | undefined;
}

const s = (v: bigint) => v.toString();
const BATCH = 1000;

function tsInterpolator(m: ChunkMeta): (block: bigint) => bigint {
  const span = m.to - m.from;
  if (span <= 0n) return () => m.toTs;
  const dt = m.toTs - m.fromTs;
  return (b) => m.fromTs + (dt * (b - m.from)) / span;
}

async function chunked<T>(rows: T[], fn: (slice: T[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < rows.length; i += BATCH) await fn(rows.slice(i, i + BATCH));
}

export interface ApplyCounts {
  markets: number;
  orders: number;
  fills: number;
  builderFees: number;
  protocolFees: number;
  redemptions: number;
  raw: number;
  orderUpdates: number;
}

export async function applyPlan(db: Db, plan: ChunkPlan, meta: ChunkMeta): Promise<ApplyCounts> {
  const tsOf = tsInterpolator(meta);
  const counts: ApplyCounts = { markets: 0, orders: 0, fills: 0, builderFees: 0, protocolFees: 0, redemptions: 0, raw: 0, orderUpdates: 0 };

  // Resolve fill attribution BEFORE the transaction (read-only lookups for orders outside this chunk).
  const inChunk = new Set<string>(plan.orders.map((o) => o.key));
  const missing = new Map<string, { pool: Address; orderId: bigint }>();
  for (const f of plan.fills) {
    for (const [k, pool, id] of [
      [f.takerKey, f.pool, f.takerOrderId],
      [f.makerKey, f.pool, f.makerOrderId],
    ] as const) {
      if (!inChunk.has(k) && !missing.has(k)) missing.set(k, { pool, orderId: id });
    }
  }
  const fromDb = new Map<string, OrderLookup>();
  if (missing.size > 0) {
    const list = [...missing.values()];
    for (let i = 0; i < list.length; i += 500) {
      const slice = list.slice(i, i + 500);
      const tuples = sql.join(
        slice.map((x) => sql`(${x.pool}, ${s(x.orderId)}::numeric)`),
        sql`, `,
      );
      const rows = (await db.execute(
        sql`select pool, order_id, owner, kind, partner_id, surface_id, builder from orders where (pool, order_id) in (${tuples})`,
      )) as unknown as { rows?: Record<string, unknown>[] } | Record<string, unknown>[];
      const arr = Array.isArray(rows) ? rows : (rows.rows ?? []);
      for (const r of arr) {
        fromDb.set(`${String(r.pool)}:${String(r.order_id)}`, {
          owner: String(r.owner) as Address,
          kind: r.kind === null || r.kind === undefined ? null : Number(r.kind),
          partnerId: r.partner_id === null || r.partner_id === undefined ? null : Number(r.partner_id),
          surfaceId: r.surface_id === null || r.surface_id === undefined ? null : Number(r.surface_id),
          builder: (r.builder as Address | null) ?? null,
        });
      }
    }
  }
  const inChunkLookup = lookupFromOrders(plan.orders);
  const lookup = (k: string): OrderLookup | null => inChunkLookup(k) ?? fromDb.get(k) ?? null;
  const fillRows = attributeFills(plan.fills, lookup);

  await db.transaction(async (tx) => {
    // markets
    if (plan.markets.length) {
      await chunked(plan.markets, (rows) =>
        tx
          .insert(markets)
          .values(
            rows.map((m) => ({
              marketId: m.marketId.toLowerCase(),
              marketAddress: m.marketAddress,
              pool: m.pool,
              venueId: m.venueId,
              operatorId: m.operatorId,
              creator: m.creator,
              collateral: m.collateral,
              yesId: s(m.yesId),
              noId: s(m.noId),
              nonce: m.nonce,
              asset: m.asset,
              intervalSec: m.intervalSec,
              windowSec: m.windowSec,
              tradingStart: m.tradingStart,
              expiry: m.expiry,
              strikeRaw: s(m.strikeRaw),
              question: m.question,
              voidPolicy: m.voidPolicy,
              oracleQuestionId: s(m.oracleQuestionId),
              status: 1,
              createdBlock: m.createdBlock,
              createdBlockHash: m.createdBlockHash,
              createdTx: m.createdTx,
            })),
          )
          .onConflictDoNothing(),
      );
      counts.markets += plan.markets.length;
    }
    // epochs
    for (const e of plan.epochsClosed) {
      await tx.update(poolEpochs).set({ toBlock: e.toBlock }).where(eq(poolEpochs.marketId, e.marketId.toLowerCase()));
    }
    if (plan.epochsOpened.length) {
      await tx
        .insert(poolEpochs)
        .values(plan.epochsOpened.map((e) => ({ pool: e.pool, marketId: e.marketId.toLowerCase(), nonce: e.nonce, fromBlock: e.fromBlock, toBlock: e.toBlock })))
        .onConflictDoNothing();
    }
    for (const r of plan.references) {
      await tx.update(markets).set({ referenceQuestionId: s(r.referenceQuestionId), updatedAt: new Date() }).where(eq(markets.marketId, r.marketId.toLowerCase()));
    }
    for (const r of plan.resolved) {
      await tx
        .update(markets)
        .set({
          status: r.voided ? 5 : 4,
          voided: r.voided,
          payoutNumerators: r.payoutNumerators.map(String),
          payoutDenominator: s(r.payoutDenominator),
          winner: r.winner,
          resolvedBlock: r.block,
          resolvedAt: tsOf(r.block),
          updatedAt: new Date(),
        })
        .where(eq(markets.marketId, r.marketId.toLowerCase()));
    }
    for (const f of plan.finalized) {
      if (f.marketId) await tx.update(markets).set({ finalized: true, updatedAt: new Date() }).where(eq(markets.marketId, f.marketId.toLowerCase()));
      else await tx.update(markets).set({ finalized: true, updatedAt: new Date() }).where(and(eq(markets.pool, f.pool), eq(markets.nonce, f.nonce)));
    }
    // orders
    //
    // Filtered AFTER attribution above, deliberately: a fill's partner and builder are
    // resolved from the order that produced it, so dropping other venues' orders before
    // that step would strip attribution from fills we still store.
    let orderRows = plan.orders;
    if (meta.ordersVenueId) {
      const ids = [...new Set(plan.orders.map((o) => o.marketId?.toLowerCase()).filter((m): m is string => !!m))];
      const onVenue = new Set<string>();
      if (ids.length) {
        const rows = await tx.select({ marketId: markets.marketId }).from(markets).where(and(inArray(markets.marketId, ids), eq(markets.venueId, meta.ordersVenueId)));
        for (const r of rows) onVenue.add(r.marketId);
      }
      // An order with no market binding yet cannot be placed on a venue, and the row
      // exists only to attribute a later fill — which the in-chunk lookup already did.
      orderRows = plan.orders.filter((o) => o.marketId && onVenue.has(o.marketId.toLowerCase()));
    }
    if (meta.orderMinTs !== undefined) {
      const min = meta.orderMinTs;
      orderRows = orderRows.filter((o) => tsOf(o.placedBlock) >= min);
    }
    if (orderRows.length) {
      await chunked(orderRows, (rows) =>
        tx
          .insert(orders)
          .values(
            rows.map((o) => ({
              pool: o.pool,
              orderId: s(o.orderId),
              marketId: o.marketId?.toLowerCase() ?? null,
              owner: o.owner,
              isBid: o.isBid,
              kind: o.kind,
              price: s(o.price),
              quantity: s(o.quantity),
              userData: s(o.userData),
              tagVersion: o.tagVersion,
              partnerId: o.partnerId,
              surfaceId: o.surfaceId,
              builder: o.builder,
              expireNs: s(o.expireNs),
              placedBlock: o.placedBlock,
              placedTs: tsOf(o.placedBlock),
              blockHash: o.blockHash,
              txHash: o.txHash,
              logIndex: o.logIndex,
              restedQty: o.restedQty === null ? null : s(o.restedQty),
              filledQty: s(o.filledQty),
              cancelled: o.cancelled,
              expired: o.expired,
            })),
          )
          .onConflictDoNothing(),
      );
      counts.orders += orderRows.length;
    }

    // Mark the market as having been quoted on each side. This is a latch — once true
    // it stays true — so it is correct no matter how the orders are later pruned, and
    // it is what the zero-fill / quoted-but-untaken tables read instead of counting
    // order rows that no longer exist.
    if (plan.orders.length) {
      // RESTED, not merely placed: "quoted but untaken" has always meant liquidity that
      // sat on the book, and an order that crossed and filled immediately was never an
      // offer anyone declined. `restedQty` is set when OrderRested fired for it.
      const sides = new Map<string, { bid: boolean; ask: boolean }>();
      const noteSide = (marketId: string | null | undefined, isBid: boolean) => {
        if (!marketId) return;
        const k = marketId.toLowerCase();
        const cur = sides.get(k) ?? { bid: false, ask: false };
        if (isBid) cur.bid = true;
        else cur.ask = true;
        sides.set(k, cur);
      };
      for (const o of plan.orders) if (o.restedQty !== null && o.restedQty !== undefined && o.restedQty > 0n) noteSide(o.marketId, o.isBid);
      for (const [marketId, v] of sides) {
        if (!v.bid && !v.ask) continue;
        await tx
          .update(markets)
          .set({
            ...(v.bid ? { hadBid: true } : {}),
            ...(v.ask ? { hadAsk: true } : {}),
            updatedAt: new Date(),
          })
          .where(eq(markets.marketId, marketId));
      }
    }
    // order updates (orders from earlier chunks), batched per update kind
    await applyOrderUpdates(tx, plan.orderUpdates);
    counts.orderUpdates += plan.orderUpdates.length;
    // fills
    if (fillRows.length) {
      await chunked(fillRows, (rows) =>
        tx
          .insert(fills)
          .values(
            rows.map((f) => ({
              pool: f.pool,
              marketId: f.marketId?.toLowerCase() ?? null,
              takerOrderId: s(f.takerOrderId),
              makerOrderId: s(f.makerOrderId),
              fillPrice: s(f.fillPrice),
              quantity: s(f.quantity),
              notional: s(f.notional),
              block: f.block,
              blockTs: tsOf(f.block),
              blockHash: f.blockHash,
              txHash: f.txHash,
              logIndex: f.logIndex,
              takerOwner: f.takerOwner,
              makerOwner: f.makerOwner,
              takerKind: f.takerKind,
              makerKind: f.makerKind,
              takerPartnerId: f.takerPartnerId,
              takerSurfaceId: f.takerSurfaceId,
              makerPartnerId: f.makerPartnerId,
              takerBuilder: f.takerBuilder,
              makerBuilder: f.makerBuilder,
            })),
          )
          .onConflictDoNothing(),
      );
      counts.fills += fillRows.length;
    }
    if (plan.builderFees.length) {
      await chunked(plan.builderFees, (rows) =>
        tx
          .insert(builderFeeEvents)
          .values(rows.map((r) => ({ pool: r.pool!, marketId: r.marketId?.toLowerCase() ?? null, orderId: s(r.orderId), builder: r.builder, token: r.token, amount: s(r.amount), block: r.block, blockHash: r.blockHash, txHash: r.txHash, logIndex: r.logIndex })))
          .onConflictDoNothing(),
      );
      counts.builderFees += plan.builderFees.length;
    }
    if (plan.protocolFees.length) {
      await chunked(plan.protocolFees, (rows) =>
        tx
          .insert(protocolFeeEvents)
          .values(rows.map((r) => ({ pool: r.pool!, marketId: r.marketId?.toLowerCase() ?? null, orderId: s(r.orderId), payer: r.payer, token: r.token, amount: s(r.amount), isTakerSide: r.isTakerSide, block: r.block, blockHash: r.blockHash, txHash: r.txHash, logIndex: r.logIndex })))
          .onConflictDoNothing(),
      );
      counts.protocolFees += plan.protocolFees.length;
    }
    if (plan.redemptions.length) {
      await chunked(plan.redemptions, (rows) =>
        tx
          .insert(redemptions)
          .values(rows.map((r) => ({ marketKey: s(r.marketKey), pool: r.pool ?? null, nonce: r.nonce, marketId: r.marketId?.toLowerCase() ?? null, holder: r.holder, to: r.to, outcomeIdx: r.outcomeIdx, amountBurned: s(r.amountBurned), collateralOut: s(r.collateralOut), block: r.block, blockHash: r.blockHash, txHash: r.txHash, logIndex: r.logIndex })))
          .onConflictDoNothing(),
      );
      counts.redemptions += plan.redemptions.length;
    }
    if (plan.raw.length) {
      await chunked(plan.raw, (rows) =>
        tx
          .insert(rawEvents)
          .values(rows.map((r) => ({ address: r.address, topic0: r.topic0, name: r.name, marketId: r.marketId?.toLowerCase() ?? null, topics: r.topics, data: r.data, args: r.args, block: r.block, blockHash: r.blockHash, txHash: r.txHash, logIndex: r.logIndex })))
          .onConflictDoNothing(),
      );
      counts.raw += plan.raw.length;
    }
    // reorg anchor for this chunk's last block
    await tx
      .insert(blocks)
      .values({ number: meta.to, hash: meta.toHash, parentHash: meta.toParentHash, timestamp: meta.toTs })
      .onConflictDoUpdate({ target: blocks.number, set: { hash: meta.toHash, parentHash: meta.toParentHash, timestamp: meta.toTs } });
    if (meta.advanceCursor) {
      await tx
        .insert(cursor)
        .values({ network: meta.network, lastBlock: meta.to, lastBlockHash: meta.toHash, startBlock: meta.startBlock, updatedAt: new Date() })
        .onConflictDoUpdate({ target: cursor.network, set: { lastBlock: meta.to, lastBlockHash: meta.toHash, updatedAt: new Date() } });
    }
  });
  return counts;
}

async function applyOrderUpdates(tx: Db, updates: OrderUpdate[]): Promise<void> {
  if (updates.length === 0) return;
  const tuple = (u: OrderUpdate) => sql`(${u.pool}, ${s(u.orderId)}::numeric)`;
  const run = async (rows: OrderUpdate[], setClause: (u: OrderUpdate) => ReturnType<typeof sql> | null, valueColumns: boolean) => {
    for (let i = 0; i < rows.length; i += BATCH) {
      const slice = rows.slice(i, i + BATCH);
      if (!valueColumns) {
        const keys = sql.join(slice.map(tuple), sql`, `);
        await tx.execute(sql`update orders set ${setClause(slice[0]!)} where (pool, order_id) in (${keys})`);
      } else {
        // per-row values via a VALUES join
        const vals = sql.join(slice.map((u) => sql`(${u.pool}, ${s(u.orderId)}::numeric, ${setClause(u)})`), sql`, `);
        await tx.execute(sql`update orders o set ${valueSetter} from (values ${vals}) as v(pool, order_id, val) where o.pool = v.pool and o.order_id = v.order_id`);
      }
    }
  };
  const cancelled = updates.filter((u) => u.cancelled);
  const expired = updates.filter((u) => u.expired);
  const rested = updates.filter((u) => u.restedQty !== undefined);
  const kinds = updates.filter((u) => u.kind !== undefined);
  const builders = updates.filter((u) => u.builder !== undefined);
  const filled = updates.filter((u) => u.filledQtyAdd !== undefined && u.filledQtyAdd !== 0n);
  if (cancelled.length) await run(cancelled, () => sql`cancelled = true`, false);
  if (expired.length) await run(expired, () => sql`expired = true`, false);
  if (rested.length) {
    valueSetter = sql`rested_qty = v.val::numeric`;
    await run(rested, (u) => sql`${s(u.restedQty!)}`, true);
  }
  if (kinds.length) {
    valueSetter = sql`kind = v.val::int`;
    await run(kinds, (u) => sql`${u.kind!}`, true);
  }
  if (builders.length) {
    valueSetter = sql`builder = v.val::text`;
    await run(builders, (u) => sql`${u.builder!}`, true);
  }
  if (filled.length) {
    valueSetter = sql`filled_qty = o.filled_qty + v.val::numeric`;
    await run(filled, (u) => sql`${s(u.filledQtyAdd!)}`, true);
  }
}
let valueSetter: ReturnType<typeof sql> = sql``;

/** Reorg rollback: forget everything above `block` (inclusive of nothing at/below it). */
export async function rollbackTo(db: Db, network: string, block: bigint, blockHash: Hex | null): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`delete from fills where block > ${s(block)}`);
    await tx.execute(sql`delete from builder_fee_events where block > ${s(block)}`);
    await tx.execute(sql`delete from protocol_fee_events where block > ${s(block)}`);
    await tx.execute(sql`delete from redemptions where block > ${s(block)}`);
    await tx.execute(sql`delete from raw_events where block > ${s(block)}`);
    await tx.execute(sql`delete from orders where placed_block > ${s(block)}`);
    await tx.execute(sql`delete from pool_epochs where from_block > ${s(block)}`);
    await tx.execute(sql`update pool_epochs set to_block = null where to_block > ${s(block)}`);
    await tx.execute(sql`delete from markets where created_block > ${s(block)}`);
    await tx.execute(
      sql`update markets set status = 1, voided = false, payout_numerators = null, payout_denominator = null, winner = null, resolved_block = null, resolved_at = null, closing_price_raw = null where resolved_block > ${s(block)}`,
    );
    await tx.execute(sql`delete from blocks where number > ${s(block)}`);
    await tx.update(cursor).set({ lastBlock: block, lastBlockHash: blockHash, updatedAt: new Date() }).where(eq(cursor.network, network));
  });
}

export async function loadCursor(db: Db, network: string): Promise<{ lastBlock: bigint; lastBlockHash: Hex | null; startBlock: bigint } | null> {
  const r = await db.select().from(cursor).where(eq(cursor.network, network)).limit(1);
  const c = r[0];
  return c ? { lastBlock: c.lastBlock, lastBlockHash: (c.lastBlockHash as Hex | null) ?? null, startBlock: c.startBlock } : null;
}

export async function loadEpochs(db: Db): Promise<{ pool: Address; marketId: Hex; nonce: bigint; fromBlock: bigint; toBlock: bigint | null }[]> {
  const rows = await db.select().from(poolEpochs);
  return rows.map((r) => ({ pool: r.pool as Address, marketId: r.marketId as Hex, nonce: r.nonce, fromBlock: r.fromBlock, toBlock: r.toBlock }));
}

export async function knownPools(db: Db): Promise<Address[]> {
  const rows = await db.selectDistinct({ pool: markets.pool }).from(markets);
  return rows.map((r) => r.pool as Address);
}

export { inArray };
