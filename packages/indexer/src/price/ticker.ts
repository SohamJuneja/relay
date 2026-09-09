// Live underlying price: the SDK's testnet price feed sampled every 2 s, held in
// memory, folded into 1-minute candles. Not persisted per tick.

import { SomniaMarkets, SOMNIA_MAINNET_ADDRESSES, SOMNIA_TESTNET_ADDRESSES, SOMNIA_TESTNET_PRICE_FEED } from "@somnia-chain/markets-sdk";
import { somniaMainnet, somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { sql } from "drizzle-orm";
import type { Db } from "../db/client.js";

export interface PriceSample {
  asset: string;
  price: number;
  ema: number;
  /** feed observation time, unix seconds */
  ts: number;
  /** when we sampled it, unix seconds */
  sampledAt: number;
  source: string;
}

export interface TickerOptions {
  network: "testnet" | "mainnet";
  indexerUrl: string;
  wsRpcUrl: string;
  assets: string[];
  intervalMs?: number;
  /** When given, 1-minute candles are upserted here. */
  db?: Db;
  onSample?: (s: PriceSample) => void;
  log?: (s: string) => void;
}

export class PriceTicker {
  private latest = new Map<string, PriceSample>();
  private timer: NodeJS.Timeout | null = null;
  private exchange: SomniaMarkets | null = null;
  private candles = new Map<string, { minute: number; open: number; high: number; low: number; close: number; samples: number }>();

  constructor(private readonly o: TickerOptions) {}

  get(asset: string): PriceSample | null {
    return this.latest.get(asset.toUpperCase()) ?? null;
  }
  all(): PriceSample[] {
    return [...this.latest.values()];
  }

  start(): void {
    if (this.timer) return;
    if (this.o.network !== "testnet") {
      this.o.log?.("price ticker: no bundled feed on mainnet — ticker idle");
      return;
    }
    // testnet only past this point (the guard above returns on mainnet)
    this.exchange = new SomniaMarkets({
      indexerUrl: this.o.indexerUrl,
      chain: somniaShannon,
      wsRpcUrl: this.o.wsRpcUrl,
      addresses: SOMNIA_TESTNET_ADDRESSES,
      priceFeed: SOMNIA_TESTNET_PRICE_FEED,
    });
    void somniaMainnet;
    void SOMNIA_MAINNET_ADDRESSES;
    const tick = async () => {
      for (const asset of this.o.assets) {
        try {
          const p = await this.exchange!.fetchPrice(asset);
          if (!p) continue;
          const s: PriceSample = { asset, price: p.price, ema: p.ema, ts: Math.floor(p.timestamp / 1000), sampledAt: Math.floor(Date.now() / 1000), source: SOMNIA_TESTNET_PRICE_FEED.url };
          this.latest.set(asset, s);
          this.o.onSample?.(s);
          await this.fold(s);
        } catch (e) {
          this.o.log?.(`price ${asset}: ${(e as Error).message.split("\n")[0]}`);
        }
      }
    };
    void tick();
    this.timer = setInterval(() => void tick(), this.o.intervalMs ?? 2000);
  }

  private async fold(s: PriceSample): Promise<void> {
    const minute = Math.floor(s.ts / 60) * 60;
    const c = this.candles.get(s.asset);
    if (!c || c.minute !== minute) {
      if (c && this.o.db) await this.flush(s.asset, c);
      this.candles.set(s.asset, { minute, open: s.price, high: s.price, low: s.price, close: s.price, samples: 1 });
      return;
    }
    c.high = Math.max(c.high, s.price);
    c.low = Math.min(c.low, s.price);
    c.close = s.price;
    c.samples++;
  }

  private async flush(asset: string, c: { minute: number; open: number; high: number; low: number; close: number; samples: number }): Promise<void> {
    if (!this.o.db) return;
    await this.o.db.execute(sql`
      insert into price_candles (asset, minute_ts, open, high, low, close, samples)
      values (${asset}, ${c.minute}::bigint, ${c.open}, ${c.high}, ${c.low}, ${c.close}, ${c.samples})
      on conflict (asset, minute_ts) do update set high = greatest(price_candles.high, excluded.high), low = least(price_candles.low, excluded.low), close = excluded.close, samples = price_candles.samples + excluded.samples`);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const [asset, c] of this.candles) await this.flush(asset, c).catch(() => undefined);
    await Promise.race([Promise.resolve(this.exchange?.close()), new Promise((r) => setTimeout(r, 1000))]).catch(() => undefined);
  }
}
