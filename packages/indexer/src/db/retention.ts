// Keeping the database inside a free tier.
//
// Relay stores four kinds of row at very different rates. Markets and fills are the
// product and are kept forever — they are what every stat is computed from, and they
// are small: a few hundred markets and a few thousand fills a day.
//
// `orders` and `raw_events` are different. Orders are placed and cancelled constantly
// by market makers, several per market per window; raw_events is a debugging copy of
// every log we decoded. Both are only useful while they are recent: orders back a
// live book and the quoted-but-untaken statistic for completed windows, and raw_events
// exists to answer "what did that log actually say" when something looks wrong.
//
// So both are pruned on a rolling window and everything else is kept.

import { sql } from "drizzle-orm";
import type { Db } from "./client.js";

export interface RetentionPolicy {
  /** Orders older than this are dropped. Long enough to cover any window plus the stats job. */
  orderDays: number;
  /** Raw decoded logs older than this are dropped. */
  rawDays: number;
  /**
   * Redemptions and protocol-fee events older than this are dropped. Neither is read
   * by any API route or product surface — they are an archive kept in case a question
   * comes up — so they are the cheapest thing to give away on a small disk.
   */
  archiveDays: number;
  /**
   * Markets and fills that are NOT on this venue are dropped after `otherVenueDays`.
   * Relay reports on one venue; the rest of the chain is ingested because the module's
   * logs arrive together, and 81% of the markets on this chain belong to venues no
   * surface here ever displays. Undefined keeps every venue forever.
   */
  defaultVenueId?: string | undefined;
  otherVenueDays: number;
}

export const DEFAULT_RETENTION: RetentionPolicy = {
  orderDays: Number(process.env.ORDER_RETENTION_DAYS ?? 3),
  rawDays: Number(process.env.RAW_EVENT_RETENTION_DAYS ?? 7),
  archiveDays: Number(process.env.ARCHIVE_RETENTION_DAYS ?? 7),
  otherVenueDays: Number(process.env.OTHER_VENUE_RETENTION_DAYS ?? 2),
  ...(process.env.VENUE_ID ? { defaultVenueId: process.env.VENUE_ID.toLowerCase() } : {}),
};

export interface PruneResult {
  orders: number;
  rawEvents: number;
  blocks: number;
  redemptions: number;
  protocolFees: number;
  otherVenueFills: number;
  otherVenueMarkets: number;
  ms: number;
}

/**
 * Delete what has aged out. Safe to call as often as you like; it is a no-op once
 * there is nothing old left.
 *
 * `orders.placed_ts` and `raw_events.block` are both indexed, so these are range
 * deletes rather than table scans. Blocks are the reorg anchor table and only ever
 * needs the last couple of hundred rows.
 */
export async function pruneOldRows(db: Db, policy: RetentionPolicy = DEFAULT_RETENTION): Promise<PruneResult> {
  const t0 = Date.now();
  const now = Math.floor(Date.now() / 1000);
  const orderCutoff = now - policy.orderDays * 86_400;
  const rawCutoff = now - policy.rawDays * 86_400;

  const count = (r: unknown): number => (Array.isArray(r) ? r.length : ((r as { rows?: unknown[] })?.rows?.length ?? 0));

  const o = await db.execute(sql`delete from orders where placed_ts < ${orderCutoff}::bigint returning pool`);
  // raw_events has no timestamp column, only a block number; blocks are ~100 ms apart
  // on Somnia, so the cutoff is expressed in blocks from the current head.
  const head = await db.execute(sql`select coalesce(max(number), 0)::bigint as n from blocks`);
  const headRows = (Array.isArray(head) ? head : ((head as { rows?: Record<string, unknown>[] }).rows ?? [])) as Record<string, unknown>[];
  const headBlock = Number(headRows[0]?.n ?? 0);
  const blocksPerDay = 864_000; // 10 blocks a second
  const rawBlockCutoff = Math.max(0, headBlock - policy.rawDays * blocksPerDay);
  const r = rawBlockCutoff > 0 ? await db.execute(sql`delete from raw_events where block < ${rawBlockCutoff}::bigint returning id`) : [];
  // Keep a couple of hundred block headers: that is all the reorg check ever reads.
  const b = await db.execute(sql`delete from blocks where number < ${Math.max(0, headBlock - 500)}::bigint returning number`);

  // The archive: decoded and stored, read by nothing.
  const archiveBlockCutoff = Math.max(0, headBlock - policy.archiveDays * blocksPerDay);
  const red = archiveBlockCutoff > 0 ? await db.execute(sql`delete from redemptions where block < ${archiveBlockCutoff}::bigint returning id`) : [];
  const pf = archiveBlockCutoff > 0 ? await db.execute(sql`delete from protocol_fee_events where block < ${archiveBlockCutoff}::bigint returning id`) : [];

  // Other venues. Fills go first so nothing is orphaned by the market delete.
  let otherFills: unknown = [];
  let otherMarkets: unknown = [];
  if (policy.defaultVenueId) {
    const cutoff = now - policy.otherVenueDays * 86_400;
    otherFills = await db.execute(sql`
      delete from fills f using markets m
      where m.market_id = f.market_id and m.venue_id <> ${policy.defaultVenueId} and f.block_ts < ${cutoff}::bigint
      returning f.id`);
    otherMarkets = await db.execute(sql`
      delete from markets m
      where m.venue_id <> ${policy.defaultVenueId} and m.expiry < ${cutoff}::bigint
        and not exists (select 1 from fills f where f.market_id = m.market_id)
      returning m.market_id`);
  }

  return {
    orders: count(o),
    rawEvents: count(r),
    blocks: count(b),
    redemptions: count(red),
    protocolFees: count(pf),
    otherVenueFills: count(otherFills),
    otherVenueMarkets: count(otherMarkets),
    ms: Date.now() - t0,
  };
}

/** Row counts and on-disk size, for the growth projection in the README. */
export async function tableSizes(db: Db): Promise<{ table: string; rows: number; bytes: number }[]> {
  const res = await db.execute(sql`
    select relname as table,
           n_live_tup::bigint as rows,
           pg_total_relation_size(c.oid)::bigint as bytes
    from pg_stat_user_tables s join pg_class c on c.relname = s.relname
    where c.relkind = 'r'
    order by bytes desc`);
  const rows = Array.isArray(res) ? res : ((res as { rows?: Record<string, unknown>[] }).rows ?? []);
  return rows.map((r) => ({ table: String(r.table), rows: Number(r.rows), bytes: Number(r.bytes) }));
}
