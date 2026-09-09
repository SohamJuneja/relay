// On-chain MarketStatus enum (IBinaryMarket.status()).
// Source: dreamdex-bot-kit/packages/ec-core/src/markets.ts MARKET_STATUS and the
// markets-sdk MarketOnchain docs. Only `Trading` (1) accepts orders.

export const MarketStatus = {
  Listed: 0,
  Trading: 1,
  Locked: 2,
  Settling: 3,
  Resolved: 4,
  Voided: 5,
} as const;

export type MarketStatusCode = (typeof MarketStatus)[keyof typeof MarketStatus];

const NAMES: Record<number, string> = {
  0: "Listed",
  1: "Trading",
  2: "Locked",
  3: "Settling",
  4: "Resolved",
  5: "Voided",
};

export function marketStatusName(code: number | bigint | null | undefined): string {
  if (code === null || code === undefined) return "unknown";
  const n = Number(code);
  return NAMES[n] ?? `status#${n}`;
}

/** "Trading (1)" — the format the probe prints. */
export function marketStatusLabel(code: number | bigint | null | undefined): string {
  if (code === null || code === undefined) return "unknown";
  return `${marketStatusName(code)} (${Number(code)})`;
}

export const isTradingStatus = (code: number | bigint | null | undefined): boolean =>
  code !== null && code !== undefined && Number(code) === MarketStatus.Trading;

/**
 * Indexer-side status names (markets-sdk store.d.ts BinaryMarketStatus).
 * Note the extra terminal `"Finalized"` the chain enum does not have.
 */
export type IndexerMarketStatus =
  | "Listed"
  | "Trading"
  | "Locked"
  | "Settling"
  | "Resolved"
  | "Voided"
  | "Finalized";
