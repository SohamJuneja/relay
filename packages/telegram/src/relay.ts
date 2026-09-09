// The bot's view of the Relay API: live markets, and the numbers a card needs.
//
// Read-only and unauthenticated — the bot never places an order and never holds a
// key. Trading happens in the mini-app, on the reader's own device.

export interface Market {
  marketId: string;
  asset: string;
  intervalSec: number;
  expiry: number;
  secondsToExpiry: number;
  status: number;
  question: string;
  openingPriceRaw: string | null;
  tradingStart: number;
  book?: {
    bestBid: number | null;
    bestAsk: number | null;
  } | null;
}

export interface PriceTick {
  asset: string;
  price: number;
  ts: number;
}

export class RelayApi {
  constructor(readonly base: string) {
    this.base = base.replace(/\/$/, "");
  }

  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`);
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return (await res.json()) as T;
  }

  liveMarkets(q: { asset?: string; intervalSec?: number; limit?: number } = {}): Promise<Market[]> {
    const p = new URLSearchParams({ book: "true", limit: String(q.limit ?? 12) });
    if (q.asset) p.set("asset", q.asset);
    if (q.intervalSec) p.set("intervalSec", String(q.intervalSec));
    return this.get<Market[]>(`/v1/markets/live?${p}`);
  }

  price(asset: string): Promise<PriceTick> {
    return this.get<PriceTick>(`/v1/price/${asset}`);
  }
}

export const money = (n: number, dp = 2): string => n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
export const oraclePrice = (raw: string | null): string | null => (raw === null ? null : money(Number(raw) / 100));
export const cents = (p: number | null | undefined): string | null => (p === null || p === undefined ? null : `${(p * 100).toFixed(1)}¢`);

export function intervalLabel(sec: number): string {
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

/** Signed move against the window's opening price, or null while that is unknown. */
export function movePct(price: number, openingPriceRaw: string | null): string | null {
  if (openingPriceRaw === null) return null;
  const open = Number(openingPriceRaw) / 100;
  if (!open) return null;
  const pct = ((price - open) / open) * 100;
  return `${pct >= 0 ? "+" : "−"}${Math.abs(pct).toFixed(2)}%`;
}

/**
 * The next moment a window of this cadence opens, taken from the market that is
 * live now rather than from the wall clock.
 *
 * Windows are aligned to the venue's own boundaries, and while those usually land on
 * neat clock times, "usually" is not something a scheduler should assume — a venue
 * that shifts its epoch by thirty seconds would leave a wall-clock scheduler posting
 * a card into the previous window forever. The live market knows exactly when it
 * expires, and the next one starts there.
 */
export function nextWindowOpen(markets: Market[], intervalSec: number): number | null {
  const candidates = markets.filter((m) => m.intervalSec === intervalSec && m.status === 1).sort((a, b) => a.expiry - b.expiry);
  const soonest = candidates[0];
  return soonest ? soonest.expiry : null;
}
