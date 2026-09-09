import { z } from "zod";

export const Hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/, "bytes32 hex");
export const AddressZ = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "address");
export const Numeric = z.string().regex(/^-?\d+$/, "integer string");

export const BookLevel = z.object({ price: z.number(), quantity: z.number(), priceRaw: Numeric, quantityRaw: Numeric });
export const Book = z.object({
  pool: AddressZ,
  ts: z.number(),
  yesBids: z.array(BookLevel),
  yesAsks: z.array(BookLevel),
  noBids: z.array(BookLevel),
  noAsks: z.array(BookLevel),
  bestBid: z.number().nullable(),
  bestAsk: z.number().nullable(),
  mid: z.number().nullable(),
  spread: z.number().nullable(),
  empty: z.boolean(),
});

export const Market = z.object({
  marketId: Hex32,
  marketAddress: AddressZ,
  pool: AddressZ,
  venueId: Hex32,
  operatorId: z.number(),
  asset: z.string(),
  intervalSec: z.number(),
  windowSec: z.number(),
  tradingStart: z.number(),
  expiry: z.number(),
  secondsToExpiry: z.number(),
  strikeRaw: Numeric,
  /** "reference" (strike 0: up/down vs opening price) or "fixed". */
  mode: z.enum(["reference", "fixed"]),
  question: z.string(),
  status: z.number(),
  statusName: z.string(),
  oracleQuestionId: Numeric,
  referenceQuestionId: Numeric.nullable(),
  /** Hub answers are 2-dp integers: 7845603 = 78456.03. */
  openingPriceRaw: Numeric.nullable(),
  openingPrice: z.number().nullable(),
  closingPriceRaw: Numeric.nullable(),
  closingPrice: z.number().nullable(),
  payoutNumerators: z.array(Numeric).nullable(),
  winner: z.enum(["UP", "DOWN"]).nullable(),
  voided: z.boolean(),
  finalized: z.boolean(),
  resolvedAt: z.number().nullable(),
  createdBlock: z.number(),
  createdTx: z.string(),
});

export const Fill = z.object({
  id: z.number(),
  marketId: Hex32.nullable(),
  pool: AddressZ,
  block: z.number(),
  blockTs: z.number(),
  txHash: z.string(),
  logIndex: z.number(),
  takerOrderId: Numeric,
  makerOrderId: Numeric,
  /** YES-terms probability. */
  price: z.number(),
  priceRaw: Numeric,
  quantity: z.number(),
  quantityRaw: Numeric,
  notional: z.number(),
  notionalRaw: Numeric,
  takerOwner: AddressZ.nullable(),
  takerKind: z.number().nullable(),
  takerSide: z.string().nullable(),
  takerPartnerId: z.number().nullable(),
  takerSurfaceId: z.number().nullable(),
  takerBuilder: AddressZ.nullable(),
  makerOwner: AddressZ.nullable(),
  makerPartnerId: z.number().nullable(),
  makerBuilder: AddressZ.nullable(),
});

/** A fill with the market it happened on named, for tables a person reads. */
export const NamedFill = Fill.extend({
  asset: z.string().nullable(),
  intervalSec: z.number().nullable(),
});

export const Price = z.object({
  asset: z.string(),
  price: z.number(),
  ema: z.number(),
  ts: z.number(),
  sampledAt: z.number(),
  source: z.string(),
});

export const VenueStatsRow = z.object({
  asset: z.string(),
  intervalSec: z.number(),
  day: z.string(),
  windows: z.number(),
  zeroFillWindows: z.number(),
  quotedButUntakenWindows: z.number(),
  fills: z.number(),
  notional: z.number(),
  uniqueTakers: z.number(),
  zeroFillPct: z.number().nullable(),
  quotedButUntakenPct: z.number().nullable(),
});

export const PartnerStats = z.object({
  partnerId: z.number(),
  name: z.string(),
  builderAddress: AddressZ,
  /** Did this partner sign for the builder address, or merely type it in? */
  verified: z.boolean(),
  fills: z.number(),
  notional: z.number(),
  uniqueWallets: z.number(),
  marketsTouched: z.number(),
  projectedBuilderFee: z.number(),
  projectedBuilderFeeBps: z.number(),
  projectionNote: z.string(),
  hourly: z.array(z.object({ hourTs: z.number(), fills: z.number(), notional: z.number(), uniqueWallets: z.number() })),
  computedAt: z.string().nullable(),
});

export const ErrorOut = z.object({ error: z.string(), message: z.string().optional() });
