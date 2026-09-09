// Relay indexer schema (Postgres, Drizzle).
//
// Conventions:
//   - uint256 / uint128 / uint64 → numeric(78,0) (exact, no overflow); block numbers → bigint.
//   - every chain-derived row carries (block, block_hash, tx_hash, log_index) so a reorg
//     rollback is `DELETE WHERE block > n` and provenance is auditable.
//   - NOTHING is keyed by pool alone: pool_epochs maps (pool, block) → market_id.
//   - addresses are stored lowercase.

import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  serial,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

const u256 = (name: string) => numeric(name, { precision: 78, scale: 0 });
const addr = (name: string) => text(name);

/** One row per network: the last fully-applied block and its hash (reorg anchor). */
export const cursor = pgTable("cursor", {
  network: text("network").primaryKey(),
  lastBlock: bigint("last_block", { mode: "bigint" }).notNull(),
  lastBlockHash: text("last_block_hash"),
  /** First block this cursor ever ingested (backfill start). */
  startBlock: bigint("start_block", { mode: "bigint" }).notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Recent block hashes for parent-hash reorg detection (pruned to the last ~200). */
export const blocks = pgTable("blocks", {
  number: bigint("number", { mode: "bigint" }).primaryKey(),
  hash: text("hash").notNull(),
  parentHash: text("parent_hash").notNull(),
  timestamp: bigint("timestamp", { mode: "bigint" }).notNull(),
});

export const markets = pgTable(
  "markets",
  {
    marketId: text("market_id").primaryKey(),
    marketAddress: addr("market_address").notNull(),
    pool: addr("pool").notNull(),
    venueId: text("venue_id").notNull(),
    operatorId: integer("operator_id").notNull(),
    creator: addr("creator").notNull(),
    collateral: addr("collateral").notNull(),
    yesId: u256("yes_id").notNull(),
    noId: u256("no_id").notNull(),
    nonce: bigint("nonce", { mode: "bigint" }).notNull(),
    asset: text("asset").notNull(),
    intervalSec: integer("interval_sec").notNull(),
    windowSec: integer("window_sec").notNull(),
    tradingStart: bigint("trading_start", { mode: "bigint" }).notNull(),
    expiry: bigint("expiry", { mode: "bigint" }).notNull(),
    strikeRaw: u256("strike_raw").notNull(),
    question: text("question").notNull(),
    voidPolicy: smallint("void_policy").notNull(),
    oracleQuestionId: u256("oracle_question_id").notNull(),
    referenceQuestionId: u256("reference_question_id"),
    /** Chain MarketStatus as far as logs tell us: 1 Trading, 2 Locked (expiry passed), 4 Resolved, 5 Voided. */
    status: smallint("status").notNull().default(1),
    resolvedAt: bigint("resolved_at", { mode: "bigint" }),
    resolvedBlock: bigint("resolved_block", { mode: "bigint" }),
    payoutNumerators: jsonb("payout_numerators").$type<string[]>(),
    payoutDenominator: u256("payout_denominator"),
    winner: smallint("winner"),
    voided: boolean("voided").notNull().default(false),
    finalized: boolean("finalized").notNull().default(false),
    openingPriceRaw: u256("opening_price_raw"),
    closingPriceRaw: u256("closing_price_raw"),
    /**
     * Did this market ever have a resting bid, and a resting ask?
     *
     * These exist so "quoted but untaken" survives order retention. Deriving that
     * statistic by counting rows in `orders` meant keeping every order ever placed:
     * on this venue that is ~875 000 rows a day at ~635 bytes, which no free tier
     * holds for a month. Two booleans per market is 4 400 rows a day instead.
     */
    hadBid: boolean("had_bid").notNull().default(false),
    hadAsk: boolean("had_ask").notNull().default(false),
    createdBlock: bigint("created_block", { mode: "bigint" }).notNull(),
    createdBlockHash: text("created_block_hash").notNull(),
    createdTx: text("created_tx").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("markets_venue_expiry_idx").on(t.venueId, t.expiry),
    index("markets_expiry_idx").on(t.expiry),
    index("markets_pool_idx").on(t.pool),
    index("markets_status_idx").on(t.status),
  ],
);

/** Pool → market binding over time. A pool serves successive markets (nonce++ on recycle). */
export const poolEpochs = pgTable(
  "pool_epochs",
  {
    id: serial("id").primaryKey(),
    pool: addr("pool").notNull(),
    marketId: text("market_id").notNull(),
    nonce: bigint("nonce", { mode: "bigint" }).notNull(),
    fromBlock: bigint("from_block", { mode: "bigint" }).notNull(),
    toBlock: bigint("to_block", { mode: "bigint" }),
  },
  (t) => [index("pool_epochs_pool_from_idx").on(t.pool, t.fromBlock), uniqueIndex("pool_epochs_market_uq").on(t.marketId)],
);

export const orders = pgTable(
  "orders",
  {
    pool: addr("pool").notNull(),
    orderId: u256("order_id").notNull(),
    marketId: text("market_id"),
    owner: addr("owner").notNull(),
    isBid: boolean("is_bid").notNull(),
    /** BinaryOrderPlaced.kind: 0 BUY_YES · 1 SELL_YES · 2 BUY_NO · 3 SELL_NO. */
    kind: smallint("kind"),
    price: u256("price").notNull(),
    quantity: u256("quantity").notNull(),
    /** Not on any log (only in calldata); null unless a later enrichment fills it. */
    orderType: smallint("order_type"),
    userData: u256("user_data").notNull(),
    tagVersion: smallint("tag_version").notNull(),
    partnerId: integer("partner_id"),
    surfaceId: integer("surface_id"),
    builder: addr("builder"),
    expireNs: u256("expire_ns").notNull(),
    placedBlock: bigint("placed_block", { mode: "bigint" }).notNull(),
    /** Block timestamp (s), interpolated from the chunk's boundary headers. */
    placedTs: bigint("placed_ts", { mode: "bigint" }).notNull(),
    blockHash: text("block_hash").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    /** Quantity resting after placement (OrderPlaced.quantityRemaining when OrderRested fired). */
    restedQty: u256("rested_qty"),
    filledQty: u256("filled_qty").notNull().default("0"),
    cancelled: boolean("cancelled").notNull().default(false),
    expired: boolean("expired").notNull().default(false),
  },
  (t) => [
    primaryKey({ columns: [t.pool, t.orderId] }),
    index("orders_market_idx").on(t.marketId),
    index("orders_owner_idx").on(t.owner),
    index("orders_partner_block_idx").on(t.partnerId, t.placedBlock),
    index("orders_block_idx").on(t.placedBlock),
  ],
);

export const fills = pgTable(
  "fills",
  {
    id: serial("id").primaryKey(),
    pool: addr("pool").notNull(),
    marketId: text("market_id"),
    takerOrderId: u256("taker_order_id").notNull(),
    makerOrderId: u256("maker_order_id").notNull(),
    /** YES-terms fill price (raw). */
    fillPrice: u256("fill_price").notNull(),
    quantity: u256("quantity").notNull(),
    /** fillPrice × quantity / one (raw collateral). */
    notional: u256("notional").notNull(),
    block: bigint("block", { mode: "bigint" }).notNull(),
    blockTs: bigint("block_ts", { mode: "bigint" }).notNull(),
    blockHash: text("block_hash").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    takerOwner: addr("taker_owner"),
    makerOwner: addr("maker_owner"),
    takerKind: smallint("taker_kind"),
    makerKind: smallint("maker_kind"),
    takerPartnerId: integer("taker_partner_id"),
    takerSurfaceId: integer("taker_surface_id"),
    makerPartnerId: integer("maker_partner_id"),
    takerBuilder: addr("taker_builder"),
    makerBuilder: addr("maker_builder"),
  },
  (t) => [
    uniqueIndex("fills_tx_log_uq").on(t.txHash, t.logIndex),
    index("fills_market_idx").on(t.marketId),
    index("fills_taker_partner_block_idx").on(t.takerPartnerId, t.block),
    index("fills_block_idx").on(t.block),
    index("fills_block_ts_idx").on(t.blockTs),
    index("fills_taker_owner_idx").on(t.takerOwner),
  ],
);

export const builderFeeEvents = pgTable(
  "builder_fee_events",
  {
    id: serial("id").primaryKey(),
    pool: addr("pool").notNull(),
    marketId: text("market_id"),
    orderId: u256("order_id").notNull(),
    builder: addr("builder").notNull(),
    token: addr("token").notNull(),
    amount: u256("amount").notNull(),
    block: bigint("block", { mode: "bigint" }).notNull(),
    blockHash: text("block_hash").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
  },
  (t) => [uniqueIndex("bfe_tx_log_uq").on(t.txHash, t.logIndex), index("bfe_builder_block_idx").on(t.builder, t.block)],
);

export const protocolFeeEvents = pgTable(
  "protocol_fee_events",
  {
    id: serial("id").primaryKey(),
    pool: addr("pool").notNull(),
    marketId: text("market_id"),
    orderId: u256("order_id").notNull(),
    payer: addr("payer").notNull(),
    token: addr("token").notNull(),
    amount: u256("amount").notNull(),
    isTakerSide: boolean("is_taker_side").notNull(),
    block: bigint("block", { mode: "bigint" }).notNull(),
    blockHash: text("block_hash").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
  },
  (t) => [uniqueIndex("pfe_tx_log_uq").on(t.txHash, t.logIndex), index("pfe_block_idx").on(t.block)],
);

/** BinarySettlement.Redeemed (payouts). marketKey = outcomeId >> 8 = (pool << 64 | nonce). */
export const redemptions = pgTable(
  "redemptions",
  {
    id: serial("id").primaryKey(),
    marketKey: u256("market_key").notNull(),
    pool: addr("pool"),
    nonce: bigint("nonce", { mode: "bigint" }),
    marketId: text("market_id"),
    holder: addr("holder").notNull(),
    to: addr("to").notNull(),
    outcomeIdx: smallint("outcome_idx").notNull(),
    amountBurned: u256("amount_burned").notNull(),
    collateralOut: u256("collateral_out").notNull(),
    block: bigint("block", { mode: "bigint" }).notNull(),
    blockHash: text("block_hash").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
  },
  (t) => [uniqueIndex("redemptions_tx_log_uq").on(t.txHash, t.logIndex), index("redemptions_holder_idx").on(t.holder), index("redemptions_market_idx").on(t.marketId)],
);

/** Anything we keep but do not model: unnamed module events, SetMinted, PoolRecycled, MarketFinalized… */
export const rawEvents = pgTable(
  "raw_events",
  {
    id: serial("id").primaryKey(),
    address: addr("address").notNull(),
    topic0: text("topic0").notNull(),
    /** Decoded name when one of our ABIs knows it; null for unnamed. */
    name: text("name"),
    marketId: text("market_id"),
    topics: jsonb("topics").$type<string[]>().notNull(),
    data: text("data").notNull(),
    args: jsonb("args").$type<Record<string, string>>(),
    block: bigint("block", { mode: "bigint" }).notNull(),
    blockHash: text("block_hash").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
  },
  (t) => [uniqueIndex("raw_events_tx_log_uq").on(t.txHash, t.logIndex), index("raw_events_topic_block_idx").on(t.topic0, t.block)],
);

export const partners = pgTable("partners", {
  partnerId: serial("partner_id").primaryKey(),
  name: text("name").notNull(),
  builderAddress: addr("builder_address").notNull(),
  /** Optional: where the partner embeds the widget. Shown on the public card. */
  homepage: text("homepage"),
  /**
   * Did this partner prove control of the builder address by signing for it?
   * Anyone can claim any address at registration; this is the flag that says whether
   * they actually hold the key that a builder fee would be paid to.
   */
  verified: boolean("verified").notNull().default(false),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  apiKeyHash: text("api_key_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** 1-minute candles of the underlying, from the SDK price feed sampled every 2 s. */
export const priceCandles = pgTable(
  "price_candles",
  {
    asset: text("asset").notNull(),
    minuteTs: bigint("minute_ts", { mode: "bigint" }).notNull(),
    open: doublePrecision("open").notNull(),
    high: doublePrecision("high").notNull(),
    low: doublePrecision("low").notNull(),
    close: doublePrecision("close").notNull(),
    samples: integer("samples").notNull(),
  },
  (t) => [primaryKey({ columns: [t.asset, t.minuteTs] })],
);

/** Materialised per venue × asset × cadence × UTC day (day = expiry date; completed windows only). */
export const statsVenueDaily = pgTable(
  "stats_venue_daily",
  {
    venueId: text("venue_id").notNull(),
    asset: text("asset").notNull(),
    intervalSec: integer("interval_sec").notNull(),
    day: date("day").notNull(),
    windows: integer("windows").notNull(),
    zeroFillWindows: integer("zero_fill_windows").notNull(),
    quotedButUntakenWindows: integer("quoted_but_untaken_windows").notNull(),
    fills: integer("fills").notNull(),
    notional: u256("notional").notNull(),
    uniqueTakers: integer("unique_takers").notNull(),
    computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.venueId, t.asset, t.intervalSec, t.day] })],
);

export const statsPartner = pgTable("stats_partner", {
  partnerId: integer("partner_id").primaryKey(),
  fills: integer("fills").notNull(),
  notional: u256("notional").notNull(),
  uniqueWallets: integer("unique_wallets").notNull(),
  marketsTouched: integer("markets_touched").notNull(),
  /** notional × BUILDER_FEE_BPS / 10_000, taker side only — a PROJECTION. */
  projectedBuilderFee: u256("projected_builder_fee").notNull(),
  feeBps: integer("fee_bps").notNull(),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const statsPartnerHourly = pgTable(
  "stats_partner_hourly",
  {
    partnerId: integer("partner_id").notNull(),
    hourTs: bigint("hour_ts", { mode: "bigint" }).notNull(),
    fills: integer("fills").notNull(),
    notional: u256("notional").notNull(),
    uniqueWallets: integer("unique_wallets").notNull(),
  },
  (t) => [primaryKey({ columns: [t.partnerId, t.hourTs] })],
);

export const schema = {
  cursor,
  blocks,
  markets,
  poolEpochs,
  orders,
  fills,
  builderFeeEvents,
  protocolFeeEvents,
  redemptions,
  rawEvents,
  partners,
  priceCandles,
  statsVenueDaily,
  statsPartner,
  statsPartnerHourly,
};

export const nowSql = sql`now()`;
