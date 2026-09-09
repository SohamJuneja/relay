// Materialised stats. The aggregation over markets is a pure function
// (`aggregateVenueDaily`) so the "empty market" definitions are unit-testable;
// SQL only gathers per-market inputs and writes the results.

import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

/** Per-market inputs for the venue stats (one row per completed window). */
export interface MarketAgg {
  marketId: string;
  venueId: string;
  asset: string;
  intervalSec: number;
  /** unix seconds */
  expiry: number;
  fills: number;
  notional: bigint;
  uniqueTakers: number;
  /** distinct resting bid / ask orders seen on the market */
  restedBids: number;
  restedAsks: number;
}

export interface VenueDailyRow {
  venueId: string;
  asset: string;
  intervalSec: number;
  /** YYYY-MM-DD (UTC) of the window's expiry */
  day: string;
  windows: number;
  zeroFillWindows: number;
  quotedButUntakenWindows: number;
  fills: number;
  notional: bigint;
  uniqueTakers: number;
}

export const dayOf = (sec: number): string => new Date(sec * 1000).toISOString().slice(0, 10);

export function aggregateVenueDaily(rows: MarketAgg[], takersByGroup?: Map<string, Set<string>>): VenueDailyRow[] {
  const groups = new Map<string, VenueDailyRow>();
  for (const m of rows) {
    const key = `${m.venueId}|${m.asset}|${m.intervalSec}|${dayOf(m.expiry)}`;
    const g = groups.get(key) ?? {
      venueId: m.venueId,
      asset: m.asset,
      intervalSec: m.intervalSec,
      day: dayOf(m.expiry),
      windows: 0,
      zeroFillWindows: 0,
      quotedButUntakenWindows: 0,
      fills: 0,
      notional: 0n,
      uniqueTakers: 0,
    };
    g.windows++;
    g.fills += m.fills;
    g.notional += m.notional;
    if (m.fills === 0) {
      g.zeroFillWindows++;
      if (m.restedBids > 0 && m.restedAsks > 0) g.quotedButUntakenWindows++;
    }
    groups.set(key, g);
  }
  if (takersByGroup) for (const [k, g] of groups) g.uniqueTakers = takersByGroup.get(k)?.size ?? 0;
  return [...groups.values()];
}

const rowsOf = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] }).rows ?? []));

/** Recompute stats_venue_daily for windows that expired in the last `days` days. */
export async function computeVenueStats(db: Db, days = 3, nowSec = Math.floor(Date.now() / 1000)): Promise<number> {
  const since = nowSec - days * 86400;
  const q = await db.execute(sql`
    select m.market_id, m.venue_id, m.asset, m.interval_sec, m.expiry,
           coalesce(f.fills, 0)::int as fills, coalesce(f.notional, 0)::text as notional,
           -- The latched flags, with a fallback to the order rows for markets ingested
           -- before the flags existed. Once those age out the join costs nothing,
           -- because there is nothing left to scan.
           (m.had_bid or coalesce(o.rested_bids, 0) > 0) as had_bid,
           (m.had_ask or coalesce(o.rested_asks, 0) > 0) as had_ask
    from markets m
    left join lateral (select count(*) as fills, sum(notional) as notional from fills where fills.market_id = m.market_id) f on true
    left join lateral (
      select count(*) filter (where is_bid and rested_qty is not null and rested_qty > 0) as rested_bids,
             count(*) filter (where not is_bid and rested_qty is not null and rested_qty > 0) as rested_asks
      from orders where orders.market_id = m.market_id) o on true
    where m.expiry >= ${since}::bigint and m.expiry <= ${nowSec}::bigint`);
  const rows: MarketAgg[] = rowsOf(q).map((r) => ({
    marketId: String(r.market_id),
    venueId: String(r.venue_id),
    asset: String(r.asset),
    intervalSec: Number(r.interval_sec),
    expiry: Number(r.expiry),
    fills: Number(r.fills),
    notional: BigInt(String(r.notional)),
    uniqueTakers: 0,
    restedBids: r.had_bid ? 1 : 0,
    restedAsks: r.had_ask ? 1 : 0,
  }));
  // unique takers per group
  const tq = await db.execute(sql`
    select m.venue_id, m.asset, m.interval_sec, to_char(to_timestamp(m.expiry) at time zone 'UTC', 'YYYY-MM-DD') as day, count(distinct f.taker_owner)::int as takers
    from fills f join markets m on m.market_id = f.market_id
    where m.expiry >= ${since}::bigint and m.expiry <= ${nowSec}::bigint and f.taker_owner is not null
    group by 1,2,3,4`);
  const takers = new Map<string, Set<string>>();
  for (const r of rowsOf(tq)) {
    const key = `${r.venue_id}|${r.asset}|${r.interval_sec}|${r.day}`;
    takers.set(key, new Set(Array.from({ length: Number(r.takers) }, (_, i) => String(i))));
  }
  const out = aggregateVenueDaily(rows, takers);
  for (const g of out) {
    await db.execute(sql`
      insert into stats_venue_daily (venue_id, asset, interval_sec, day, windows, zero_fill_windows, quoted_but_untaken_windows, fills, notional, unique_takers, computed_at)
      values (${g.venueId}, ${g.asset}, ${g.intervalSec}, ${g.day}::date, ${g.windows}, ${g.zeroFillWindows}, ${g.quotedButUntakenWindows}, ${g.fills}, ${g.notional.toString()}::numeric, ${g.uniqueTakers}, now())
      on conflict (venue_id, asset, interval_sec, day) do update set
        windows = excluded.windows, zero_fill_windows = excluded.zero_fill_windows, quoted_but_untaken_windows = excluded.quoted_but_untaken_windows,
        fills = excluded.fills, notional = excluded.notional, unique_takers = excluded.unique_takers, computed_at = now()`);
  }
  return out.length;
}

