// Relay for agents.
//
// A bot is a surface like any other. It reads the same markets a widget reads, sends
// the same order the widget sends, and carries the same two things in it: a partner id
// in `userData` and a builder address on the fee channel. The only difference is
// surface=agent, so the flow can be told apart on the leaderboard.
//
// What this wraps is @relay/core, which is the same code the widget and the scripts
// use — this is a smaller front door onto it, not a second implementation. Reads go
// through the Relay API (markets, books, positions, claimable); writes go straight to
// the chain from the caller's own key.

import { createPublicClient, createWalletClient, http, type Account, type Address, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  ADDRESSES,
  COLLATERAL_DECIMALS,
  SURFACE,
  ZERO_ADDRESS,
  relayChain,
  encodeUserData,
  placeTakerBuy,
  redeemIfWinner,
  type DecodedUserData,
  type Network,
} from "@relay/core";

export interface RelayConfig {
  rpcUrl: string;
  /** The agent's own key. Never leaves this process; every order is signed locally. */
  privateKey: Hex;
  /** Relay API base, e.g. https://relay-server-htey.onrender.com */
  apiUrl: string;
  /** The operator's Relay partner id — who gets credited for this agent's flow. */
  partnerId: number;
  /**
   * The operator's builder code. On mainnet this is the address the builder fee is
   * paid to; on testnet the cap is 0, so it is an identity and costs the taker
   * nothing.
   */
  builder?: Address;
  network?: Network;
  /** Order lifetime in seconds; capped at the market's own expiry. Default 45. */
  expireInSec?: number;
  log?: (s: string) => void;
}

export interface AgentMarket {
  marketId: Hex;
  asset: string;
  intervalSec: number;
  status: number;
  expiry: number;
  secondsToExpiry: number;
  question: string;
  openingPriceRaw: string | null;
  /** "UP" | "DOWN" once resolved, null before. Not an index — the API names it. */
  winner?: "UP" | "DOWN" | null | undefined;
  voided?: boolean | undefined;
  book?: { bestBid: number | null; bestAsk: number | null } | undefined;
}

export interface BuyArgs {
  /** Either a specific market, or the series to take the current window of. */
  marketId?: Hex;
  asset?: string;
  intervalSec?: number;
  side: "UP" | "DOWN";
  /** Collateral to spend, in whole units (1 = $1 tUSDC). */
  budget: number;
  /** Highest price to pay for the chosen side, 0–1. Default 0.98. */
  maxPrice?: number;
}

export interface BuyResult {
  txHash: Hex;
  /** Outcome tokens actually filled, in whole units. */
  filled: number;
  /** Volume-weighted average price paid for the side, 0–1; null if nothing filled. */
  avgPrice: number | null;
  /** Collateral actually spent, in whole units. */
  spent: number;
  /** The attribution the chain recorded — read back from the order's own log. */
  tag: DecodedUserData & { builder: Address };
  marketId: Hex;
  side: "UP" | "DOWN";
}

export interface AgentPosition {
  marketId: string;
  asset: string;
  intervalSec: number;
  expiry: number;
  status: number;
  winner: "UP" | "DOWN" | null;
  voided: boolean;
  yes: number;
  no: number;
  redeemable: boolean;
}

export interface ClaimAllResult {
  claimed: { marketId: string; amount: number; txHash: Hex }[];
  /** Total redeemed, in whole units. */
  total: number;
}

export interface Relay {
  address: Address;
  partnerId: number;
  builder: Address;
  markets: {
    live(q?: { asset?: string; intervalSec?: number; limit?: number }): Promise<AgentMarket[]>;
    recent(q?: { asset?: string; intervalSec?: number; limit?: number }): Promise<AgentMarket[]>;
    get(marketId: Hex): Promise<AgentMarket>;
  };
  buy(args: BuyArgs): Promise<BuyResult>;
  positions(): Promise<AgentPosition[]>;
  claimAll(): Promise<ClaimAllResult>;
}

const clean = (u: string) => u.replace(/\/$/, "");

