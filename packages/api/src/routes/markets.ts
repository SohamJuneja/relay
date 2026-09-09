import { z } from "zod";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Address } from "viem";
import { fills, markets, orders } from "@relay/indexer";
import { ORDER_KIND_NAMES } from "@relay/core";
import type { App } from "../app.js";
import type { ApiDeps } from "../deps.js";
import { fillToApi, marketToApi, rowsOf } from "../format.js";
import { AddressZ, Book, Fill, Hex32, Market, Numeric, Price } from "../schemas.js";

const nowSec = () => Math.floor(Date.now() / 1000);

export function registerMarkets(app: App, deps: ApiDeps): void {
  // ── venues ──
  app.get(
    "/v1/venues",
    {
      schema: {
        tags: ["venues"],
        summary: "Per-venue summary (markets, live markets, assets, cadences, last-24h liquidity)",
        response: {
          200: z.array(
            z.object({
              venueId: Hex32,
              operatorIds: z.array(z.number()),
              markets: z.number(),
              liveMarkets: z.number(),
              assets: z.array(z.string()),
              cadencesSec: z.array(z.number()),
              firstExpiry: z.number().nullable(),
              lastExpiry: z.number().nullable(),
              last24h: z.object({ windows: z.number(), zeroFillWindows: z.number(), quotedButUntakenWindows: z.number(), fills: z.number(), notional: z.number() }),
              isDefault: z.boolean(),
            }),
          ),
        },
      },
    },
    async () => {
      const now = nowSec();
      const q = await deps.db.execute(sql`
        select venue_id, array_agg(distinct operator_id) as ops, count(*)::int as markets,
               count(*) filter (where status = 1 and expiry > ${now}) ::int as live,
               array_agg(distinct asset) as assets, array_agg(distinct interval_sec) as cadences,
               min(expiry)::bigint as first_expiry, max(expiry)::bigint as last_expiry
        from markets group by venue_id order by markets desc`);
      const s = await deps.db.execute(sql`
        select venue_id, sum(windows)::int as windows, sum(zero_fill_windows)::int as zero, sum(quoted_but_untaken_windows)::int as quoted,
               sum(fills)::int as fills, coalesce(sum(notional),0)::text as notional
        from stats_venue_daily where day >= (now() at time zone 'utc')::date - 1 group by venue_id`);
      const stats = new Map(rowsOf(s).map((r) => [String(r.venue_id), r]));
      const one = 10 ** deps.cfg.decimals;
      return rowsOf(q).map((r) => {
        const st = stats.get(String(r.venue_id));
        return {
          venueId: String(r.venue_id),
          operatorIds: (r.ops as number[]).map(Number),
          markets: Number(r.markets),
          liveMarkets: Number(r.live),
          assets: (r.assets as string[]).map(String),
          cadencesSec: (r.cadences as number[]).map(Number).sort((a, b) => a - b),
          firstExpiry: r.first_expiry === null ? null : Number(r.first_expiry),
          lastExpiry: r.last_expiry === null ? null : Number(r.last_expiry),
          last24h: {
            windows: Number(st?.windows ?? 0),
            zeroFillWindows: Number(st?.zero ?? 0),
            quotedButUntakenWindows: Number(st?.quoted ?? 0),
            fills: Number(st?.fills ?? 0),
            notional: Number(st?.notional ?? 0) / one,
          },
          isDefault: String(r.venue_id).toLowerCase() === deps.cfg.defaultVenueId,
        };
      });
    },
  );

  // ── live markets with book snapshot ──
  app.get(
    "/v1/markets/live",
    {
      schema: {
        tags: ["markets"],
        summary: "Trading markets (from the DB), each with a live book snapshot (RPC, cached 1 s)",
        querystring: z.object({
          venue: Hex32.optional(),
          asset: z.string().optional(),
          intervalSec: z.coerce.number().int().optional(),
          limit: z.coerce.number().int().min(1).max(100).default(50),
          book: z.enum(["true", "false"]).default("true"),
        }),
        response: { 200: z.array(Market.extend({ book: Book.nullable() })) },
      },
    },
    async (req) => {
      const now = nowSec();
      const q = req.query;
      const conds = [eq(markets.status, 1), gt(markets.expiry, BigInt(now))];
      conds.push(eq(markets.venueId, (q.venue ?? deps.cfg.defaultVenueId).toLowerCase()));
      if (q.asset) conds.push(eq(markets.asset, q.asset.toUpperCase()));
      if (q.intervalSec) conds.push(eq(markets.intervalSec, q.intervalSec));
      const rows = await deps.db.select().from(markets).where(and(...conds)).orderBy(markets.expiry).limit(q.limit);
      const books = q.book === "true" ? await Promise.all(rows.map((m) => deps.books.get(m.pool as Address, 10).catch(() => null))) : rows.map(() => null);
      return rows.map((m, i) => ({ ...marketToApi(m, now), book: books[i] ?? null }));
    },
  );

  // ── recently resolved ──
  app.get(
    "/v1/markets/recent",
    {
      schema: {
        tags: ["markets"],
        summary: "Recently resolved markets with winner and opening/closing price (the 'recently settled' strip)",
        querystring: z.object({
          venue: Hex32.optional(),
          asset: z.string().optional(),
          intervalSec: z.coerce.number().int().optional(),
          limit: z.coerce.number().int().min(1).max(200).default(20),
        }),
        response: { 200: z.array(Market.extend({ fills: z.number(), notional: z.number() })) },
      },
    },
    async (req) => {
      const now = nowSec();
      const q = req.query;
      const conds = [inArray(markets.status, [4, 5]), eq(markets.venueId, (q.venue ?? deps.cfg.defaultVenueId).toLowerCase())];
      if (q.asset) conds.push(eq(markets.asset, q.asset.toUpperCase()));
      if (q.intervalSec) conds.push(eq(markets.intervalSec, q.intervalSec));
      const rows = await deps.db.select().from(markets).where(and(...conds)).orderBy(desc(markets.expiry)).limit(q.limit);
      const ids = rows.map((r) => r.marketId);
      const agg = ids.length
        ? rowsOf(await deps.db.execute(sql`select market_id, count(*)::int as fills, coalesce(sum(notional),0)::text as notional from fills where market_id in ${ids} group by market_id`))
        : [];
      const byId = new Map(agg.map((a) => [String(a.market_id), a]));
      const one = 10 ** deps.cfg.decimals;
      return rows.map((m) => ({ ...marketToApi(m, now), fills: Number(byId.get(m.marketId)?.fills ?? 0), notional: Number(byId.get(m.marketId)?.notional ?? 0) / one }));
    },
  );

  // ── one market ──
  app.get(
    "/v1/markets/:marketId",
    {
      schema: {
        tags: ["markets"],
        summary: "One market: full row + fill count",
        params: z.object({ marketId: Hex32 }),
        response: { 200: Market.extend({ fills: z.number(), notional: z.number(), uniqueTakers: z.number(), openOrders: z.number() }), 404: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const now = nowSec();
      const m = (await deps.db.select().from(markets).where(eq(markets.marketId, req.params.marketId.toLowerCase())).limit(1))[0];
      if (!m) return reply.status(404).send({ error: "market_not_found" });
      const a = rowsOf(await deps.db.execute(sql`select count(*)::int as fills, coalesce(sum(notional),0)::text as notional, count(distinct taker_owner)::int as takers from fills where market_id = ${m.marketId}`))[0];
      const o = rowsOf(await deps.db.execute(sql`select count(*)::int as n from orders where market_id = ${m.marketId} and rested_qty is not null and rested_qty > 0 and not cancelled and not expired and filled_qty < quantity`))[0];
      return { ...marketToApi(m, now), fills: Number(a?.fills ?? 0), notional: Number(a?.notional ?? 0) / 10 ** deps.cfg.decimals, uniqueTakers: Number(a?.takers ?? 0), openOrders: Number(o?.n ?? 0) };
    },
  );

  app.get(
    "/v1/markets/:marketId/book",
    {
      schema: {
        tags: ["markets"],
        summary: "Live top-10 YES/NO levels from the pool (RPC, cached 1 s)",
        params: z.object({ marketId: Hex32 }),
        response: { 200: Book.extend({ marketId: Hex32, status: z.number() }), 404: z.object({ error: z.string() }), 502: z.object({ error: z.string() }) },
      },
    },
    async (req, reply) => {
      const m = (await deps.db.select().from(markets).where(eq(markets.marketId, req.params.marketId.toLowerCase())).limit(1))[0];
      if (!m) return reply.status(404).send({ error: "market_not_found" });
      const b = await deps.books.get(m.pool as Address, 10);
      if (!b) return reply.status(502).send({ error: "book_read_failed" });
      return { ...b, marketId: m.marketId, status: marketToApi(m, nowSec()).status };
    },
  );

  app.get(
    "/v1/markets/:marketId/fills",
    {
      schema: {
        tags: ["markets"],
        summary: "Fills on a market, newest first, with taker/maker attribution",
        params: z.object({ marketId: Hex32 }),
        querystring: z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) }),
        response: { 200: z.array(Fill) },
      },
    },
    async (req) => {
      const rows = await deps.db.select().from(fills).where(eq(fills.marketId, req.params.marketId.toLowerCase())).orderBy(desc(fills.block), desc(fills.logIndex)).limit(req.query.limit);
      return rows.map((f) => fillToApi(f, deps.cfg.decimals));
    },
  );

  // ── price ──
  app.get(
    "/v1/price/:asset",
    {
      schema: {
        tags: ["price"],
        summary: "Live underlying price from the Somnia testnet price feed (sampled every 2 s)",
        params: z.object({ asset: z.string() }),
        response: { 200: Price, 404: z.object({ error: z.string(), assets: z.array(z.string()) }) },
      },
    },
    async (req, reply) => {
      const p = deps.ticker.get(req.params.asset);
      if (!p) return reply.status(404).send({ error: "no_price_yet", assets: deps.cfg.priceAssets });
      return p;
    },
  );

  // ── orders ──
  app.get(
    "/v1/orders/:orderId",
    {
      schema: {
        tags: ["orders"],
        summary: "An order by its on-chain id (ids are unique per pool; pass ?pool to disambiguate)",
        params: z.object({ orderId: Numeric }),
        querystring: z.object({ pool: AddressZ.optional() }),
        response: {
          200: z.array(
            z.object({
              pool: AddressZ,
              orderId: Numeric,
              marketId: Hex32.nullable(),
              owner: AddressZ,
              isBid: z.boolean(),
              kind: z.number().nullable(),
              side: z.string().nullable(),
              price: z.number(),
              priceRaw: Numeric,
              quantity: z.number(),
              quantityRaw: Numeric,
              filledQty: z.number(),
              restedQty: z.number().nullable(),
              cancelled: z.boolean(),
              expired: z.boolean(),
              userData: Numeric,
              tagVersion: z.number(),
              partnerId: z.number().nullable(),
              surfaceId: z.number().nullable(),
              builder: AddressZ.nullable(),
              expireNs: Numeric,
              placedBlock: z.number(),
              placedTs: z.number(),
              txHash: z.string(),
            }),
          ),
        },
      },
    },
    async (req) => {
      const conds = [eq(orders.orderId, req.params.orderId)];
      if (req.query.pool) conds.push(eq(orders.pool, req.query.pool.toLowerCase()));
      const rows = await deps.db.select().from(orders).where(and(...conds)).limit(10);
      const one = 10 ** deps.cfg.decimals;
      return rows.map((o) => ({
        pool: o.pool,
        orderId: o.orderId,
        marketId: o.marketId ?? null,
        owner: o.owner,
        isBid: o.isBid,
        kind: o.kind ?? null,
        side: o.kind === null ? null : (ORDER_KIND_NAMES[o.kind] ?? null),
        price: Number(o.price) / one,
        priceRaw: o.price,
        quantity: Number(o.quantity) / one,
        quantityRaw: o.quantity,
        filledQty: Number(o.filledQty) / one,
        restedQty: o.restedQty === null ? null : Number(o.restedQty) / one,
        cancelled: o.cancelled,
        expired: o.expired,
        userData: o.userData,
        tagVersion: o.tagVersion,
        partnerId: o.partnerId ?? null,
        surfaceId: o.surfaceId ?? null,
        builder: o.builder ?? null,
        expireNs: o.expireNs,
        placedBlock: Number(o.placedBlock),
        placedTs: Number(o.placedTs),
        txHash: o.txHash,
      }));
    },
  );
}
