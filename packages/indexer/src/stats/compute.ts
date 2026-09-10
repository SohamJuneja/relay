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
      if (isQuotedBothSides(m)) g.quotedButUntakenWindows++;
    }
    groups.set(key, g);
  }
  if (takersByGroup) for (const [k, g] of groups) g.uniqueTakers = takersByGroup.get(k)?.size ?? 0;
  return [...groups.values()];
}

const rowsOf = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? r : ((r as { rows?: Record<string, unknown>[] }).rows ?? []));

/**
 * The one definition of a quoted-but-untaken window.
 *
 * There were three copies of this: the daily rollup, the ad-hoc window endpoint, and
 * inline SQL behind /v1/stats/overview. Two of them read `orders` rows directly,
 * which stops meaning anything once orders age out of retention — a window older than
 * ORDER_RETENTION_DAYS has no order rows left and silently counts as never-quoted. On
 * the live site that put 34.5% in the headline KPI and 3.5% in the per-series table
 * directly beneath it. Everything now goes through here.
 */
export const isQuotedBothSides = (m: { restedBids: number; restedAsks: number }): boolean => m.restedBids > 0 && m.restedAsks > 0;

/**
 * Per-market rows for every completed window in a range, with the latched
 * had_bid/had_ask as the source of truth and the order rows only as a fallback for
 * markets ingested before the latches existed.
 *
 * `venueId` omitted means every venue, which is what the daily rollup wants.
 */
export async function marketsInRange(
  db: Db,
  opts: { venueId?: string | undefined; sinceSec: number; untilSec: number },
): Promise<MarketAgg[]> {
  const { venueId, sinceSec, untilSec } = opts;
  const q = await db.execute(sql`
    select m.market_id, m.venue_id, m.asset, m.interval_sec, m.expiry,
           coalesce(f.fills, 0)::int as fills,
           coalesce(f.notional, 0)::text as notional,
           coalesce(f.takers, 0)::int as takers,
           (m.had_bid or coalesce(o.rested_bids, 0) > 0) as had_bid,
           (m.had_ask or coalesce(o.rested_asks, 0) > 0) as had_ask
    from markets m
    left join lateral (
      select count(*) as fills, sum(notional) as notional, count(distinct taker_owner) as takers
      from fills where fills.market_id = m.market_id) f on true
    left join lateral (
      select count(*) filter (where is_bid and rested_qty is not null and rested_qty > 0) as rested_bids,
             count(*) filter (where not is_bid and rested_qty is not null and rested_qty > 0) as rested_asks
      from orders where orders.market_id = m.market_id) o on true
    where m.expiry >= ${sinceSec}::bigint and m.expiry <= ${untilSec}::bigint
      ${venueId ? sql`and m.venue_id = ${venueId.toLowerCase()}` : sql``}`);
  return rowsOf(q).map((r) => ({
    marketId: String(r.market_id),
    venueId: String(r.venue_id),
    asset: String(r.asset),
    intervalSec: Number(r.interval_sec),
    expiry: Number(r.expiry),
    fills: Number(r.fills),
    notional: BigInt(String(r.notional)),
    uniqueTakers: Number(r.takers),
    restedBids: r.had_bid ? 1 : 0,
    restedAsks: r.had_ask ? 1 : 0,
  }));
}

export interface WindowSummary {
  windows: number;
  zeroFillWindows: number;
  quotedButUntakenWindows: number;
  fills: number;
  notional: bigint;
}

/** Sum a set of market rows. Used for the venue total and for every series group. */
export function summarise(rows: MarketAgg[]): WindowSummary {
  const out: WindowSummary = { windows: 0, zeroFillWindows: 0, quotedButUntakenWindows: 0, fills: 0, notional: 0n };
  for (const m of rows) {
    out.windows++;
    out.fills += m.fills;
    out.notional += m.notional;
    if (m.fills === 0) {
      out.zeroFillWindows++;
      if (isQuotedBothSides(m)) out.quotedButUntakenWindows++;
    }
  }
  return out;
}


/** Recompute stats_venue_daily for windows that expired in the last `days` days. */
export async function computeVenueStats(db: Db, days = 3, nowSec = Math.floor(Date.now() / 1000)): Promise<number> {
  const since = nowSec - days * 86400;
  // Every venue, because this rollup is chain-wide. Same query, same predicate and
  // same latch fallback as the window endpoint and the venue total.
  const rows = await marketsInRange(db, { sinceSec: since, untilSec: nowSec });
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
  // Same rows, same predicate, same everything as the venue total and the daily
  // rollup — the three used to be three queries and drifted apart.
  const rows = await marketsInRange(db, { venueId, sinceSec: nowSec - hours * 3600, untilSec: nowSec });

  const groups = new Map<string, MarketAgg[]>();
  for (const m of rows) {
    const key = `${m.asset}|${m.intervalSec}`;
    const g = groups.get(key);
    if (g) g.push(m);
    else groups.set(key, [m]);
  }

  const out: VenueWindowRow[] = [];
  for (const [key, ms] of groups) {
    const [asset, intervalSec] = key.split("|");
    const sum = summarise(ms);
    out.push({
      asset: String(asset),
      intervalSec: Number(intervalSec),
      windows: sum.windows,
      zeroFillWindows: sum.zeroFillWindows,
      quotedButUntakenWindows: sum.quotedButUntakenWindows,
      fills: sum.fills,
      notional: sum.notional,
      uniqueTakers: 0,
    });
  }

  // Unique takers cannot be summed from per-market counts without double-counting a
  // wallet that traded several windows, so it is its own query.
  const tq = await db.execute(sql`
    select m.asset, m.interval_sec, count(distinct f.taker_owner)::int as takers
    from fills f join markets m on m.market_id = f.market_id
    where m.venue_id = ${venueId.toLowerCase()} and m.expiry >= ${nowSec - hours * 3600}::bigint and m.expiry <= ${nowSec}::bigint and f.taker_owner is not null
    group by m.asset, m.interval_sec`);
  const takers = new Map(rowsOf(tq).map((r) => [`${r.asset}|${Number(r.interval_sec)}`, Number(r.takers)]));
  for (const r of out) r.uniqueTakers = takers.get(`${r.asset}|${r.intervalSec}`) ?? 0;

  return out.sort((a, b) => a.asset.localeCompare(b.asset) || a.intervalSec - b.intervalSec);
}

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