export interface VenueWindowRow {
  asset: string;
  intervalSec: number;
  windows: number;
  zeroFillWindows: number;
  quotedButUntakenWindows: number;
  fills: number;
  notional: bigint;
  uniqueTakers: number;
}

/**
 * Live (non-materialised) zero-fill / quoted-but-untaken over the last `hours`,
 * per series, for one venue. Same definitions as the daily job; used to compare
 * against the Phase 0 probe's 6-hour figure.
 */
export async function computeVenueWindow(db: Db, venueId: string, hours: number, nowSec = Math.floor(Date.now() / 1000)): Promise<VenueWindowRow[]> {
  const since = nowSec - hours * 3600;
  const q = await db.execute(sql`
    select m.market_id, m.asset, m.interval_sec, m.expiry,
           coalesce(f.fills, 0)::int as fills, coalesce(f.notional, 0)::text as notional, coalesce(f.takers, 0)::int as takers,
           coalesce(o.rested_bids, 0)::int as rested_bids, coalesce(o.rested_asks, 0)::int as rested_asks
    from markets m
    left join lateral (select count(*) as fills, sum(notional) as notional, count(distinct taker_owner) as takers from fills where fills.market_id = m.market_id) f on true
    left join lateral (
      select count(*) filter (where is_bid and rested_qty is not null and rested_qty > 0) as rested_bids,
             count(*) filter (where not is_bid and rested_qty is not null and rested_qty > 0) as rested_asks
      from orders where orders.market_id = m.market_id) o on true
    where m.venue_id = ${venueId.toLowerCase()} and m.expiry >= ${since}::bigint and m.expiry <= ${nowSec}::bigint`);
  const groups = new Map<string, VenueWindowRow & { takerSet: Set<string> }>();
  for (const r of rowsOf(q)) {
    const key = `${r.asset}|${r.interval_sec}`;
    const g = groups.get(key) ?? { asset: String(r.asset), intervalSec: Number(r.interval_sec), windows: 0, zeroFillWindows: 0, quotedButUntakenWindows: 0, fills: 0, notional: 0n, uniqueTakers: 0, takerSet: new Set<string>() };
    const fills = Number(r.fills);
    g.windows++;
    g.fills += fills;
    g.notional += BigInt(String(r.notional));
    if (fills === 0) {
      g.zeroFillWindows++;
      if (Number(r.rested_bids) > 0 && Number(r.rested_asks) > 0) g.quotedButUntakenWindows++;
    }
    groups.set(key, g);
  }
  const tq = await db.execute(sql`
    select m.asset, m.interval_sec, count(distinct f.taker_owner)::int as takers
    from fills f join markets m on m.market_id = f.market_id
    where m.venue_id = ${venueId.toLowerCase()} and m.expiry >= ${since}::bigint and m.expiry <= ${nowSec}::bigint and f.taker_owner is not null
    group by 1, 2`);
  for (const r of rowsOf(tq)) {
    const g = groups.get(`${r.asset}|${r.interval_sec}`);
    if (g) g.uniqueTakers = Number(r.takers);
  }
  return [...groups.values()].map(({ takerSet: _t, ...g }) => g).sort((a, b) => (a.asset === b.asset ? a.intervalSec - b.intervalSec : a.asset.localeCompare(b.asset)));
}

/** stats_partner + stats_partner_hourly from fills attributed on the TAKER side. */
export async function computePartnerStats(db: Db, feeBps: number): Promise<number> {
  const q = await db.execute(sql`
    select taker_partner_id as partner_id, count(*)::int as fills, coalesce(sum(notional),0)::text as notional,
           count(distinct taker_owner)::int as wallets, count(distinct market_id)::int as markets
    from fills where taker_partner_id is not null group by 1`);
  const rows = rowsOf(q);
  for (const r of rows) {
    const notional = BigInt(String(r.notional));
    const projected = (notional * BigInt(feeBps)) / 10_000n;
    await db.execute(sql`
      insert into stats_partner (partner_id, fills, notional, unique_wallets, markets_touched, projected_builder_fee, fee_bps, computed_at)
      values (${Number(r.partner_id)}, ${Number(r.fills)}, ${notional.toString()}::numeric, ${Number(r.wallets)}, ${Number(r.markets)}, ${projected.toString()}::numeric, ${feeBps}, now())
      on conflict (partner_id) do update set fills = excluded.fills, notional = excluded.notional, unique_wallets = excluded.unique_wallets,
        markets_touched = excluded.markets_touched, projected_builder_fee = excluded.projected_builder_fee, fee_bps = excluded.fee_bps, computed_at = now()`);
  }
  await db.execute(sql`
    insert into stats_partner_hourly (partner_id, hour_ts, fills, notional, unique_wallets)
    select taker_partner_id, (block_ts / 3600) * 3600, count(*)::int, coalesce(sum(notional),0), count(distinct taker_owner)::int
    from fills where taker_partner_id is not null group by 1, 2
    on conflict (partner_id, hour_ts) do update set fills = excluded.fills, notional = excluded.notional, unique_wallets = excluded.unique_wallets`);
  return rows.length;
}
