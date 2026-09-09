// Market discovery straight from chain — no indexer dependency.
//
// The BinaryMarketsModule emits `MarketCreated` for EVERY market (module- or
// creator-created) and is the only creation event carrying (operatorId,
// venueId). We scan it over a block window, then read each market's live
// `status()` from its BinaryMarket clone. `markets(marketId)` on the module is
// the point lookup (what the SDK's getMarketOnchain is built on).
//
// Key by marketId. A pool address is a TIME-VARYING binding — the same pool is
// recycled across successive windows (markets-sdk MarketOnchain docs, kit sharp
// edge #10) — so (pool, nonce) identifies a market's slice of a pool's history.

import type { Address, Hex, PublicClient } from "viem";
import { binaryMarketReadAbi, binaryModuleReadAbi, moduleMarketCreatedEvent } from "./abi/index.js";
import { scanLogs, type ScanProgress } from "./logs.js";
import { batchRead, unwrap } from "./reads.js";

/** Series cadences the indexer recognises (markets-sdk CADENCE_LADDER_SEC). */
export const CADENCE_LADDER_SEC = [60, 300, 900, 3600, 14400, 86400] as const;
/** ± tolerance when snapping a window to a rung (rolls open a second or two late). */
export const CADENCE_TOLERANCE_SEC = 30;

/** Snap `expiry − tradingStart` to a ladder rung; leave odd windows as-is. */
export function snapIntervalSec(windowSec: number): number {
  for (const rung of CADENCE_LADDER_SEC) {
    if (Math.abs(windowSec - rung) <= CADENCE_TOLERANCE_SEC) return rung;
  }
  return windowSec;
}

export interface DiscoveredMarket {
  marketId: Hex;
  market: Address;
  pool: Address;
  oracleQuestionId: bigint;
  operatorId: number;
  venueId: Hex;
  creator: Address;
  collateral: Address;
  yesId: bigint;
  noId: bigint;
  nonce: bigint;
  outcomeSlotCount: number;
  marketType: number;
  tradingStart: number;
  expiry: number;
  voidPolicy: number;
  asset: string;
  strike: bigint;
  question: string;
  context: Hex;
  /** expiry − tradingStart, raw. */
  windowSec: number;
  /** windowSec snapped to the cadence ladder — what the indexer reports as intervalSec. */
  intervalSec: number;
  createdAtBlock: bigint;
  createdTxHash: Hex;
  logIndex: number;
}

export interface DiscoverOptions {
  client: PublicClient;
  binaryModule: Address;
  fromBlock: bigint;
  toBlock: bigint;
  concurrency?: number;
  onProgress?: (p: ScanProgress) => void;
}

/** Every market the module created in the block window, oldest first. */
export async function discoverMarketsFromLogs(opts: DiscoverOptions): Promise<DiscoveredMarket[]> {
  const logs = await scanLogs({
    client: opts.client,
    address: opts.binaryModule,
    events: [moduleMarketCreatedEvent] as const,
    fromBlock: opts.fromBlock,
    toBlock: opts.toBlock,
    ...(opts.concurrency !== undefined ? { concurrency: opts.concurrency } : {}),
    ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
  });
  const out: DiscoveredMarket[] = [];
  for (const log of logs) {
    const a = log.args as Record<string, unknown>;
    if (!a.marketId || !a.pool || !a.market) continue; // strict:false — skip malformed
    const tradingStart = Number(a.tradingStart as bigint);
    const expiry = Number(a.expiry as bigint);
    const windowSec = expiry - tradingStart;
    out.push({
      marketId: a.marketId as Hex,
      market: a.market as Address,
      pool: a.pool as Address,
      oracleQuestionId: (a.oracleQuestionId as bigint) ?? 0n,
      operatorId: Number(a.operatorId ?? 0),
      venueId: (a.venueId as Hex) ?? ("0x" + "0".repeat(64)),
      creator: (a.creator as Address) ?? "0x0000000000000000000000000000000000000000",
      collateral: (a.collateral as Address) ?? "0x0000000000000000000000000000000000000000",
      yesId: (a.yesId as bigint) ?? 0n,
      noId: (a.noId as bigint) ?? 0n,
      nonce: (a.nonce as bigint) ?? 0n,
      outcomeSlotCount: Number(a.outcomeSlotCount ?? 2),
      marketType: Number(a.marketType ?? 0),
      tradingStart,
      expiry,
      voidPolicy: Number(a.voidPolicy ?? 0),
      asset: String(a.asset ?? ""),
      strike: (a.strike as bigint) ?? 0n,
      question: String(a.question ?? ""),
      context: (a.context as Hex) ?? "0x",
      windowSec,
      intervalSec: snapIntervalSec(windowSec),
      createdAtBlock: log.blockNumber ?? 0n,
      createdTxHash: (log.transactionHash ?? "0x") as Hex,
      logIndex: log.logIndex ?? 0,
    });
  }
  return out;
}

