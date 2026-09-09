import type { Address, Hex } from "viem";

export type Theme = "auto" | "light" | "dark";
export type Outcome = "UP" | "DOWN";

export interface RelayOptions {
  /** Relay partner id (from POST /v1/partners). Missing → orders go out untagged. */
  partner?: number | undefined;
  /** Partner builder code (an address). Missing → builder = address(0). */
  builder?: Address | undefined;
  asset?: string | undefined;
  intervalSec?: number | undefined;
  surface?: string | undefined;
  theme?: Theme | undefined;
  /** Relay API base, e.g. http://localhost:8787 */
  api?: string | undefined;
  /** Venue override; defaults to the API's configured DreamDEX venue. */
  venue?: Hex | undefined;
  /** Preset amount chips, in collateral units. */
  amounts?: number[] | undefined;
  /** Show the "via Relay" footer mark. Default true. */
  brand?: boolean | undefined;
  /** Show the plain-language question line under the header. Default true. */
  question?: boolean | undefined;
}

export interface BookLevel {
  price: number;
  quantity: number;
  priceRaw: string;
  quantityRaw: string;
}

export interface Book {
  pool: Address;
  ts: number;
  yesBids: BookLevel[];
  yesAsks: BookLevel[];
  noBids: BookLevel[];
  noAsks: BookLevel[];
  bestBid: number | null;
  bestAsk: number | null;
  mid: number | null;
  spread: number | null;
  empty: boolean;
}

export interface Market {
  marketId: Hex;
  marketAddress: Address;
  pool: Address;
  venueId: Hex;
  operatorId: number;
  asset: string;
  intervalSec: number;
  windowSec: number;
  tradingStart: number;
  expiry: number;
  secondsToExpiry: number;
  strikeRaw: string;
  mode: "reference" | "fixed";
  question: string;
  status: number;
  statusName: string;
  oracleQuestionId: string;
  referenceQuestionId: string | null;
  openingPriceRaw: string | null;
  openingPrice: number | null;
  closingPriceRaw: string | null;
  closingPrice: number | null;
  payoutNumerators: string[] | null;
  winner: Outcome | null;
  voided: boolean;
  finalized: boolean;
  resolvedAt: number | null;
  createdBlock: number;
  createdTx: string;
  book?: Book | null;
  fills?: number;
  notional?: number;
}

export interface PriceTick {
  asset: string;
  price: number;
  ema: number;
  ts: number;
  sampledAt: number;
  source: string;
}

export interface FillRow {
  id: number;
  marketId: Hex | null;
  pool: Address;
  block: number;
  blockTs: number;
  txHash: string;
  logIndex: number;
  takerOrderId: string;
  makerOrderId: string;
  price: number;
  quantity: number;
  notional: number;
  takerOwner: Address | null;
  takerSide: string | null;
  takerPartnerId: number | null;
  takerSurfaceId: number | null;
  takerBuilder: Address | null;
  takerPartnerName?: string | null;
}

export interface ClaimRow {
  marketId: Hex;
  operatorId: number;
  venueId: Hex;
  outcomeIdx: number;
  outcome: Outcome;
  amount: number;
  amountRaw: string;
  asset: string;
  intervalSec: number;
  expiry: number;
  voided: boolean;
  reason: "won" | "voided";
}

export interface Claimable {
  address: Address;
  outcomeToken: Address;
  binaryModule: Address;
  total: number;
  totalRaw: string;
  count: number;
  claims: ClaimRow[];
}

export interface Health {
  ok: boolean;
  network: string;
  cursorBlock: number | null;
  headBlock: number;
  lagBlocks: number | null;
  lagSeconds: number | null;
  dbOk: boolean;
}

export type WsEvent =
  | { type: "hello"; data: unknown }
  | { type: "subscribed"; data: unknown }
  | { type: "book"; data: Book & { marketId: Hex } }
  | { type: "fill"; data: FillRow }
  | { type: "price"; data: PriceTick }
  | { type: "market_created"; data: Market }
  | { type: "market_locked"; data: Market }
  | { type: "market_resolved"; data: Market };

/** Steps the instant-wallet onboarding walks through, shown one by one. */
export type OnboardStep = "create" | "gas" | "collateral" | "ready";
export type StepState = "idle" | "running" | "done" | "error";

/** One outcome balance the wallet holds, from GET /v1/wallets/:address/positions. */
export interface Position {
  marketId: Hex;
  asset: string;
  intervalSec: number;
  expiry: number;
  status: number;
  winner: Outcome | null;
  voided: boolean;
  yes: number;
  no: number;
  yesRaw: string;
  noRaw: string;
  redeemable: boolean;
  redeemableOutcome: number[];
  operatorId: number;
  venueId: Hex;
}

/** Public partner card from GET /v1/partners/:id/public. */
export interface PartnerPublic {
  partnerId: number;
  name: string;
  fills: number;
  notional: number;
  marketsTouched: number;
  since: string;
}
