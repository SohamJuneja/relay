import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Address, Hex } from "viem";
import { ADDRESSES, MarketStatus, SURFACE, encodeUserData, type Network } from "@relay/core/browser";
import { RelayApi, RelayStream, type StreamStatus } from "./api.js";
import { Amounts, Brand, Header, Notice, PositionsStrip, PriceStrip, QuestionLine, RecentStrip, Row, Sides, Steps, TxLink } from "./components.jsx";
import { claim, collateralBalance, faucet, placeOrder, quote, readBalances, readMarketContext, readYesBook, TradeError, type MarketContext, type TradeResult } from "./chain.js";
import { countdown, fromRaw, intervalLabel, money, pct, shortAddr, toRaw, usd } from "./format.js";
import { Rpc } from "./rpc.js";
import type { Book, ClaimRow, Market, OnboardStep, Outcome, PartnerPublic, Position, PriceTick, RelayOptions, StepState, WsEvent } from "./types.js";
import { chainInfo, connectInjected, forgetInstantWallet, hasInstantWallet, injectedProvider, loadOrCreateInstantWallet, type RelayWallet } from "./wallet.js";

const ASSETS = ["BTC", "ETH"];
const INTERVALS = [300, 900, 3600];
const SPARK_POINTS = 150; // ~5 min at one sample every 2 s
const FAUCET_AMOUNT = 25; // tUSDC the burner asks the public faucet for

type Phase = "trade" | "confirm" | "pending" | "receipt";

interface OnboardState {
  active: boolean;
  steps: { id: OnboardStep; state: StepState; note?: string }[];
  error: string | null;
}

const initialOnboard = (): OnboardState => ({
  active: false,
  steps: [
    { id: "create", state: "idle" },
    { id: "gas", state: "idle" },
    { id: "collateral", state: "idle" },
    { id: "ready", state: "idle" },
  ],
  error: null,
});