export function createRelay(cfg: RelayConfig): Relay {
  // Named up front, because the alternative is a TypeError from inside a helper three
  // frames down — which is what an unset env var actually looked like the first time
  // the example bot ran.
  for (const k of ["rpcUrl", "privateKey", "apiUrl"] as const) {
    if (!cfg[k]) throw new Error(`createRelay: ${k} is required (got ${cfg[k] === undefined ? "undefined" : JSON.stringify(cfg[k])})`);
  }
  if (!Number.isInteger(cfg.partnerId) || cfg.partnerId <= 0) {
    throw new Error(`createRelay: partnerId must be a positive integer (got ${JSON.stringify(cfg.partnerId)}). Register one with POST /v1/partners.`);
  }

  const network: Network = cfg.network ?? "testnet";
  const decimals = COLLATERAL_DECIMALS[network];
  const one = 10 ** decimals;
  const addresses = ADDRESSES[network];
  const api = clean(cfg.apiUrl);
  const log = cfg.log ?? (() => undefined);

  const account: Account = privateKeyToAccount(cfg.privateKey);
  const chain = relayChain({ network, rpcUrl: cfg.rpcUrl });
  const transport = http(cfg.rpcUrl);
  const publicClient = createPublicClient({ chain, transport }) as PublicClient;
  const walletClient = createWalletClient({ account, chain, transport }) as WalletClient;

  const builder = cfg.builder ?? ZERO_ADDRESS;
  // One tag for every order this agent sends, so the leaderboard can separate agent
  // flow from web and telegram flow without guessing.
  const userData = encodeUserData({ partnerId: cfg.partnerId, surfaceId: SURFACE.AGENT });

  const get = async <T>(path: string): Promise<T> => {
    const r = await fetch(`${api}${path}`);
    if (!r.ok) throw new Error(`${path} → ${r.status} ${(await r.text().catch(() => "")).slice(0, 200)}`);
    return (await r.json()) as T;
  };

  const query = (q: { asset?: string; intervalSec?: number; limit?: number } = {}) => {
    const p = new URLSearchParams();
    if (q.asset) p.set("asset", q.asset.toUpperCase());
    if (q.intervalSec) p.set("intervalSec", String(q.intervalSec));
    p.set("limit", String(q.limit ?? 10));
    return p.toString();
  };

  const markets = {
    live: (q = {}) => get<AgentMarket[]>(`/v1/markets/live?${query(q)}&book=true`),
    recent: (q = {}) => get<AgentMarket[]>(`/v1/markets/recent?${query(q)}`),
    get: (marketId: Hex) => get<AgentMarket>(`/v1/markets/${marketId}`),
  };

  async function resolveMarket(a: BuyArgs): Promise<AgentMarket> {
    if (a.marketId) return markets.get(a.marketId);
    if (!a.asset || !a.intervalSec) throw new Error("buy() needs either marketId or both asset and intervalSec");
    const live = await markets.live({ asset: a.asset, intervalSec: a.intervalSec, limit: 5 });
    // Trading, and with enough runway that an IOC is not racing the close.
    const m = live.find((x) => x.status === 1 && x.secondsToExpiry > 10);
    if (!m) throw new Error(`no live ${a.asset} ${a.intervalSec}s window is trading right now`);
    return m;
  }

  return {
    address: account.address,
    partnerId: cfg.partnerId,
    builder,
    markets,

    async buy(a: BuyArgs): Promise<BuyResult> {
      const m = await resolveMarket(a);
      const maxPrice = BigInt(Math.round((a.maxPrice ?? 0.98) * one));
      const budgetCollateral = BigInt(Math.round(a.budget * one));

      const res = await placeTakerBuy({
        publicClient,
        walletClient,
        account,
        binaryModule: addresses.binaryModule,
        marketId: m.marketId,
        outcome: a.side,
        budgetCollateral,
        maxPrice,
        partner: { builder, builderFeeBpsTimes1k: 0n, userData },
        ...(cfg.expireInSec === undefined ? {} : { expireInSec: cfg.expireInSec }),
        log,
      });

      if (res.status === "reverted") throw new Error(`order reverted (${res.hash})`);
      return {
        txHash: res.hash,
        filled: Number(res.filled) / one,
        avgPrice: res.fillPriceOwn === null ? null : Number(res.fillPriceOwn) / one,
        spent: Number(res.spentCollateral) / one,
        // Read back from the OrderPlaced log, not from what we intended to send.
        tag: { ...res.tag, builder },
        marketId: m.marketId,
        side: a.side,
      };
    },

    positions: () => get<{ positions: AgentPosition[] }>(`/v1/wallets/${account.address}/positions`).then((r) => r.positions ?? []),

    async claimAll(): Promise<ClaimAllResult> {
      const c = await get<{ binaryModule: Address; claims: { marketId: Hex; amount: number }[] }>(`/v1/wallets/${account.address}/claimable`);
      const out: ClaimAllResult = { claimed: [], total: 0 };
      // Sequential on purpose: they share one account, and two redemptions racing for
      // the same nonce is a lost transaction, not a faster one.
      for (const claim of c.claims) {
        const r = await redeemIfWinner({
          publicClient,
          walletClient,
          account,
          binaryModule: c.binaryModule ?? addresses.binaryModule,
          marketId: claim.marketId,
          log,
        });
        for (const done of r.redeemed) {
          out.claimed.push({ marketId: claim.marketId, amount: Number(done.amount) / one, txHash: done.hash });
          out.total += Number(done.amount) / one;
        }
      }
      return out;
    },
  };
}

export { SURFACE } from "@relay/core";
