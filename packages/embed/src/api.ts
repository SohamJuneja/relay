// The widget's only backend is the Relay API: REST for the first paint and any
// state it cannot stream, WS for book/price/fill/lifecycle. It never talks to
// the DreamDEX indexer, and it degrades to REST polling when the socket is down.

import type { Book, Claimable, FillRow, Health, Market, PartnerPublic, Position, WsEvent } from "./types.js";

/**
 * Module-level GET cache, shared by every widget on the page.
 *
 * A partner can put several cards on one page, and they ask for the same things
 * (`/health`, the live market list, the recently-settled strip). Without this each
 * card issues its own request and a four-card page burns through a 60 req/min
 * budget in seconds. Identical in-flight GETs collapse into one, and the answer is
 * reused for `ttlMs` — short enough that nothing goes stale (books and prices come
 * over the WebSocket anyway).
 */
const GET_CACHE = new Map<string, { at: number; p: Promise<unknown> }>();
const CACHE_TTL_MS = 2500;

export class RelayApi {
  constructor(readonly base: string) {
    this.base = base.replace(/\/$/, "");
  }

  private async get<T>(path: string, ttlMs = CACHE_TTL_MS): Promise<T> {
    const url = `${this.base}${path}`;
    const now = Date.now();
    const hit = GET_CACHE.get(url);
    if (hit && now - hit.at < ttlMs) return hit.p as Promise<T>;
    const p = (async () => {
      const r = await fetch(url);
      if (!r.ok) {
        const body = await r.text().catch(() => "");
        throw new Error(`${path} → ${r.status} ${body}`.slice(0, 300));
      }
      return (await r.json()) as T;
    })();
    GET_CACHE.set(url, { at: now, p });
    // A failure must not be cached: the next caller should be able to retry.
    p.catch(() => {
      if (GET_CACHE.get(url)?.p === p) GET_CACHE.delete(url);
    });
    return p;
  }

  health(): Promise<Health> {
    return this.get<Health>("/health", 30_000);
  }

  liveMarkets(q: { venue?: string; asset?: string; intervalSec?: number; book?: boolean; limit?: number }): Promise<Market[]> {
    const p = new URLSearchParams();
    if (q.venue) p.set("venue", q.venue);
    if (q.asset) p.set("asset", q.asset);
    if (q.intervalSec) p.set("intervalSec", String(q.intervalSec));
    p.set("book", q.book === false ? "false" : "true");
    p.set("limit", String(q.limit ?? 10));
    return this.get<Market[]>(`/v1/markets/live?${p}`);
  }

  market(marketId: string): Promise<Market> {
    return this.get<Market>(`/v1/markets/${marketId}`);
  }

  book(marketId: string): Promise<Book & { marketId: string; status: number }> {
    return this.get<Book & { marketId: string; status: number }>(`/v1/markets/${marketId}/book`);
  }

  /** The settled strip changes once per window, so it can be cached far longer. */
  recent(q: { venue?: string; asset?: string; intervalSec?: number; limit?: number }): Promise<Market[]> {
    const p = new URLSearchParams();
    if (q.venue) p.set("venue", q.venue);
    if (q.asset) p.set("asset", q.asset);
    if (q.intervalSec) p.set("intervalSec", String(q.intervalSec));
    p.set("limit", String(q.limit ?? 5));
    return this.get<Market[]>(`/v1/markets/recent?${p}`, 20_000);
  }

  price(asset: string): Promise<{ asset: string; price: number; ema: number; ts: number }> {
    return this.get(`/v1/price/${asset}`);
  }

  claimable(address: string): Promise<Claimable> {
    return this.get<Claimable>(`/v1/wallets/${address}/claimable`, 1500);
  }

  /** Every outcome balance the wallet holds, open or settled. */
  positions(address: string, limit = 25): Promise<{ address: string; outcomeToken: string; positions: Position[] }> {
    return this.get(`/v1/wallets/${address}/positions?limit=${limit}`, 4000);
  }

  /** Public partner card — no API key, so the widget can name who it is trading for. */
  partnerPublic(partnerId: number): Promise<PartnerPublic> {
    return this.get<PartnerPublic>(`/v1/partners/${partnerId}/public`, 300_000);
  }

  fillsForMarket(marketId: string, limit = 20): Promise<FillRow[]> {
    return this.get<FillRow[]>(`/v1/markets/${marketId}/fills?limit=${limit}`);
  }

  async gasDrip(address: string): Promise<{ txHash: string; amount: string }> {
    const r = await fetch(`${this.base}/v1/gas-drip`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address }),
    });
    const body = (await r.json().catch(() => ({}))) as { txHash?: string; amount?: string; error?: string; message?: string; balance?: string };
    if (!r.ok) {
      // "already funded" is a success for onboarding purposes — the burner has gas.
      if (body.error === "already_funded") return { txHash: "", amount: body.balance ?? "0" };
      throw new Error(body.message ?? body.error ?? `gas-drip → ${r.status}`);
    }
    return { txHash: body.txHash ?? "", amount: body.amount ?? "0" };
  }

  get wsUrl(): string {
    return `${this.base.replace(/^http/, "ws")}/v1/stream`;
  }
}

export type StreamStatus = "connecting" | "open" | "closed";

/**
 * WS with exponential backoff, resubscribe on reconnect, and a caller-driven
 * REST fallback: while the socket is not open the widget polls instead, so a
 * blocked WebSocket degrades the refresh rate rather than the product.
 */
export class RelayStream {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private markets = new Set<string>();
  status: StreamStatus = "closed";

  constructor(
    private readonly url: string,
    private readonly onEvent: (e: WsEvent) => void,
    private readonly onStatus: (s: StreamStatus) => void,
  ) {}

  connect(): void {
    if (this.closed) return;
    this.setStatus("connecting");
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch {
      this.retry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.setStatus("open");
      this.send({ subscribe: { markets: [...this.markets] } });
    };
    ws.onmessage = (ev) => {
      try {
        this.onEvent(JSON.parse(String(ev.data)) as WsEvent);
      } catch {
        /* a malformed frame is not worth tearing the socket down */
      }
    };
    ws.onclose = () => {
      this.ws = null;
      this.setStatus("closed");
      this.retry();
    };
    ws.onerror = () => ws.close();
  }

  private setStatus(s: StreamStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  }

  private retry(): void {
    if (this.closed || this.timer) return;
    const wait = Math.min(15_000, 500 * 2 ** this.attempt++) + Math.random() * 250;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, wait);
  }

  private send(msg: unknown): void {
    if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify(msg));
  }

  subscribe(marketId: string): void {
    const id = marketId.toLowerCase();
    if (this.markets.has(id)) return;
    this.markets.add(id);
    this.send({ subscribe: { markets: [id] } });
  }

  unsubscribe(marketId: string): void {
    const id = marketId.toLowerCase();
    if (!this.markets.delete(id)) return;
    this.send({ unsubscribe: { markets: [id] } });
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.ws?.close();
    this.ws = null;
    this.setStatus("closed");
  }
}
