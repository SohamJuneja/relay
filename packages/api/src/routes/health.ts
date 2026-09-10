import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { coveredHours, cursor, historyKey } from "@relay/indexer";
import type { App } from "../app.js";
import type { ApiDeps } from "../deps.js";

export function registerHealth(app: App, deps: ApiDeps): void {
  app.get(
    "/health",
    {
      schema: {
        tags: ["health"],
        summary: "Indexer cursor vs chain head, DB connectivity",
        response: {
          200: z.object({
            ok: z.boolean(),
            network: z.string(),
            cursorBlock: z.number().nullable(),
            cursorHash: z.string().nullable(),
            headBlock: z.number(),
            lagBlocks: z.number().nullable(),
            lagSeconds: z.number().nullable(),
            lagLabel: z.string(),
            /** Lowest block the history walk has reached; null before it starts. */
            historyCursor: z.number().nullable(),
            /** The block it is walking down toward (head − BACKFILL_HOURS at start). */
            historyTarget: z.number().nullable(),
            /** Hours of history actually covered between the two cursors. */
            historyCoveredHours: z.number(),
            historyComplete: z.boolean(),
            dbOk: z.boolean(),
            cursorUpdatedAt: z.string().nullable(),
            ts: z.number(),
          }),
        },
      },
    },
    async () => {
      let dbOk = false;
      let cur: { lastBlock: bigint; lastBlockHash: string | null; updatedAt: Date } | null = null;
      let hist: { lastBlock: bigint; startBlock: bigint } | null = null;
      try {
        await deps.db.execute(sql`select 1`);
        dbOk = true;
        const r = await deps.db.select().from(cursor).where(eq(cursor.network, deps.cfg.network)).limit(1);
        cur = r[0] ?? null;
        // The history walk keeps its own row under a suffixed key.
        const h = await deps.db.select().from(cursor).where(eq(cursor.network, historyKey(deps.cfg.network))).limit(1);
        hist = h[0] ?? null;
      } catch {
        dbOk = false;
      }
      const head = Number(await deps.client.getBlockNumber());
      // The cursor and the head are read from two systems microseconds apart on a chain
      // with 100 ms blocks, so the cursor can legitimately come back ahead. A negative
      // lag is not a state the indexer can be in; it is a measurement artefact, and
      // "−6 blocks behind head" is not something any reader should have to interpret.
      const lag = cur ? Math.max(0, head - Number(cur.lastBlock)) : null;
      return {
        // Deliberately independent of the history walk. A service that is tailing the
        // head correctly is healthy whether it has two hours of history or twenty-four;
        // conflating the two is what made the keepalive alarm fire for hours on a
        // perfectly working deploy.
        ok: dbOk && cur !== null && (lag ?? 1e9) < 600,
        network: deps.cfg.network,
        cursorBlock: cur ? Number(cur.lastBlock) : null,
        cursorHash: cur?.lastBlockHash ?? null,
        headBlock: head,
        lagBlocks: lag,
        lagSeconds: lag === null ? null : Math.round(lag * 0.1 * 10) / 10,
        lagLabel: lag === null ? "unknown" : lag === 0 ? "at head" : `${lag} blocks behind`,
        historyCursor: hist ? Number(hist.lastBlock) : null,
        historyTarget: hist ? Number(hist.startBlock) : null,
        historyCoveredHours: Math.round(coveredHours(hist?.lastBlock ?? null, cur?.lastBlock ?? null) * 10) / 10,
        historyComplete: hist !== null && hist.lastBlock <= hist.startBlock,
        dbOk,
        cursorUpdatedAt: cur?.updatedAt?.toISOString() ?? null,
        ts: Math.floor(Date.now() / 1000),
      };
    },
  );
}
