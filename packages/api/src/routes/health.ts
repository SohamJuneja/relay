import { z } from "zod";
import { eq, sql } from "drizzle-orm";
import { cursor } from "@relay/indexer";
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
      try {
        await deps.db.execute(sql`select 1`);
        dbOk = true;
        const r = await deps.db.select().from(cursor).where(eq(cursor.network, deps.cfg.network)).limit(1);
        cur = r[0] ?? null;
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
        ok: dbOk && cur !== null && (lag ?? 1e9) < 600,
        network: deps.cfg.network,
        cursorBlock: cur ? Number(cur.lastBlock) : null,
        cursorHash: cur?.lastBlockHash ?? null,
        headBlock: head,
        lagBlocks: lag,
        lagSeconds: lag === null ? null : Math.round(lag * 0.1 * 10) / 10,
        lagLabel: lag === null ? "unknown" : lag === 0 ? "at head" : `${lag} blocks behind`,
        dbOk,
        cursorUpdatedAt: cur?.updatedAt?.toISOString() ?? null,
        ts: Math.floor(Date.now() / 1000),
      };
    },
  );
}
