// Pick a Trading market on our venue with a two-sided book and enough time left.
// Shared by builder-matrix.ts and trade.ts; the pick is persisted under artifacts/
// so the settle step follows the SAME market.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import { MarketStatus, discoverMarketsFromLogs, readMarketStatuses, readYesBooks, summarizeYes, type DiscoveredMarket } from "@relay/core";
import type { Phase1Env } from "./_env.js";

export const ARTIFACTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../artifacts");
export const PHASE1_FILE = path.join(ARTIFACTS_DIR, "phase1.json");

export interface Phase1State {
  pickedAt?: string;
  market?: {
    marketId: Hex;
    market: Address;
    pool: Address;
    asset: string;
    intervalSec: number;
    tradingStart: number;
    expiry: number;
    operatorId: number;
    venueId: Hex;
    yesId: string;
    noId: string;
  };
  partner?: { builder: Address };
  approveBuilderTx?: Hex;
  matrix?: Record<string, string>;
  trades?: { variant: string; hash: Hex; outcome: "UP" | "DOWN"; qty: string; filled: string; fillPriceOwn: string | null; userData: string; builder: Address }[];
  balances?: { tusdcBefore: string; tusdcAfter: string; yesAfter: string; noAfter: string };
  settlement?: {
    finalStatus: number;
    transitions: { status: number; name: string; at: string; block: string }[];
    payoutNumerators: string[];
    winningOutcome: 0 | 1 | null;
    action: string;
    redeemTxs: Hex[];
    collateralBefore: string;
    collateralAfter: string;
  };
}

export function loadState(): Phase1State {
  if (!existsSync(PHASE1_FILE)) return {};
  return JSON.parse(readFileSync(PHASE1_FILE, "utf8")) as Phase1State;
}

export function saveState(s: Phase1State): void {
  mkdirSync(ARTIFACTS_DIR, { recursive: true });
  writeFileSync(PHASE1_FILE, JSON.stringify(s, null, 2));
}

export interface PickOptions {
  minLeftSec?: number;
  preferIntervals?: number[];
  /** Blocks of MarketCreated history to scan (100 ms blocks → 36_000 ≈ 1 h). */
  lookbackBlocks?: bigint;
}

export interface Pick {
  m: DiscoveredMarket;
  summary: ReturnType<typeof summarizeYes>;
}

export async function pickTradingMarket(env: Phase1Env, opts: PickOptions = {}): Promise<Pick> {
  const pc = env.publicClient;
  const minLeft = opts.minLeftSec ?? 60;
  const prefer = opts.preferIntervals ?? [300, 900];
  const head = await pc.getBlockNumber();
  const lookback = opts.lookbackBlocks ?? 36_000n;
  const all = await discoverMarketsFromLogs({ client: pc, binaryModule: env.addresses.binaryModule, fromBlock: head - lookback, toBlock: head, concurrency: 8 });
  const now = Math.floor(Date.now() / 1000);
  const onVenue = all.filter((m) => m.venueId.toLowerCase() === env.venueId && m.expiry - now >= minLeft);
  const st = await readMarketStatuses(pc, onVenue.map((m) => m.market));
  const trading = onVenue.filter((_, i) => st[i] === MarketStatus.Trading);
  const books = await readYesBooks(pc, trading.map((m) => m.pool), 5);
  const candidates: Pick[] = [];
  trading.forEach((m, i) => {
    const b = books[i];
    if (!b || "error" in b) return;
    const s = summarizeYes(b, env.decimals);
    if (s.bidEmpty || s.askEmpty) return;
    candidates.push({ m, summary: s });
  });
  if (candidates.length === 0) {
    throw new Error(`no Trading market on venue ${env.venueId} with a two-sided book and ≥${minLeft}s left (scanned ${all.length} MarketCreated, ${onVenue.length} on venue, ${trading.length} Trading)`);
  }
  // Prefer the preferred cadences; among those, the one with the MOST time left
  // (so the matrix + the real trade land in the same window).
  const rank = (p: Pick) => {
    const pi = prefer.indexOf(p.m.intervalSec);
    return [pi === -1 ? prefer.length : pi, -(p.m.expiry - now)] as const;
  };
  candidates.sort((x, y) => {
    const [a1, a2] = rank(x);
    const [b1, b2] = rank(y);
    return a1 !== b1 ? a1 - b1 : a2 - b2;
  });
  return candidates[0]!;
}

export function stateFromPick(p: Pick): NonNullable<Phase1State["market"]> {
  return {
    marketId: p.m.marketId,
    market: p.m.market,
    pool: p.m.pool,
    asset: p.m.asset,
    intervalSec: p.m.intervalSec,
    tradingStart: p.m.tradingStart,
    expiry: p.m.expiry,
    operatorId: p.m.operatorId,
    venueId: p.m.venueId,
    yesId: p.m.yesId.toString(),
    noId: p.m.noId.toString(),
  };
}
