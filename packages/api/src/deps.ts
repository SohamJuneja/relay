// Runtime dependencies for the API: DB, RPC client, live price ticker, book cache.

import type { Address, PublicClient } from "viem";
import { binaryPoolReadAbi, priceToProbability, readYesBooks, summarizeYes, toFourSided } from "@relay/core";
import { loadConfig, makePublicClient, openDb, PriceTicker, type Db, type IndexerConfig } from "@relay/indexer";

export interface BookLevelOut {
  price: number;
  quantity: number;
  priceRaw: string;
  quantityRaw: string;
}
export interface BookOut {
  pool: Address;
  ts: number;
  yesBids: BookLevelOut[];
  yesAsks: BookLevelOut[];
  noBids: BookLevelOut[];
  noAsks: BookLevelOut[];
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
  empty: boolean;
}

export class BookCache {
  private cache = new Map<string, { at: number; value: Promise<BookOut | null> }>();
  constructor(
    private client: PublicClient,
    private decimals: number,
    private ttlMs = 1000,
  ) {}

  get(pool: Address, depth = 10): Promise<BookOut | null> {
    const k = `${pool.toLowerCase()}:${depth}`;
    const hit = this.cache.get(k);
    const now = Date.now();
    if (hit && now - hit.at < this.ttlMs) return hit.value;
    const value = this.read(pool, depth);
    this.cache.set(k, { at: now, value });
    return value;
  }

  private async read(pool: Address, depth: number): Promise<BookOut | null> {
    const [b] = await readYesBooks(this.client, [pool], depth);
    if (!b || "error" in b) return null;
    const one = 10n ** BigInt(this.decimals);
    const four = toFourSided(b, one);
    const s = summarizeYes(b, this.decimals);
    const lv = (l: { price: bigint; quantity: bigint }): BookLevelOut => ({
      price: priceToProbability(l.price, this.decimals),
      quantity: Number(l.quantity) / Number(one),
      priceRaw: l.price.toString(),
      quantityRaw: l.quantity.toString(),
    });
    return {
      pool,
      ts: Math.floor(Date.now() / 1000),
      yesBids: four.yesBids.map(lv),
      yesAsks: four.yesAsks.map(lv),
      noBids: four.noBids.map(lv),
      noAsks: four.noAsks.map(lv),
      bestBid: s.bestBid,
      bestAsk: s.bestAsk,
      mid: s.mid,
      spread: s.spread,
      empty: s.empty,
    };
  }
}

/**
 * What the Telegram bot is doing, for /health.
 *
 * A bot that is not polling looks identical from outside to one with nothing to say,
 * and the only way to tell them apart was Render's log viewer. These six fields answer
 * it: `running` false means it never took the polling slot, a `lastPollAt` that stops
 * moving means it lost it, and `lastError` says why.
 */
export interface BotStatus {
  enabled: boolean;
  running: boolean;
  /** Last time the poller confirmed it held the slot. */
  lastPollAt: string | null;
  /** Last update actually received — the proof that messages are arriving. */
  lastUpdateAt: string | null;
  lastError: string | null;
  restarts: number;
  /** Whether this host can reach api.telegram.org at all, and how it failed if not. */
  reachability: string | null;
}

export interface ApiDeps {
  cfg: IndexerConfig;
  db: Db;
  client: PublicClient;
  ticker: PriceTicker;
  books: BookCache;
  /** ERC-6909 outcome-token singleton (read once from any pool). */
  outcomeToken(): Promise<Address>;
  /**
   * The bot's live state, when this process runs one. Undefined in the standalone API,
   * which reports enabled:false rather than pretending to know.
   */
  botStatus?: (() => BotStatus | null) | undefined;
  /** Apply checked-in migrations. The single-process server calls this at startup. */
  migrate(): Promise<void>;
  close(): Promise<void>;
}

export async function createDeps(): Promise<ApiDeps> {
  const cfg = loadConfig();
  const client = makePublicClient(cfg);
  const h = await openDb(cfg.databaseUrl);
  const ticker = new PriceTicker({ network: cfg.network, indexerUrl: cfg.indexerUrl, wsRpcUrl: cfg.wsRpcUrl, assets: cfg.priceAssets, log: (s) => console.log(s) });
  ticker.start();
  let outcomeToken: Address | null = null;
  return {
    cfg,
    db: h.db,
    client,
    ticker,
    books: new BookCache(client, cfg.decimals),
    async outcomeToken() {
      if (outcomeToken) return outcomeToken;
      const { markets } = await import("@relay/indexer");
      const row = (await h.db.select({ pool: markets.pool }).from(markets).limit(1))[0];
      if (!row) throw new Error("no markets indexed yet");
      outcomeToken = (await client.readContract({ address: row.pool as Address, abi: binaryPoolReadAbi, functionName: "outcomeToken" })) as Address;
      return outcomeToken;
    },
    migrate: () => h.migrate(),
    async close() {
      await ticker.stop();
      await h.close();
    },
  };
}
