// The endpoints the partner console and the public ecosystem page are built from.
//
// Everything here reads the same chain-derived tables the rest of the API does; none
// of it depends on the DreamDEX indexer. Two shapes recur:
//   · partner-scoped and key-gated (breakdown, share) — what one partner routed;
//   · venue-scoped and public (builders, hourly, overview) — what the whole venue did.
//
// Percentages are computed here rather than in the client so every surface reports
// the same number, and every notional is divided by the collateral unit exactly once.

import { createHash } from "node:crypto";
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { partners } from "@relay/indexer";
import { SURFACE } from "@relay/core";
import type { App } from "../app.js";
import type { ApiDeps } from "../deps.js";
import { rowsOf } from "../format.js";
import { AddressZ, Hex32 } from "../schemas.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

const SURFACE_NAME: Record<number, string> = Object.fromEntries(Object.entries(SURFACE).map(([k, v]) => [v as number, k.toLowerCase()]));

const BreakdownRow = z.object({ fills: z.number(), notional: z.number() });
const BySurface = BreakdownRow.extend({ surfaceId: z.number(), name: z.string() });
const BySeries = BreakdownRow.extend({ asset: z.string(), intervalSec: z.number() });
const ByDay = BreakdownRow.extend({ day: z.string(), uniqueWallets: z.number() });
const ByHour = BreakdownRow.extend({ hourTs: z.number(), uniqueWallets: z.number() });

const BuilderRow = z.object({
  builder: AddressZ,
  fills: z.number(),
  notional: z.number(),
  wallets: z.number(),
  firstSeen: z.number(),
  lastSeen: z.number(),
  partnerName: z.string().nullable(),
  partnerId: z.number().nullable(),
  verified: z.boolean(),
});

const HourlyRow = z.object({
  hourTs: z.number(),
  fills: z.number(),
  notional: z.number(),
  uniqueTakers: z.number(),
  quotedButUntakenWindows: z.number(),
});

