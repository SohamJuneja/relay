// Row → API object mappers.

import { ORDER_KIND_NAMES, marketStatusName } from "@relay/core";
import type { fills as fillsT, markets as marketsT } from "@relay/indexer";

type MarketRow = typeof marketsT.$inferSelect;
type FillRow = typeof fillsT.$inferSelect;

export const HUB_DP = 2; // OracleHub answers in 2 decimals (PROTOCOL_NOTES §12)

export function effectiveStatus(m: Pick<MarketRow, "status" | "expiry">, nowSec: number): number {
  if (m.status < 4 && Number(m.expiry) <= nowSec) return 2;
  return m.status;
}

export function marketToApi(m: MarketRow, nowSec: number) {
  const status = effectiveStatus(m, nowSec);
  const op = m.openingPriceRaw ? Number(m.openingPriceRaw) / 10 ** HUB_DP : null;
  const cp = m.closingPriceRaw ? Number(m.closingPriceRaw) / 10 ** HUB_DP : null;
  return {
    marketId: m.marketId,
    marketAddress: m.marketAddress,
    pool: m.pool,
    venueId: m.venueId,
    operatorId: m.operatorId,
    asset: m.asset,
    intervalSec: m.intervalSec,
    windowSec: m.windowSec,
    tradingStart: Number(m.tradingStart),
    expiry: Number(m.expiry),
    secondsToExpiry: Math.max(0, Number(m.expiry) - nowSec),
    strikeRaw: m.strikeRaw,
    mode: m.strikeRaw === "0" ? ("reference" as const) : ("fixed" as const),
    question: m.question,
    status,
    statusName: marketStatusName(status),
    oracleQuestionId: m.oracleQuestionId,
    referenceQuestionId: m.referenceQuestionId ?? null,
    openingPriceRaw: m.openingPriceRaw ?? null,
    openingPrice: op,
    closingPriceRaw: m.closingPriceRaw ?? null,
    closingPrice: cp,
    payoutNumerators: m.payoutNumerators ?? null,
    winner: m.winner === 0 ? ("UP" as const) : m.winner === 1 ? ("DOWN" as const) : null,
    voided: m.voided,
    finalized: m.finalized,
    resolvedAt: m.resolvedAt === null ? null : Number(m.resolvedAt),
    createdBlock: Number(m.createdBlock),
    createdTx: m.createdTx,
  };
}

export function fillToApi(f: FillRow, decimals: number) {
  const one = 10 ** decimals;
  return {
    id: f.id,
    marketId: f.marketId ?? null,
    pool: f.pool,
    block: Number(f.block),
    blockTs: Number(f.blockTs),
    txHash: f.txHash,
    logIndex: f.logIndex,
    takerOrderId: f.takerOrderId,
    makerOrderId: f.makerOrderId,
    price: Number(f.fillPrice) / one,
    priceRaw: f.fillPrice,
    quantity: Number(f.quantity) / one,
    quantityRaw: f.quantity,
    notional: Number(f.notional) / one,
    notionalRaw: f.notional,
    takerOwner: f.takerOwner ?? null,
    takerKind: f.takerKind ?? null,
    takerSide: f.takerKind === null || f.takerKind === undefined ? null : (ORDER_KIND_NAMES[f.takerKind] ?? null),
    takerPartnerId: f.takerPartnerId ?? null,
    takerSurfaceId: f.takerSurfaceId ?? null,
    takerBuilder: f.takerBuilder ?? null,
    makerOwner: f.makerOwner ?? null,
    makerPartnerId: f.makerPartnerId ?? null,
    makerBuilder: f.makerBuilder ?? null,
  };
}

export const rowsOf = (r: unknown): Record<string, unknown>[] => (Array.isArray(r) ? (r as Record<string, unknown>[]) : ((r as { rows?: Record<string, unknown>[] }).rows ?? []));