/** The module's record for one marketId (raw-chain equivalent of getMarketOnchain's first hop). */
export interface MarketRecord {
  oracleQuestionId: bigint;
  outcomeSlotCount: number;
  voidPolicy: number;
  collateral: Address;
  operatorId: number;
  venueId: Hex;
  oracleAdapter: Address;
  creator: Address;
  market: Address;
  pool: Address;
  yesId: bigint;
  noId: bigint;
  tradingStart: number;
  expiry: number;
  nonce: bigint;
}

export async function readMarketRecord(client: PublicClient, binaryModule: Address, marketId: Hex): Promise<MarketRecord | null> {
  const [rec, nonce] = await Promise.all([
    client.readContract({ address: binaryModule, abi: binaryModuleReadAbi, functionName: "markets", args: [marketId] }),
    client.readContract({ address: binaryModule, abi: binaryModuleReadAbi, functionName: "marketNonce", args: [marketId] }),
  ]);
  if (/^0x0{40}$/i.test(rec[8])) return null;
  return {
    oracleQuestionId: rec[0],
    outcomeSlotCount: rec[1],
    voidPolicy: rec[2],
    collateral: rec[3],
    operatorId: rec[4],
    venueId: rec[5],
    oracleAdapter: rec[6],
    creator: rec[7],
    market: rec[8],
    pool: rec[9],
    yesId: rec[10],
    noId: rec[11],
    tradingStart: Number(rec[12]),
    expiry: Number(rec[13]),
    nonce,
  };
}

/** Live `status()` for many markets; null where the read failed. */
export async function readMarketStatuses(client: PublicClient, marketAddresses: readonly Address[]): Promise<(number | null)[]> {
  const res = await batchRead(
    client,
    marketAddresses.map((address) => ({ address, abi: binaryMarketReadAbi, functionName: "status" })),
  );
  return res.map((r) => {
    const v = unwrap<number | bigint>(r);
    return v === null ? null : Number(v);
  });
}

export interface VenueInference {
  /** Distinct venue ids among the given markets, with counts. */
  byVenue: Map<Hex, number>;
  byOperator: Map<number, number>;
  /** The single venue if every market shares one; else null. */
  inferredVenueId: Hex | null;
  inferredOperatorId: number | null;
}

export function inferVenue(markets: readonly Pick<DiscoveredMarket, "venueId" | "operatorId">[]): VenueInference {
  const byVenue = new Map<Hex, number>();
  const byOperator = new Map<number, number>();
  for (const m of markets) {
    const v = m.venueId.toLowerCase() as Hex;
    byVenue.set(v, (byVenue.get(v) ?? 0) + 1);
    byOperator.set(m.operatorId, (byOperator.get(m.operatorId) ?? 0) + 1);
  }
  const venues = [...byVenue.keys()];
  const ops = [...byOperator.keys()];
  return {
    byVenue,
    byOperator,
    inferredVenueId: venues.length === 1 ? (venues[0] ?? null) : null,
    inferredOperatorId: ops.length === 1 ? (ops[0] ?? null) : null,
  };
}