export function registerInsights(app: App, deps: ApiDeps): void {
  const one = 10 ** deps.cfg.decimals;
  const num = (v: unknown): number => Number(v ?? 0);
  const money = (v: unknown): number => num(v) / one;

  const requireKey = async (partnerId: number, key: string | undefined) => {
    if (!key) return null;
    const p = (await deps.db.select().from(partners).where(eq(partners.partnerId, partnerId)).limit(1))[0];
    if (!p) return null;
    return p.apiKeyHash === sha256(key) ? p : null;
  };

  // ── partner breakdown ────────────────────────────────────────────────────
  app.get(
    "/v1/partners/:partnerId/breakdown",
    {
      schema: {
        tags: ["partners"],
        summary: "Where a partner's flow came from: by surface, by series, by day (x-api-key)",
        description:
          "Taker-side fills attributed to this partner on this venue over the window, split three ways. " +
          "`bySurface` is the surface id encoded in userData at order time; `bySeries` is the asset and cadence; " +
          "`byDay` is UTC days. Notionals are collateral units.",
        security: [{ apiKey: [] }],
        params: z.object({ partnerId: z.coerce.number().int() }),
        querystring: z.object({ hours: z.coerce.number().int().min(1).max(24 * 90).default(24), venue: Hex32.optional() }),
        response: {
          200: z.object({
            partnerId: z.number(),
            hours: z.number(),
            venueId: Hex32,
            since: z.number(),
            bySurface: z.array(BySurface),
            bySeries: z.array(BySeries),
            byDay: z.array(ByDay),
            byHour: z.array(ByHour),
          }),
          401: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const p = await requireKey(req.params.partnerId, req.headers["x-api-key"] as string | undefined);
      if (!p) return reply.status(401).send({ error: "unauthorized" });
      const since = Math.floor(Date.now() / 1000) - req.query.hours * 3600;
      const venueId = (req.query.venue ?? deps.cfg.defaultVenueId).toLowerCase();

      // All three splits join markets and scope to the venue. They are three views of
      // ONE set of fills, so they have to be filtered identically — a surface total
      // that silently included another venue would not add up to the series total
      // beside it, and the reader has no way to tell which panel is lying.
      const [surfaceQ, seriesQ, dayQ, hourQ] = await Promise.all([
        deps.db.execute(sql`
          select coalesce(f.taker_surface_id, 0) as surface_id, count(*)::int as fills, coalesce(sum(f.notional),0)::text as notional
          from fills f join markets m on m.market_id = f.market_id
          where f.taker_partner_id = ${p.partnerId} and f.block_ts >= ${since}::bigint and m.venue_id = ${venueId}
          group by 1 order by 3 desc`),
        deps.db.execute(sql`
          select m.asset, m.interval_sec, count(*)::int as fills, coalesce(sum(f.notional),0)::text as notional
          from fills f join markets m on m.market_id = f.market_id
          where f.taker_partner_id = ${p.partnerId} and f.block_ts >= ${since}::bigint and m.venue_id = ${venueId}
          group by 1, 2 order by 4 desc`),
        deps.db.execute(sql`
          select to_char(to_timestamp(f.block_ts) at time zone 'utc', 'YYYY-MM-DD') as day,
                 count(*)::int as fills, coalesce(sum(f.notional),0)::text as notional,
                 count(distinct f.taker_owner)::int as wallets
          from fills f join markets m on m.market_id = f.market_id
          where f.taker_partner_id = ${p.partnerId} and f.block_ts >= ${since}::bigint and m.venue_id = ${venueId}
          group by 1 order by 1`),
        // Hourly, computed live from the same fills as the other three splits. The
        // materialised stats table only refreshes once a minute, so a brand-new
        // partner's chart said "no fills in this window" beside a KPI reading 1 —
        // two panels disagreeing about the same fact.
        deps.db.execute(sql`
          select (f.block_ts / 3600)::bigint * 3600 as hour_ts,
                 count(*)::int as fills, coalesce(sum(f.notional),0)::text as notional,
                 count(distinct f.taker_owner)::int as wallets
          from fills f join markets m on m.market_id = f.market_id
          where f.taker_partner_id = ${p.partnerId} and f.block_ts >= ${since}::bigint and m.venue_id = ${venueId}
          group by 1 order by 1`),
      ]);

      return {
        partnerId: p.partnerId,
        hours: req.query.hours,
        venueId,
        since,
        bySurface: rowsOf(surfaceQ).map((r) => ({
          surfaceId: num(r.surface_id),
          name: SURFACE_NAME[num(r.surface_id)] ?? `surface ${num(r.surface_id)}`,
          fills: num(r.fills),
          notional: money(r.notional),
        })),
        bySeries: rowsOf(seriesQ).map((r) => ({ asset: String(r.asset), intervalSec: num(r.interval_sec), fills: num(r.fills), notional: money(r.notional) })),
        byDay: rowsOf(dayQ).map((r) => ({ day: String(r.day), fills: num(r.fills), notional: money(r.notional), uniqueWallets: num(r.wallets) })),
        byHour: rowsOf(hourQ).map((r) => ({ hourTs: num(r.hour_ts), fills: num(r.fills), notional: money(r.notional), uniqueWallets: num(r.wallets) })),
      };
    },
  );

  // ── share of venue flow ──────────────────────────────────────────────────
  app.get(
    "/v1/partners/:partnerId/share",
    {
      schema: {
        tags: ["partners"],
        summary: "This partner's taker notional as a share of the whole venue's, over the window (x-api-key)",
        description:
          "The denominator is EVERY taker fill on the venue in the window, tagged or not — including flow that never touched Relay. " +
          "That is the honest denominator for 'how much of this venue do we bring', and it is why the number starts small.",
        security: [{ apiKey: [] }],
        params: z.object({ partnerId: z.coerce.number().int() }),
        querystring: z.object({ hours: z.coerce.number().int().min(1).max(24 * 90).default(24), venue: Hex32.optional() }),
        response: {
          200: z.object({
            partnerId: z.number(),
            venueId: Hex32,
            hours: z.number(),
            partnerNotional: z.number(),
            venueNotional: z.number(),
            sharePct: z.number().nullable(),
            partnerFills: z.number(),
            venueFills: z.number(),
          }),
          401: z.object({ error: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const p = await requireKey(req.params.partnerId, req.headers["x-api-key"] as string | undefined);
      if (!p) return reply.status(401).send({ error: "unauthorized" });
      const venueId = (req.query.venue ?? deps.cfg.defaultVenueId).toLowerCase();
      const since = Math.floor(Date.now() / 1000) - req.query.hours * 3600;
      const r = rowsOf(
        await deps.db.execute(sql`
          select
            coalesce(sum(f.notional) filter (where f.taker_partner_id = ${p.partnerId}), 0)::text as partner_notional,
            count(*) filter (where f.taker_partner_id = ${p.partnerId})::int as partner_fills,
            coalesce(sum(f.notional), 0)::text as venue_notional,
            count(*)::int as venue_fills
          from fills f join markets m on m.market_id = f.market_id
          where m.venue_id = ${venueId} and f.block_ts >= ${since}::bigint`),
      )[0];
      const partnerNotional = money(r?.partner_notional);
      const venueNotional = money(r?.venue_notional);
      return {
        partnerId: p.partnerId,
        venueId,
        hours: req.query.hours,
        partnerNotional,
        venueNotional,
        // No flow at all is "no answer", not "zero per cent" — a 0.0% share would
        // read as "we brought none of it" when nobody brought any.
        //
        // Four decimals, not two: a partner routing $2.71 into a $121,000 venue has a
        // real share of 0.0022%, and two decimals rounds that to a flat zero — the API
        // would be telling a partner with live flow that they brought nothing. The
        // client decides how many of these digits to show; the API's job is to have
        // them.
        sharePct: venueNotional === 0 ? null : Math.round((1e6 * partnerNotional) / venueNotional) / 1e4,
        partnerFills: num(r?.partner_fills),
        venueFills: num(r?.venue_fills),
      };
    },
  );

  // ── builder leaderboard ──────────────────────────────────────────────────
  app.get(
    "/v1/stats/builders",
    {
      schema: {
        tags: ["stats"],
        summary: "Every builder address seen on a fill, with the flow it carried",
        description:
          "One row per distinct builder code observed in the window. `partnerName` is filled when the address matches a registered Relay partner; " +
          "unregistered builders are shown too, because the point of the table is who is routing flow, not who has signed up.",
        querystring: z.object({ hours: z.coerce.number().int().min(1).max(24 * 90).default(24), venue: Hex32.optional() }),
        response: { 200: z.object({ hours: z.number(), venueId: Hex32, builders: z.array(BuilderRow) }) },
      },
    },
    async (req) => {
      const venueId = (req.query.venue ?? deps.cfg.defaultVenueId).toLowerCase();
      const since = Math.floor(Date.now() / 1000) - req.query.hours * 3600;
      const q = await deps.db.execute(sql`
        select f.taker_builder as builder,
               count(*)::int as fills,
               coalesce(sum(f.notional),0)::text as notional,
               count(distinct f.taker_owner)::int as wallets,
               min(f.block_ts)::bigint as first_seen,
               max(f.block_ts)::bigint as last_seen,
               max(p.name) as partner_name,
               max(p.partner_id)::int as partner_id,
               bool_or(coalesce(p.verified, false)) as verified
        from fills f
        join markets m on m.market_id = f.market_id
        left join partners p on lower(p.builder_address) = lower(f.taker_builder)
        where m.venue_id = ${venueId} and f.block_ts >= ${since}::bigint
          and f.taker_builder is not null
          and f.taker_builder <> '0x0000000000000000000000000000000000000000'
        group by 1 order by 3 desc`);
      return {
        hours: req.query.hours,
        venueId,
        builders: rowsOf(q).map((r) => ({
          builder: String(r.builder),
          fills: num(r.fills),
          notional: money(r.notional),
          wallets: num(r.wallets),
          firstSeen: num(r.first_seen),
          lastSeen: num(r.last_seen),
          partnerName: r.partner_name === null || r.partner_name === undefined ? null : String(r.partner_name),
          partnerId: r.partner_id === null || r.partner_id === undefined ? null : num(r.partner_id),
          verified: r.verified === true,
        })),
      };
    },
  );

  // ── venue hourly ─────────────────────────────────────────────────────────
  app.get(
    "/v1/stats/venue/:venueId/hourly",
    {
      schema: {
        tags: ["stats"],
        summary: "Per-hour fills, notional, unique takers and quoted-but-untaken windows",
        description:
          "Hours with no activity are returned as zero rows rather than omitted, so a chart drawn straight from this has no invisible gaps. " +
          "A quoted-but-untaken window is a completed window that had resting liquidity on both sides and no fill; it is counted in the hour the window expired.",
        params: z.object({ venueId: Hex32 }),
        querystring: z.object({ hours: z.coerce.number().int().min(1).max(24 * 14).default(24) }),
        response: { 200: z.object({ venueId: Hex32, hours: z.number(), rows: z.array(HourlyRow) }) },
      },
    },
    async (req) => {
      const venueId = req.params.venueId.toLowerCase();
      const hours = req.query.hours;
      const nowHour = Math.floor(Date.now() / 3600_000) * 3600;
      const since = nowHour - (hours - 1) * 3600;

      const [fillQ, untakenQ] = await Promise.all([
        deps.db.execute(sql`
          select (f.block_ts / 3600)::bigint * 3600 as hour_ts,
                 count(*)::int as fills,
                 coalesce(sum(f.notional),0)::text as notional,
                 count(distinct f.taker_owner)::int as takers
          from fills f join markets m on m.market_id = f.market_id
          where m.venue_id = ${venueId} and f.block_ts >= ${since}::bigint
          group by 1`),
        deps.db.execute(sql`
          select (m.expiry / 3600)::bigint * 3600 as hour_ts, count(*)::int as untaken
          from markets m
          where m.venue_id = ${venueId} and m.expiry >= ${since}::bigint and m.expiry <= ${nowHour + 3599}::bigint
            and not exists (select 1 from fills f where f.market_id = m.market_id)
            and m.had_bid and m.had_ask
          group by 1`),
      ]);

      const byHour = new Map<number, { fills: number; notional: number; uniqueTakers: number; quotedButUntakenWindows: number }>();
      for (let h = since; h <= nowHour; h += 3600) byHour.set(h, { fills: 0, notional: 0, uniqueTakers: 0, quotedButUntakenWindows: 0 });
      for (const r of rowsOf(fillQ)) {
        const slot = byHour.get(num(r.hour_ts));
        if (!slot) continue;
        slot.fills = num(r.fills);
        slot.notional = money(r.notional);
        slot.uniqueTakers = num(r.takers);
      }
      for (const r of rowsOf(untakenQ)) {
        const slot = byHour.get(num(r.hour_ts));
        if (slot) slot.quotedButUntakenWindows = num(r.untaken);
      }
      return { venueId, hours, rows: [...byHour.entries()].map(([hourTs, v]) => ({ hourTs, ...v })).sort((a, b) => a.hourTs - b.hourTs) };
    },
  );

  // ── venue overview, cached ───────────────────────────────────────────────
  //
  // The ecosystem page's header. It is the most-hit endpoint on the site and every
  // field is a full-table aggregate, so it is computed at most once every 10 s and
  // shared by every caller — including the ones that arrive during the computation.
  const OVERVIEW_TTL_MS = 10_000;

  const computeOverview = async () => {
    const venueId = deps.cfg.defaultVenueId.toLowerCase();
    const since = Math.floor(Date.now() / 1000) - 24 * 3600;
    const [head, agg, windows, live, cursor, history] = await Promise.all([
      deps.client.getBlockNumber(),
      deps.db.execute(sql`
        select count(*)::int as fills, coalesce(sum(f.notional),0)::text as notional, count(distinct f.taker_owner)::int as takers
        from fills f join markets m on m.market_id = f.market_id
        where m.venue_id = ${venueId} and f.block_ts >= ${since}::bigint`),
      deps.db.execute(sql`
        select count(*)::int as markets,
               count(*) filter (where not exists (select 1 from fills f where f.market_id = m.market_id))::int as zero_fill,
               count(*) filter (
                 where not exists (select 1 from fills f where f.market_id = m.market_id)
                   and m.had_bid and m.had_ask
               )::int as untaken
        from markets m
        where m.venue_id = ${venueId} and m.expiry >= ${since}::bigint and m.expiry <= ${Math.floor(Date.now() / 1000)}::bigint`),
      deps.db.execute(sql`select count(*)::int as live from markets where venue_id = ${venueId} and status = 1 and expiry > ${Math.floor(Date.now() / 1000)}::bigint`),
      // Filtered by network, not `limit 1`. There are two cursor rows now — the live
      // one and the history walk's — and an unfiltered pick returns whichever the
      // planner happens to hand back.
      deps.db.execute(sql`select last_block from cursor where network = ${deps.cfg.network}`),
      deps.db.execute(sql`select last_block, start_block from cursor where network = ${`${deps.cfg.network}:history`}`),
    ]);
    const a = rowsOf(agg)[0];
    const w = rowsOf(windows)[0];
    const markets24h = num(w?.markets);
    const pct = (n: number, d: number) => (d === 0 ? null : Math.round((1000 * n) / d) / 10);
    const cursorBlock = Number(rowsOf(cursor)[0]?.last_block ?? 0) || null;
    const histRow = rowsOf(history)[0];
    const histLowest = histRow ? Number(histRow.last_block) : null;
    // 100 ms blocks: an hour is 36 000 of them.
    const historyHours =
      histLowest === null || cursorBlock === null ? 0 : Math.max(0, Math.round(((cursorBlock - histLowest) / 36_000) * 10) / 10);
    return {
      venueId,
      markets24h,
      fills24h: num(a?.fills),
      notional24h: money(a?.notional),
      uniqueTakers24h: num(a?.takers),
      zeroFillPct24h: pct(num(w?.zero_fill), markets24h),
      quotedButUntakenPct24h: pct(num(w?.untaken), markets24h),
      liveMarkets: num(rowsOf(live)[0]?.live),
      cursorBlock,
      headBlock: Number(head),
      // The head and the cursor are read from two different systems microseconds
      // apart on a chain with 100 ms blocks, so the cursor can legitimately appear
      // ahead. "-6 blocks behind head" is not a thing a reader should ever see.
      lagBlocks: cursorBlock === null ? null : Math.max(0, Number(head) - cursorBlock),
      // How much of the 24 hours these totals claim to cover is actually indexed.
      // Without it a reader cannot tell a quiet venue from a half-loaded one, and the
      // percentages above look authoritative either way.
      historyCoveredHours: historyHours,
      historyComplete: historyHours >= 24,
      computedAt: new Date().toISOString(),
    };
  };

  // Typed from the computation itself, so the cache cannot drift from the schema.
  let overview: { at: number; value: ReturnType<typeof computeOverview> } | null = null;

  app.get(
    "/v1/stats/overview",
    {
      schema: {
        tags: ["stats"],
        summary: "Headline totals for the DreamDEX venue over 24 h, plus indexer lag (cached 10 s)",
        description:
          "Every field is scoped to the venue this API is configured for. `zeroFillPct24h` counts completed windows with no fill; " +
          "`quotedButUntakenPct24h` is the subset of those that had resting liquidity on both sides — offered and refused, which is the more interesting number.",
        response: {
          200: z.object({
            venueId: Hex32,
            markets24h: z.number(),
            fills24h: z.number(),
            notional24h: z.number(),
            uniqueTakers24h: z.number(),
            zeroFillPct24h: z.number().nullable(),
            quotedButUntakenPct24h: z.number().nullable(),
            liveMarkets: z.number(),
            cursorBlock: z.number().nullable(),
            headBlock: z.number(),
            lagBlocks: z.number().nullable(),
            historyCoveredHours: z.number(),
            historyComplete: z.boolean(),
            computedAt: z.string(),
          }),
        },
      },
    },
    async () => {
      const now = Date.now();
      if (!overview || now - overview.at > OVERVIEW_TTL_MS) {
        const value = computeOverview();
        overview = { at: now, value };
        // A failed computation must not be cached for 10 s, or one blip becomes a
        // ten-second outage for every visitor.
        value.catch(() => {
          if (overview?.value === value) overview = null;
        });
      }
      return overview.value;
    },
  );
}
