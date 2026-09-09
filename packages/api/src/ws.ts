// WS /v1/stream — fan-out of market lifecycle, fills, books and price.
// Everything is derived from the DB (polled) and the RPC (books), so the API
// never depends on the indexer process directly.

import type { WebSocket } from "ws";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import type { Address } from "viem";
import { fills, markets, partners } from "@relay/indexer";
import type { App } from "./app.js";
import type { ApiDeps } from "./deps.js";
import { fillToApi, marketToApi, rowsOf } from "./format.js";

interface Client {
  socket: WebSocket;
  all: boolean;
  markets: Set<string>;
}

export function registerStream(app: App, deps: ApiDeps): void {
  const clients = new Set<Client>();
  const send = (c: Client, type: string, data: unknown) => {
    if (c.socket.readyState !== 1) return;
    c.socket.send(JSON.stringify({ type, ts: Date.now(), data }));
  };
  const wants = (c: Client, marketId: string | null) => c.all || (marketId !== null && c.markets.has(marketId.toLowerCase()));
  const broadcast = (type: string, marketId: string | null, data: unknown) => {
    for (const c of clients) if (wants(c, marketId)) send(c, type, data);
  };

  app.get("/v1/stream", { websocket: true, schema: { hide: true } }, (socket: WebSocket) => {
    const c: Client = { socket, all: false, markets: new Set() };
    clients.add(c);
    send(c, "hello", { network: deps.cfg.network, defaultVenue: deps.cfg.defaultVenueId, events: ["market_created", "book", "fill", "market_locked", "market_resolved", "price"], usage: { subscribe: { all: true } } });
    socket.on("message", (raw: Buffer | string) => {
      try {
        const msg = JSON.parse(String(raw)) as { subscribe?: { all?: boolean; markets?: string[] }; unsubscribe?: { markets?: string[] }; ping?: boolean };
        if (msg.subscribe) {
          if (msg.subscribe.all) c.all = true;
          for (const m of msg.subscribe.markets ?? []) c.markets.add(m.toLowerCase());
          send(c, "subscribed", { all: c.all, markets: [...c.markets] });
        }
        if (msg.unsubscribe) {
          for (const m of msg.unsubscribe.markets ?? []) c.markets.delete(m.toLowerCase());
          send(c, "subscribed", { all: c.all, markets: [...c.markets] });
        }
        if (msg.ping) send(c, "pong", {});
      } catch {
        send(c, "error", { message: "invalid JSON" });
      }
    });
    socket.on("close", () => clients.delete(c));
    socket.on("error", () => clients.delete(c));
  });

  // ── pollers (only run while someone is connected) ──
  let lastFillId: number | null = null;
  let lastCreatedBlock: bigint | null = null;
  let lastResolvedBlock: bigint | null = null;
  const lockedAnnounced = new Set<string>();
  const partnerNames = new Map<number, string>();

  const fillsTick = async () => {
    if (lastFillId === null) {
      const r = rowsOf(await deps.db.execute(sql`select coalesce(max(id),0)::int as id from fills`))[0];
      lastFillId = Number(r?.id ?? 0);
      return;
    }
    if (clients.size === 0) return;
    const rows = await deps.db.select().from(fills).where(gt(fills.id, lastFillId)).orderBy(fills.id).limit(500);
    if (rows.length === 0) return;
    lastFillId = rows[rows.length - 1]!.id;
    const pids = [...new Set(rows.map((r) => r.takerPartnerId).filter((x): x is number => x !== null && !partnerNames.has(x)))];
    if (pids.length) for (const p of await deps.db.select().from(partners).where(inArray(partners.partnerId, pids))) partnerNames.set(p.partnerId, p.name);
    for (const f of rows) {
      const out = fillToApi(f, deps.cfg.decimals);
      broadcast("fill", f.marketId, { ...out, takerPartnerName: f.takerPartnerId === null ? null : (partnerNames.get(f.takerPartnerId) ?? null) });
    }
  };

  const marketsTick = async () => {
    const now = Math.floor(Date.now() / 1000);
    if (lastCreatedBlock === null || lastResolvedBlock === null) {
      const r = rowsOf(await deps.db.execute(sql`select coalesce(max(created_block),0)::bigint as c, coalesce(max(resolved_block),0)::bigint as r from markets`))[0];
      lastCreatedBlock = BigInt(String(r?.c ?? 0));
      lastResolvedBlock = BigInt(String(r?.r ?? 0));
      const live = await deps.db.select({ id: markets.marketId }).from(markets).where(and(eq(markets.status, 1), gt(markets.expiry, BigInt(now))));
      for (const m of live) lockedAnnounced.delete(m.id);
      return;
    }
    if (clients.size === 0) return;
    const created = await deps.db.select().from(markets).where(gt(markets.createdBlock, lastCreatedBlock)).orderBy(markets.createdBlock).limit(200);
    for (const m of created) {
      lastCreatedBlock = m.createdBlock > lastCreatedBlock ? m.createdBlock : lastCreatedBlock;
      broadcast("market_created", m.marketId, marketToApi(m, now));
    }
    const justLocked = await deps.db
      .select()
      .from(markets)
      .where(and(inArray(markets.status, [1, 2]), sql`${markets.expiry} <= ${now} and ${markets.expiry} > ${now - 120}`));
    for (const m of justLocked) {
      if (lockedAnnounced.has(m.marketId)) continue;
      lockedAnnounced.add(m.marketId);
      broadcast("market_locked", m.marketId, marketToApi(m, now));
    }
    const resolved = await deps.db.select().from(markets).where(gt(markets.resolvedBlock, lastResolvedBlock)).orderBy(markets.resolvedBlock).limit(200);
    for (const m of resolved) {
      lastResolvedBlock = m.resolvedBlock && m.resolvedBlock > lastResolvedBlock ? m.resolvedBlock : lastResolvedBlock;
      broadcast("market_resolved", m.marketId, marketToApi(m, now));
    }
  };

  const booksTick = async () => {
    if (clients.size === 0) return;
    const now = Math.floor(Date.now() / 1000);
    const anyAll = [...clients].some((c) => c.all);
    const wanted = new Set<string>();
    for (const c of clients) for (const m of c.markets) wanted.add(m);
    const conds = [eq(markets.status, 1), gt(markets.expiry, BigInt(now))];
    if (!anyAll) {
      if (wanted.size === 0) return;
      conds.push(inArray(markets.marketId, [...wanted]));
    } else conds.push(eq(markets.venueId, deps.cfg.defaultVenueId));
    const live = await deps.db.select({ id: markets.marketId, pool: markets.pool }).from(markets).where(and(...conds)).orderBy(desc(markets.expiry)).limit(40);
    await Promise.all(
      live.map(async (m) => {
        const b = await deps.books.get(m.pool as Address, 10).catch(() => null);
        if (b) broadcast("book", m.id, { marketId: m.id, ...b });
      }),
    );
  };

  // Price is global: it belongs to the asset, not a market, so every client gets
  // it whatever it subscribed to (a widget subscribes to one market, not `all`).
  const priceTick = () => {
    if (clients.size === 0) return;
    for (const p of deps.ticker.all()) for (const c of clients) send(c, "price", p);
  };

  const timers = [
    setInterval(() => void fillsTick().catch(() => undefined), 1000),
    setInterval(() => void marketsTick().catch(() => undefined), 2000),
    setInterval(() => void booksTick().catch(() => undefined), 1000),
    setInterval(priceTick, 2000),
  ];
  void fillsTick().catch(() => undefined);
  void marketsTick().catch(() => undefined);
  app.addHook("onClose", async () => {
    for (const t of timers) clearInterval(t);
    for (const c of clients) c.socket.close();
  });
}
