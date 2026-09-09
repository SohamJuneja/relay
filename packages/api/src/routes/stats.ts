import { z } from "zod";
import { sql } from "drizzle-orm";
import { computeVenueWindow } from "@relay/indexer";
import type { App } from "../app.js";
import type { ApiDeps } from "../deps.js";
import { rowsOf } from "../format.js";
import { Hex32, VenueStatsRow } from "../schemas.js";

export function registerStats(app: App, deps: ApiDeps): void {
  app.get(
    "/v1/stats/venue/:venueId/window",
    {
      schema: {
        tags: ["stats"],
        summary: "Live zero-fill / quoted-but-untaken over the last N hours per series (computed on request, not materialised)",
        params: z.object({ venueId: Hex32 }),
        querystring: z.object({ hours: z.coerce.number().min(0.5).max(24 * 7).default(6) }),
        response: {
          200: z.object({
            venueId: Hex32,
            hours: z.number(),
            computedAt: z.string(),
            rows: z.array(VenueStatsRow.omit({ day: true })),
            total: VenueStatsRow.omit({ day: true, asset: true, intervalSec: true }),
          }),
        },
      },
    },
    async (req) => {
      const one = 10 ** deps.cfg.decimals;
      const pct = (n: number, d: number) => (d === 0 ? null : Math.round((1000 * n) / d) / 10);
      const rows = await computeVenueWindow(deps.db, req.params.venueId, req.query.hours);
      const out = rows.map((r) => ({
        asset: r.asset,
        intervalSec: r.intervalSec,
        windows: r.windows,
        zeroFillWindows: r.zeroFillWindows,
        quotedButUntakenWindows: r.quotedButUntakenWindows,
        fills: r.fills,
        notional: Number(r.notional) / one,
        uniqueTakers: r.uniqueTakers,
        zeroFillPct: pct(r.zeroFillWindows, r.windows),
        quotedButUntakenPct: pct(r.quotedButUntakenWindows, r.windows),
      }));
      const t = out.reduce(
        (acc, r) => ({ windows: acc.windows + r.windows, zeroFillWindows: acc.zeroFillWindows + r.zeroFillWindows, quotedButUntakenWindows: acc.quotedButUntakenWindows + r.quotedButUntakenWindows, fills: acc.fills + r.fills, notional: acc.notional + r.notional, uniqueTakers: Math.max(acc.uniqueTakers, r.uniqueTakers) }),
        { windows: 0, zeroFillWindows: 0, quotedButUntakenWindows: 0, fills: 0, notional: 0, uniqueTakers: 0 },
      );
      return {
        venueId: req.params.venueId.toLowerCase(),
        hours: req.query.hours,
        computedAt: new Date().toISOString(),
        rows: out,
        total: { ...t, zeroFillPct: pct(t.zeroFillWindows, t.windows), quotedButUntakenPct: pct(t.quotedButUntakenWindows, t.windows) },
      };
    },
  );

  app.get(
    "/v1/stats/venue/:venueId",
    {
      schema: {
        tags: ["stats"],
        summary: "Zero-fill / quoted-but-untaken table per series and day (completed windows only)",
        params: z.object({ venueId: Hex32 }),
        querystring: z.object({ days: z.coerce.number().int().min(1).max(30).default(2) }),
        response: {
          200: z.object({
            venueId: Hex32,
            days: z.number(),
            computedAt: z.string().nullable(),
            definitions: z.object({ zeroFillWindow: z.string(), quotedButUntakenWindow: z.string() }),
            totals: z.array(VenueStatsRow.omit({ day: true })),
            daily: z.array(VenueStatsRow),
          }),
        },
      },
    },
    async (req) => {
      const venueId = req.params.venueId.toLowerCase();
      const days = req.query.days;
      const one = 10 ** deps.cfg.decimals;
      const q = await deps.db.execute(sql`
        select asset, interval_sec, to_char(day, 'YYYY-MM-DD') as day, windows, zero_fill_windows, quoted_but_untaken_windows, fills, notional::text as notional, unique_takers, computed_at
        from stats_venue_daily where venue_id = ${venueId} and day >= (now() at time zone 'utc')::date - ${days - 1}::int
        order by asset, interval_sec, day`);
      const rows = rowsOf(q);
      const pct = (n: number, d: number) => (d === 0 ? null : Math.round((1000 * n) / d) / 10);
      const daily = rows.map((r) => {
        const w = Number(r.windows);
        return {
          asset: String(r.asset),
          intervalSec: Number(r.interval_sec),
          day: String(r.day),
          windows: w,
          zeroFillWindows: Number(r.zero_fill_windows),
          quotedButUntakenWindows: Number(r.quoted_but_untaken_windows),
          fills: Number(r.fills),
          notional: Number(r.notional) / one,
          uniqueTakers: Number(r.unique_takers),
          zeroFillPct: pct(Number(r.zero_fill_windows), w),
          quotedButUntakenPct: pct(Number(r.quoted_but_untaken_windows), w),
        };
      });
      const tot = new Map<string, (typeof daily)[number]>();
      for (const d of daily) {
        const k = `${d.asset}|${d.intervalSec}`;
        const t = tot.get(k) ?? { ...d, windows: 0, zeroFillWindows: 0, quotedButUntakenWindows: 0, fills: 0, notional: 0, uniqueTakers: 0 };
        t.windows += d.windows;
        t.zeroFillWindows += d.zeroFillWindows;
        t.quotedButUntakenWindows += d.quotedButUntakenWindows;
        t.fills += d.fills;
        t.notional += d.notional;
        t.uniqueTakers = Math.max(t.uniqueTakers, d.uniqueTakers);
        tot.set(k, t);
      }
      const totals = [...tot.values()].map((t) => ({
        ...t,
        zeroFillPct: pct(t.zeroFillWindows, t.windows),
        quotedButUntakenPct: pct(t.quotedButUntakenWindows, t.windows),
      })).map(({ day: _d, ...rest }) => rest);
      const computedAt = rows.length ? new Date(String(rows[0]!.computed_at)).toISOString() : null;
      return {
        venueId,
        days,
        computedAt,
        definitions: {
          zeroFillWindow: "a completed window (expiry passed) with zero OrderFilled events",
          quotedButUntakenWindow: "a zero-fill window that had at least one resting bid AND one resting ask (OrderRested on both sides): liquidity was offered, nobody took it",
        },
        totals,
        daily,
      };
    },
  );
}