export function Widget(props: { opts: RelayOptions; host: HTMLElement }) {
  const { opts, host } = props;
  const api = useMemo(() => new RelayApi(opts.api ?? "http://localhost:8787"), [opts.api]);
  const [network, setNetwork] = useState<Network>("testnet");
  const chain = useMemo(() => chainInfo(network), [network]);
  const rpc = useMemo(() => new Rpc(chain.rpcUrl), [chain.rpcUrl]);
  const addresses = ADDRESSES[network];
  const explorer = chain.explorer;

  const [asset, setAsset] = useState(opts.asset ?? "BTC");
  const [intervalSec, setIntervalSec] = useState(opts.intervalSec ?? 900);
  const [market, setMarket] = useState<Market | null>(null);
  const [ctx, setCtx] = useState<MarketContext | null>(null);
  const [book, setBook] = useState<Book | null>(null);
  const [recent, setRecent] = useState<Market[]>([]);
  const [price, setPrice] = useState<PriceTick | null>(null);
  const [spark, setSpark] = useState<number[]>([]);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [wsStatus, setWsStatus] = useState<StreamStatus>("connecting");
  const [loadError, setLoadError] = useState<string | null>(null);

  const [wallet, setWallet] = useState<RelayWallet | null>(null);
  const [balances, setBalances] = useState<{ gas: bigint; collateral: bigint } | null>(null);
  const [onboard, setOnboard] = useState<OnboardState>(initialOnboard);

  const [side, setSide] = useState<Outcome | null>(null);
  const [amount, setAmount] = useState<number>((opts.amounts ?? [1, 5, 10])[0] ?? 1);
  const [phase, setPhase] = useState<Phase>("trade");
  const [stage, setStage] = useState<string | null>(null);
  const stageRef = useRef<string | null>(null);
  const [trade, setTrade] = useState<TradeResult | null>(null);
  const [tradeMarket, setTradeMarket] = useState<Market | null>(null);
  const [tradeSide, setTradeSide] = useState<Outcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [claimable, setClaimable] = useState<{ total: number; claims: ClaimRow[]; outcomeToken: Address; binaryModule: Address } | null>(null);
  const [claiming, setClaiming] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [claimed, setClaimed] = useState<{ hashes: Hex[]; count: number } | null>(null);
  const [positions, setPositions] = useState<Position[]>([]);
  const [partner, setPartner] = useState<PartnerPublic | null>(null);

  const streamRef = useRef<RelayStream | null>(null);
  const subscribed = useRef<string | null>(null);
  const presets = opts.amounts ?? [1, 5, 10];
  const userData = useMemo(
    () => (opts.partner ? encodeUserData({ partnerId: opts.partner, surfaceId: surfaceId(opts.surface) }) : 0n),
    [opts.partner, opts.surface],
  );

  const emit = useCallback(
    (name: string, detail: unknown) => host.dispatchEvent(new CustomEvent(`relay:${name}`, { detail, bubbles: true, composed: true })),
    [host],
  );

  // ── clock ──
  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // ── health (network) ──
  useEffect(() => {
    let alive = true;
    api
      .health()
      .then((h) => alive && setNetwork(h.network === "mainnet" ? "mainnet" : "testnet"))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [api]);

  // The receipt says who the flow was credited to by NAME. It is a public endpoint,
  // cached hard — the name changes about never — and the line falls back to the id
  // when it cannot be fetched, so attribution is still legible without it.
  useEffect(() => {
    const id = opts.partner;
    if (id === undefined) return setPartner(null);
    let alive = true;
    api
      .partnerPublic(id)
      .then((pp) => alive && setPartner(pp))
      .catch(() => alive && setPartner(null));
    return () => {
      alive = false;
    };
  }, [api, opts.partner]);

  // ── market discovery for the selected series ──
  const loadMarket = useCallback(async () => {
    try {
      const q: { asset: string; intervalSec: number; limit: number; venue?: string } = { asset, intervalSec, limit: 5 };
      if (opts.venue) q.venue = opts.venue;
      const [live, rec] = await Promise.all([api.liveMarkets(q), api.recent({ ...q, limit: 5 }).catch(() => [])]);
      const next = live.find((m) => m.status === MarketStatus.Trading && m.secondsToExpiry > 5) ?? live[0] ?? null;
      setMarket(next);
      setBook(next?.book ?? null);
      setRecent(rec);
      setLoadError(null);
      if (!next) setCtx(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, [api, asset, intervalSec, opts.venue]);

  useEffect(() => {
    setMarket(null);
    setBook(null);
    setCtx(null);
    setPhase("trade");
    setTrade(null);
    setClaimed(null);
    void loadMarket();
  }, [loadMarket]);

  // Look for a fresh window while the current one is missing or closed. One
  // interval, not a timeout keyed on `now` — that would be cleared every tick and
  // never fire, leaving the card stuck on a dead window.
  useEffect(() => {
    const t = setInterval(() => {
      const stale = !marketRef.current || marketRef.current.status !== MarketStatus.Trading || marketRef.current.expiry <= Math.floor(Date.now() / 1000);
      if (stale) void loadMarket();
    }, 6000);
    return () => clearInterval(t);
  }, [loadMarket]);

  // ── pool context for the current market ──
  useEffect(() => {
    if (!market) return;
    let alive = true;
    readMarketContext(rpc, market)
      .then((c) => alive && setCtx(c))
      .catch(() => alive && setCtx(null));
    return () => {
      alive = false;
    };
  }, [rpc, market]);

  // ── stream ──
  useEffect(() => {
    const s = new RelayStream(api.wsUrl, onWsEvent, setWsStatus);
    streamRef.current = s;
    s.connect();
    return () => {
      s.close();
      streamRef.current = null;
      subscribed.current = null;
    };
    // onWsEvent is stable enough: it only reads refs and setState
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  useEffect(() => {
    const s = streamRef.current;
    if (!s || !market) return;
    if (subscribed.current && subscribed.current !== market.marketId) s.unsubscribe(subscribed.current);
    s.subscribe(market.marketId);
    subscribed.current = market.marketId;
  }, [market, wsStatus]);

  function onWsEvent(e: WsEvent): void {
    if (e.type === "price") {
      const p = e.data;
      setPrice((prev) => (prev && prev.asset !== assetRef.current ? prev : p.asset === assetRef.current ? p : prev));
      if (p.asset === assetRef.current) setSpark((s) => [...s, p.price].slice(-SPARK_POINTS));
      return;
    }
    if (e.type === "book") {
      if (e.data.marketId?.toLowerCase() === subscribed.current?.toLowerCase()) setBook(e.data);
      return;
    }
    if (e.type === "market_locked" || e.type === "market_resolved") {
      if (e.data.marketId.toLowerCase() === subscribed.current?.toLowerCase()) {
        setMarket((m) => (m ? { ...m, ...e.data } : e.data));
      }
      // Refresh the strip on ANY resolution, not just the subscribed market: the
      // reader may hold a position on a series the card is not currently showing,
      // and that is exactly the position the strip exists to surface.
      if (e.type === "market_resolved") void refreshClaimable();
      return;
    }
    if (e.type === "fill") {
      if (e.data.marketId?.toLowerCase() === subscribed.current?.toLowerCase()) emit("fill", e.data);
    }
  }

  const marketRef = useRef<Market | null>(null);
  useEffect(() => {
    marketRef.current = market;
  }, [market]);

  // `asset` inside the WS callback without re-subscribing on every change
  const assetRef = useRef(asset);
  useEffect(() => {
    assetRef.current = asset;
    setSpark([]);
    setPrice(null);
  }, [asset]);

  // ── REST fallback while the socket is down ──
  useEffect(() => {
    if (wsStatus === "open") return;
    let alive = true;
    const poll = async () => {
      if (!alive) return;
      try {
        const p = await api.price(asset);
        if (!alive) return;
        setPrice({ asset: p.asset, price: p.price, ema: p.ema, ts: p.ts, sampledAt: Math.floor(Date.now() / 1000), source: "rest" });
        setSpark((s) => [...s, p.price].slice(-SPARK_POINTS));
      } catch {
        /* keep the last known price */
      }
      if (market) {
        try {
          const b = await api.book(market.marketId);
          if (alive) setBook(b);
        } catch {
          /* ignore */
        }
      }
    };
    void poll();
    const t = setInterval(() => void poll(), 3000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [wsStatus, api, asset, market]);

  // ── wallet ──
  const refreshBalances = useCallback(
    async (w: RelayWallet | null, c: MarketContext | null) => {
      if (!w) return setBalances(null);
      try {
        if (c) {
          const b = await readBalances(rpc, c, w.address);
          setBalances({ gas: b.gas, collateral: b.collateral });
        } else {
          // No market context yet — but the collateral token is a fixed per-network
          // address, so read it directly. Reporting 0n here would tell a funded user
          // their balance is gone and would trip the insufficient-balance gate.
          const [gas, collateral] = await Promise.all([rpc.getBalance(w.address), collateralBalance(rpc, addresses.collateral, w.address)]);
          setBalances({ gas, collateral });
        }
      } catch {
        /* transient RPC hiccup */
      }
    },
    [rpc, addresses.collateral],
  );
  useEffect(() => {
    void refreshBalances(wallet, ctx);
  }, [wallet, ctx, refreshBalances]);

  const refreshClaimable = useCallback(async () => {
    const w = walletRef.current;
    if (!w) return;
    // Both halves of the positions strip: what is still running and what can be
    // redeemed. They come from two endpoints but are one thought to the reader.
    const [c, pos] = await Promise.allSettled([api.claimable(w.address), api.positions(w.address)]);
    if (c.status === "fulfilled") {
      setClaimable({ total: c.value.total, claims: c.value.claims, outcomeToken: c.value.outcomeToken, binaryModule: c.value.binaryModule });
    }
    if (pos.status === "fulfilled") setPositions(pos.value.positions);
  }, [api]);
  // Positions change without the reader doing anything — another window settles, an
  // order fills elsewhere — so the strip needs a slow heartbeat as well as the event
  // hooks. Twenty seconds is far below the shortest window and costs two cached GETs.
  useEffect(() => {
    if (!wallet) return;
    const t = setInterval(() => void refreshClaimable(), 20_000);
    return () => clearInterval(t);
  }, [wallet, refreshClaimable]);

  const walletRef = useRef<RelayWallet | null>(null);
  useEffect(() => {
    walletRef.current = wallet;
    if (wallet) void refreshClaimable();
    else {
      setClaimable(null);
      setPositions([]);
    }
  }, [wallet, refreshClaimable]);

  // Reconnect a burner that already exists in this browser.
  // Reconnect a burner that already exists in this browser — and keep looking, because
  // a SECOND widget on the same page mounts before the first one creates the key and
  // would otherwise sit disconnected until a reload. `storage` events only fire in
  // other tabs, so a small poll is the portable way to notice a same-page sibling.
  useEffect(() => {
    if (wallet) return;
    const adopt = () => {
      if (!hasInstantWallet(chain.id)) return false;
      setWallet(loadOrCreateInstantWallet(chain, rpc));
      return true;
    };
    if (adopt()) return;
    const t = setInterval(() => {
      if (adopt()) clearInterval(t);
    }, 2000);
    return () => clearInterval(t);
  }, [chain, rpc, wallet]);

  const setStep = (id: OnboardStep, state: StepState, note?: string) =>
    setOnboard((o) => ({ ...o, steps: o.steps.map((s) => (s.id === id ? { id, state, ...(note !== undefined ? { note } : {}) } : s)) }));

  async function startInstantWallet(): Promise<void> {
    setOnboard({ ...initialOnboard(), active: true });
    setError(null);
    try {
      setStep("create", "running");
      const w = loadOrCreateInstantWallet(chain, rpc);
      setWallet(w);
      walletRef.current = w;
      setStep("create", "done", shortAddr(w.address));

      setStep("gas", "running");
      let gas = await rpc.getBalance(w.address);
      if (gas < 10n ** 16n) {
        const drip = await api.gasDrip(w.address);
        for (let i = 0; i < 40 && gas < 10n ** 16n; i++) {
          await sleep(500);
          gas = await rpc.getBalance(w.address);
        }
        setStep("gas", gas > 0n ? "done" : "error", drip.txHash ? `${drip.amount} STT` : "already funded");
        if (gas === 0n) throw new Error("the gas drip did not arrive — try again in a moment");
      } else {
        setStep("gas", "done", "already funded");
      }

      setStep("collateral", "running");
      const one = 10n ** 6n; // tUSDC is 6 dp on Shannon
      const balance = await collateralBalance(rpc, addresses.collateral, w.address);
      if (balance < 5n * one) {
        await faucet(rpc, w, addresses.collateral, BigInt(FAUCET_AMOUNT) * one);
        setStep("collateral", "done", `${FAUCET_AMOUNT} tUSDC`);
      } else {
        setStep("collateral", "done", `${money(Number(balance) / Number(one), 2)} tUSDC`);
      }

      setStep("ready", "done");
      await refreshBalances(w, ctx);
      await refreshClaimable();
      setTimeout(() => setOnboard((o) => ({ ...o, active: false })), 900);
    } catch (e) {
      const msg = (e as Error).message;
      setOnboard((o) => ({ ...o, error: msg, steps: o.steps.map((s) => (s.state === "running" ? { ...s, state: "error" } : s)) }));
    }
  }

  /**
   * Move between the browser burner and the reader's own wallet.
   *
   * Both keep existing — switching to an injected wallet does not forget the burner,
   * and switching back does not disconnect anything. That matters because the burner
   * may hold an unclaimed position, and a "switch" that silently stranded it would be
   * a way to lose money.
   */
  async function switchWallet(): Promise<void> {
    setSwitching(true);
    setError(null);
    try {
      if (wallet?.kind === "instant") {
        const w = await connectInjected(chain);
        setWallet(w);
      } else {
        setWallet(loadOrCreateInstantWallet(chain, rpc));
      }
      setBalances(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSwitching(false);
    }
  }

  async function connectWallet(): Promise<void> {
    setError(null);
    try {
      const w = await connectInjected(chain);
      setWallet(w);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  // ── quote ──
  const live = market !== null && market.status === MarketStatus.Trading && market.expiry > now;
  const upDisabled = !live || !book || book.yesAsks.length === 0;
  const downDisabled = !live || !book || book.yesBids.length === 0;
  const upProb = book?.bestAsk ?? null;
  const downProb = book?.bestBid === null || book?.bestBid === undefined ? null : 1 - book.bestBid;

  const q = useMemo(() => {
    if (!ctx || !book || !side) return null;
    return quote({
      book,
      ctx,
      outcome: side,
      budget: toRaw(amount, ctx.decimals),
      partner: { builder: opts.builder, userData },
      nowSec: now,
    });
  }, [ctx, book, side, amount, opts.builder, userData, now]);

  // Affordability compares two raw collateral amounts and needs nothing else — the
  // old `ctx === null` term made the gate SKIP ITSELF whenever the on-chain context
  // was missing, defaulting to "you can afford it" and leaving Review enabled on an
  // order the wallet could not cover. Only a genuinely unknown balance is permissive,
  // and `assertAffordable` still backstops the gas side before signing.
  const enoughCollateral = balances === null || q === null || !q.ok ? true : balances.collateral >= q.escrow;

  async function confirmTrade(): Promise<void> {
    if (!wallet || !ctx || !q || !q.ok || !market || !side) return;
    setPhase("pending");
    setError(null);
    stageRef.current = "checking the market";
    setStage("checking the market");
    try {
      const fresh = await readMarketContext(rpc, market);
      if (fresh.status !== MarketStatus.Trading) throw new TradeError("this window just closed — the next one opens in a moment");
      emit("trade", { marketId: market.marketId, outcome: side, amount, partner: opts.partner ?? null, builder: opts.builder ?? null, userData: userData.toString() });

      // Re-quote against the chain, not the streamed snapshot: the touch moves
      // between frames and an IOC priced off a stale book reverts with nothing
      // filled. One retry covers a move that happens inside this very window.
      let res: TradeResult | null = null;
      let lastErr: TradeError | null = null;
      for (let attempt = 0; attempt < 2 && res === null; attempt++) {
        const raw = await readYesBook(rpc, fresh.pool, 10);
        const q2 = quote({ book, raw, ctx: fresh, outcome: side, budget: toRaw(amount, fresh.decimals), partner: { builder: opts.builder, userData }, nowSec: Math.floor(Date.now() / 1000) });
        if (!q2.ok) throw new TradeError(q2.reason ?? "the market moved out of range");
        try {
          res = await placeOrder({
            rpc,
            wallet,
            ctx: fresh,
            args: q2.args,
            escrow: q2.escrow,
            outcome: side,
            onStage: (s) => {
              const label = s === "approving" ? "approving tUSDC" : s === "signing" ? "waiting for your signature" : "confirming on chain";
              stageRef.current = label;
              setStage(label);
            },
          });
        } catch (e) {
          if (e instanceof TradeError && e.revertName === "ImmediateOrCancelNoFill" && attempt === 0) {
            lastErr = e;
            setStage("the price moved — retrying");
            continue;
          }
          throw e;
        }
      }
      if (!res) throw lastErr ?? new TradeError("the order could not be placed");

      setTrade(res);
      setTradeMarket(market);
      setTradeSide(side);
      setPhase("receipt");
      setStage(null);
      emit("fill", { txHash: res.hash, marketId: market.marketId, outcome: side, filled: fromRaw(res.filledRaw, fresh.decimals), tagged: res.tagged, builder: res.builderSeen });
      void refreshBalances(wallet, fresh);
      // The position the reader just took is the whole point of the strip, and the
      // balance is an on-chain read that only settles a block or two later — so ask
      // now and again shortly after, rather than waiting for the next resolution.
      void refreshClaimable();
      setTimeout(() => void refreshClaimable(), 3000);
    } catch (e) {
      // The card shows a sentence a person can act on; the console gets the whole
      // error so whoever embedded the widget can debug it.
      console.error("[relay] trade failed", { stage: stageRef.current, error: e });
      const msg = e instanceof TradeError ? e.message : `${stageRef.current ?? "sending"}: ${(e as Error).message}`;
      setPhase("confirm");
      setStage(null);
      setError(msg);
      // The order was refused because the book moved, so the numbers the reader is
      // looking at are the ones that just failed. Re-read the book and let the quote
      // recompute BEFORE they can press Confirm again, or the retry is priced off the
      // same stale touch and fails the same way.
      if (market) {
        void api
          .book(market.marketId)
          .then((b) => setBook(b))
          .catch(() => undefined);
      }
    }
  }

  async function claimAll(rows: ClaimRow[]): Promise<void> {
    if (!wallet || !claimable) return;
    setClaiming("claiming");
    setError(null);
    try {
      const res = await claim({
        rpc,
        wallet,
        binaryModule: claimable.binaryModule,
        outcomeToken: claimable.outcomeToken,
        claims: rows,
        onProgress: (d, t) => setClaiming(t > 1 ? `claiming ${d}/${t}` : "claiming"),
      });
      emit("claim", { hashes: res.hashes, batched: res.batched, count: rows.length });
      setClaimed({ hashes: res.hashes, count: rows.length });
      setClaiming(null);
      await refreshClaimable();
      void refreshBalances(wallet, ctx);
    } catch (e) {
      setClaiming(null);
      setError(e instanceof TradeError ? e.message : (e as Error).message);
    }
  }

  // ── position / result for the market we traded ──
  //
  // Judge the result from the TRADED market's own record, not from whatever the
  // card is currently showing. The card rolls forward to the next window the moment
  // the traded one stops trading, so a check of `market.marketId === traded` almost
  // never holds by the time the oracle resolves — the receipt promises "it will flip
  // to the result" and would sit there forever. Poll that one market until it settles.
  const [tradedNow, setTradedNow] = useState<Market | null>(null);
  useEffect(() => {
    const id = tradeMarket?.marketId;
    if (phase !== "receipt" || !id) return;
    let alive = true;
    const settled = (m: Market | null) => m !== null && (m.status === MarketStatus.Resolved || m.status === MarketStatus.Voided);
    const enriched = (m: Market) => m.voided || (m.winner !== null && m.closingPriceRaw !== null);
    let extra = 0;
    const poll = async () => {
      try {
        const m = await api.market(id);
        if (!alive) return;
        setTradedNow(m);
        if (settled(m)) {
          void refreshClaimable();
          // Resolution and enrichment are two different writes. Give the closing
          // price a few more ticks to land rather than freezing on the first
          // resolved snapshot, but never poll forever.
          if (enriched(m) || ++extra > 5) clearInterval(t);
        }
      } catch {
        /* transient — the next tick retries */
      }
    };
    const t = setInterval(() => void poll(), 4000);
    void poll();
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [api, phase, tradeMarket?.marketId, refreshClaimable]);

  // Prefer the polled record; fall back to the displayed one when it is still the
  // same market (the first seconds after a trade, before the first poll lands).
  // Guard on the id: a resolved record left over from the PREVIOUS trade would
  // otherwise flash a verdict over the new one before the first poll lands.
  const polled = tradedNow !== null && tradeMarket !== null && tradedNow.marketId === tradeMarket.marketId ? tradedNow : null;
  const settledMarket = polled ?? (tradeMarket !== null && market !== null && market.marketId === tradeMarket.marketId ? market : null);
  const tradedResolved = trade !== null && settledMarket !== null && (settledMarket.status === MarketStatus.Resolved || settledMarket.status === MarketStatus.Voided);
  const won = tradedResolved && settledMarket !== null && settledMarket.winner !== null && settledMarket.winner === tradeSide;
  const claimForTrade = claimable?.claims.find((c) => tradeMarket && c.marketId.toLowerCase() === tradeMarket.marketId.toLowerCase());

  const secondsLeft = market ? Math.max(0, market.expiry - now) : 0;

  // When no window is live, the next one starts a cadence after the last one ended.
  // `recent` is ordered newest first and already filtered to this series.
  const nextOpenIn = useMemo(() => {
    if (market) return null;
    const last = recent.find((m) => m.intervalSec === intervalSec && m.asset === asset);
    if (!last) return null;
    let next = last.expiry + intervalSec;
    while (next <= now) next += intervalSec;
    const left = next - now;
    // More than one cadence away means our idea of "last" is stale, not that the
    // venue has gone quiet for an hour. Say nothing rather than something wrong.
    return left > intervalSec ? null : left;
  }, [market, recent, intervalSec, asset, now]);
  const dec = ctx?.decimals ?? 6;

  // Positions on the CURRENT asset across every series, still running. A settled
  // one is not "open" even if the balance is still there — it belongs to the claim
  // half of the strip.
  const openPositions = useMemo(
    () =>
      positions
        .filter((p) => p.asset === asset && p.status < MarketStatus.Resolved && !p.voided && p.expiry > now)
        .flatMap((p) => {
          const out: { position: Position; outcome: Outcome; amount: number }[] = [];
          if (p.yes > 0) out.push({ position: p, outcome: "UP", amount: p.yes });
          if (p.no > 0) out.push({ position: p, outcome: "DOWN", amount: p.no });
          return out;
        })
        .sort((a, b) => a.position.expiry - b.position.expiry),
    [positions, asset, now],
  );
  const claimRows = claimable?.claims ?? [];

  return (
    <div class="card" part="card">
      <Header
        asset={asset}
        assets={ASSETS}
        intervalSec={intervalSec}
        intervals={INTERVALS}
        statusName={market ? (live ? "Trading" : market.statusName) : "—"}
        secondsLeft={secondsLeft}
        live={live}
        onAsset={setAsset}
        onInterval={setIntervalSec}
      />

      {opts.question === false ? null : <QuestionLine asset={asset} market={market} />}

      <PriceStrip asset={asset} price={price?.price ?? null} openingRaw={market?.openingPriceRaw ?? null} points={spark} hasMarket={market !== null} />

      {loadError ? <Notice tone="warn">Cannot reach the Relay API at <code>{api.base}</code>. {loadError}</Notice> : null}

      {!market ? (
        <p class="empty">
          No live {asset} {intervalLabel(intervalSec)} window right now.
          <br />
          {/* Windows of a given cadence are back to back, so the next one opens when
              the last one closed plus the cadence. Saying "in 2:41" is a fact the card
              can derive; "waiting…" is a spinner in prose. */}
          {nextOpenIn === null ? "Waiting for the next one to open…" : <>Next {intervalLabel(intervalSec)} window opens in about {countdown(nextOpenIn)}.</>}
        </p>
      ) : onboard.active ? (
        <div class="rows">
          <Steps steps={onboard.steps} />
          {onboard.error ? <Notice tone="warn">{onboard.error}</Notice> : null}
        </div>
      ) : phase === "receipt" && trade ? (
        <div class="result">
          {tradedResolved ? (
            <>
              <div class="verdict" data-r={settledMarket?.voided ? "void" : won ? "won" : "lost"}>
                {settledMarket?.voided ? "VOIDED" : won ? "WON" : "LOST"}
              </div>
              <dl class="rows" style="padding:0">
                <Row label="Your side" value={tradeSide ?? "—"} />
                <Row label="Result" value={settledMarket?.winner ?? "void"} />
                {/* Resolution and the closing price are two separate writes. An em dash
                    next to "Closing price" reads as "there wasn't one"; naming the state
                    says the truth, which is that it is still coming. */}
                {settledMarket?.closingPriceRaw ? (
                  <Row label="Closing price" value={money(Number(settledMarket.closingPriceRaw) / 100, 2)} />
                ) : settledMarket?.voided ? null : (
                  <Row label="Closing price · settling" value={<span style="color:var(--ink-3)">a moment</span>} />
                )}
                <Row
                  label={won || settledMarket?.voided ? "To claim" : "Position value"}
                  value={won || settledMarket?.voided ? usd(claimForTrade?.amount ?? fromRaw(trade.filledRaw, dec)) : "$0.00"}
                  tone={won ? "win" : "loss"}
                />
              </dl>
              {won || settledMarket?.voided ? (
                claimed !== null ? (
                  <dl class="rows" style="padding:0">
                    <Row label="Claimed" value={claimed.hashes[0] ? <TxLink hash={claimed.hashes[0]} explorer={explorer} /> : "✓"} tone="win" />
                  </dl>
                ) : (
                  <button type="button" class="btn" disabled={claiming !== null || !claimForTrade} onClick={() => claimForTrade && void claimAll([claimForTrade])}>
                    {/* Once the claim lands the row disappears from `claimable`, and the old
                        fallback then rendered "Settling…" over a payout that had ALREADY been
                        paid — the one message guaranteed to make a user think it is stuck. */}
                    {claiming ?? (claimForTrade ? `Claim ${usd(claimForTrade.amount)}` : "Settling…")}
                  </button>
                )
              ) : (
                <p class="note">This window closed against you, so the position is worth 0. Nothing to claim.</p>
              )}
              <button type="button" class="btn" data-variant="ghost" onClick={() => { setPhase("trade"); setTrade(null); }}>
                Trade the next window
              </button>
            </>
          ) : (
            <>
              <div class="verdict" data-r="won" style="font-size:22px">
                {money(fromRaw(trade.filledRaw, dec), 2)} {tradeSide}
              </div>
              <dl class="rows" style="padding:0">
                <Row label="Average price" value={trade.fillPriceOwnRaw === null ? "—" : pct(fromRaw(trade.fillPriceOwnRaw, dec))} />
                <Row label="You paid" value={usd(fromRaw(trade.spentRaw, dec))} />
                <Row label="Pays if right" value={usd(fromRaw(trade.filledRaw, dec))} tone="win" />
                <Row label="Transaction" value={<TxLink hash={trade.hash} explorer={explorer} />} />
                <Row
                  label="Attribution"
                  value={
                    trade.tagged ? (
                      <span>
                        via {partner?.name ?? `partner ${opts.partner}`} ·{" "}
                        {/* The tick is the receipt: it goes to the transaction that carries
                            the tag, so "on-chain" is a claim the reader can check. */}
                        <TxLink hash={trade.hash} explorer={explorer} label="on-chain ✓" />
                      </span>
                    ) : (
                      "untagged"
                    )
                  }
                />
              </dl>
              <p class="note">Settles when this window closes. You can keep the card open — it will flip to the result.</p>
              <button type="button" class="btn" data-variant="ghost" onClick={() => setPhase("trade")}>
                Place another
              </button>
            </>
          )}
        </div>
      ) : phase === "pending" ? (
        <div class="result">
          <div class="verdict" style="font-size:20px">
            {stage ?? "working"}…
          </div>
          <p class="note">Keep this open. Somnia blocks land in about a tenth of a second, so this is usually instant.</p>
        </div>
      ) : phase === "confirm" && q && side ? (
        <>
          <dl class="rows">
            <Row label="Buying" value={`${money(fromRaw(q.qty, dec), 2)} ${side} shares`} />
            <Row label="Avg price · limit" value={`${pct(fromRaw(q.avgPriceOwn ?? q.limitOwn, dec))} · ${pct(fromRaw(q.limitOwn, dec))}`} />
            <Row label="You pay" value={usd(fromRaw(q.cost, dec))} tone="loss" />
            <Row label="Pays if right" value={usd(fromRaw(q.payoutIfWin, dec))} tone="win" />
            <Row label="Profit if right" value={usd(fromRaw(q.profitIfWin, dec))} tone="win" />
          </dl>
          {q.depthLimited ? <Notice>Book depth limits this order to {money(fromRaw(q.qty, dec), 2)} shares.</Notice> : null}
          {error ? <Notice tone="warn">{error}</Notice> : null}
          <div class="act">
            <button type="button" class="btn" data-variant={side === "UP" ? "up" : "down"} onClick={() => void confirmTrade()} disabled={!q.ok || !enoughCollateral}>
              Confirm {side} · {usd(fromRaw(q.cost, dec))}
            </button>
            <button type="button" class="btn" data-variant="ghost" onClick={() => { setPhase("trade"); setError(null); }}>
              Back
            </button>
          </div>
        </>
      ) : (
        <>
          <Sides upProb={upProb} downProb={downProb} selected={side} upDisabled={upDisabled} downDisabled={downDisabled} onSelect={setSide} />
          {!live && market ? (
            <Notice>
              This window is {market.statusName.toLowerCase()}. {market.status === MarketStatus.Locked ? "It settles in a few seconds; the next window is already open." : "The next window opens shortly."}
            </Notice>
          ) : upDisabled && downDisabled ? (
            <Notice tone="warn">No one is quoting this market right now, so there is nothing to buy on either side.</Notice>
          ) : upDisabled || downDisabled ? (
            <Notice>No offers on {upDisabled ? "UP" : "DOWN"} at the moment — that side is disabled until someone quotes it.</Notice>
          ) : null}

          <Amounts presets={presets} value={amount} onChange={setAmount} />

          {q && q.ok ? (
            <dl class="rows">
              <Row label="Shares" value={money(fromRaw(q.qty, dec), 2)} />
              <Row label="Max loss" value={usd(fromRaw(q.cost, dec))} tone="loss" />
              <Row label="Profit if right" value={usd(fromRaw(q.profitIfWin, dec))} tone="win" />
            </dl>
          ) : side && q && !q.ok ? (
            <dl class="rows">
              <Row label="Cannot quote" value={q.reason ?? "unavailable"} />
            </dl>
          ) : (
            <dl class="rows">
              <Row label="Shares" value="—" />
              <Row label="Max loss" value="—" />
              <Row label="Profit if right" value="—" />
            </dl>
          )}

          {error ? <Notice tone="warn">{error}</Notice> : null}
          {wallet && !enoughCollateral ? (
            <Notice tone="warn">
              Not enough tUSDC for this size.{" "}
              {network === "testnet" ? (
                <button
                  type="button"
                  class="btn sm"
                  style="display:inline-flex;margin-top:6px"
                  onClick={() => void (async () => {
                    if (!wallet || !ctx) return;
                    try {
                      await faucet(rpc, wallet, addresses.collateral, BigInt(FAUCET_AMOUNT) * ctx.one);
                      await refreshBalances(wallet, ctx);
                    } catch (e) {
                      setError((e as Error).message);
                    }
                  })()}
                >
                  Get {FAUCET_AMOUNT} more
                </button>
              ) : null}
            </Notice>
          ) : null}

          <div class="act">
            {!wallet ? (
              <>
                <button type="button" class="btn" onClick={() => void startInstantWallet()}>
                  Trade in one click
                </button>
                {injectedProvider() ? (
                  <button type="button" class="btn" data-variant="ghost" onClick={() => void connectWallet()}>
                    Use my wallet
                  </button>
                ) : null}
                <p class="note">
                  One click creates a <b>testnet</b> wallet in this browser and funds it. The key never leaves this device.
                  {/* The second path was only ever a button that vanished when no wallet
                      was installed, so a reader with MetaMask closed had no idea it
                      existed. Name it in the hint, and make the words themselves the
                      control. */}
                  {injectedProvider() ? (
                    <>
                      {" "}
                      <button type="button" class="linkish" onClick={() => void connectWallet()}>
                        Or use your own wallet
                      </button>
                      {" — we will add or switch to Somnia Shannon for you."}
                    </>
                  ) : (
                    " Or install a browser wallet to trade with your own address."
                  )}
                </p>
              </>
            ) : (
              <>
                <button
                  type="button"
                  class="btn"
                  data-variant={side === "DOWN" ? "down" : "up"}
                  // Gate the FIRST call to action, not just the one on the confirm
                  // screen: showing "not enough tUSDC" beside a live green button
                  // walks the user forward into a dead end.
                  disabled={!q || !q.ok || !live || !enoughCollateral}
                  onClick={() => setPhase("confirm")}
                >
                  {side ? `Review ${side} · ${usd(amount)}` : "Pick UP or DOWN"}
                </button>
                <PositionsStrip
                  open={openPositions}
                  claimTotal={claimable?.total ?? 0}
                  claimCount={claimRows.length}
                  claiming={claiming}
                  nowSec={now}
                  onOpen={() => {
                    if (trade) setPhase("receipt");
                  }}
                  onClaim={() => void claimAll(claimRows)}
                />
                <WalletBar
                  wallet={wallet}
                  balances={balances}
                  decimals={dec}
                  canSwitch={wallet.kind === "instant" ? injectedProvider() !== null : hasInstantWallet(chain.id) || true}
                  switching={switching}
                  onSwitch={() => void switchWallet()}
                  onForget={() => {
                    forgetInstantWallet(chain.id);
                    setWallet(null);
                    setBalances(null);
                    setClaimable(null);
                  }}
                />
              </>
            )}
          </div>
        </>
      )}

      <RecentStrip markets={recent} />
      <div style="padding:0 var(--s4) var(--s3)">
        <Brand partner={opts.partner} api={api.base} tagged={userData !== 0n} wsDown={wsStatus !== "open"} />
      </div>
    </div>
  );
}

function WalletBar(props: {
  wallet: RelayWallet;
  balances: { gas: bigint; collateral: bigint } | null;
  decimals: number;
  canSwitch?: boolean;
  switching?: boolean;
  onSwitch?: () => void;
  onForget: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const isInstant = props.wallet.kind === "instant";
  return (
    <div class="brand" style="margin-top:2px">
      <span class="mono" title={props.wallet.address}>
        {shortAddr(props.wallet.address)}
        {props.balances ? ` · ${money(fromRaw(props.balances.collateral, props.decimals), 2)} tUSDC` : ""}
      </span>
      {isInstant ? (
        <span style="display:flex;gap:8px">
          <button
            type="button"
            class="btn sm"
            data-variant="ghost"
            style="padding:2px 6px;min-height:0;font-size:10px"
            onClick={() => {
              const k = props.wallet.exportKey?.();
              if (!k) return;
              void navigator.clipboard?.writeText(k).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              });
            }}
          >
            {copied ? "copied" : "export"}
          </button>
          {props.canSwitch && props.onSwitch ? (
            <button type="button" class="btn sm" data-variant="ghost" style="padding:2px 6px;min-height:0;font-size:10px" disabled={props.switching} onClick={props.onSwitch} title="Use your own wallet instead. This browser wallet is kept.">
              {props.switching ? "…" : "switch"}
            </button>
          ) : null}
          <button type="button" class="btn sm" data-variant="ghost" style="padding:2px 6px;min-height:0;font-size:10px" onClick={props.onForget}>
            forget
          </button>
        </span>
      ) : (
        <span style="display:flex;gap:8px;align-items:center">
          connected
          {props.canSwitch && props.onSwitch ? (
            <button type="button" class="btn sm" data-variant="ghost" style="padding:2px 6px;min-height:0;font-size:10px" disabled={props.switching} onClick={props.onSwitch} title="Go back to the one-click browser wallet">
              {props.switching ? "…" : "switch"}
            </button>
          ) : null}
        </span>
      )}
    </div>
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function surfaceId(surface: string | undefined): number {
  const key = (surface ?? "web").toUpperCase() as keyof typeof SURFACE;
  return SURFACE[key] ?? SURFACE.WEB;
}
