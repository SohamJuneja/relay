// Event ABIs for log-based discovery and attribution.
//
// Source of truth: @somnia-chain/markets-sdk 0.29.0 dist/eventsAbi.js
// (orderBookEventsAbi, binaryModuleEventsAbi, marketCreatorEventsAbi,
// binaryPoolEventsAbi, binaryMarketEventsAbi, binarySettlementEventsAbi).
//
// The SDK's comment: "these signatures are the source of truth for client-side
// log decoding via viem" and they "mirror the events the Envio indexer consumes".
//
// TWO different `MarketCreated` events exist, with different topic0:
//   - BinaryMarketsModule (19 fields): fires for EVERY market, carries
//     (operatorId, venueId, creator, nonce). Discover from THIS one.
//   - MarketCreator (13 fields): only for rolling-series markets; carries
//     `intervalSec` and `strike` but NO venueId.
//
// `OrderFilled` gained `fillPrice` in the June 2026 upgrade (6 args). The kit
// pins its topic0 (packages/core/src/contract.ts TOPIC.OrderFilled) — we pin the
// same and ASSERT it against the ABI-derived selector at startup.

import { parseAbi, toEventSelector, type AbiEvent } from "viem";

/** OrderBook base — byte-identical on SpotPool, PerpPool, BinaryPool. */
export const orderBookEventsAbi = parseAbi([
  "event OrderPlaced(uint128 indexed orderId, (uint128 orderId, bool isBid, address owner, uint64 userData, uint256 price, uint256 fullQuantity, uint256 quantityRemaining, uint64 expireTimestampNs) placedOrder)",
  "event OrderRested(uint128 indexed orderId)",
  "event OrderCancelled(uint128 indexed orderId)",
  "event OrderExpired(uint128 indexed orderId)",
  "event OrderReduced(uint128 indexed orderId, uint256 newQuantity)",
  "event OrderFilled(uint128 indexed takerOrderId, uint128 indexed makerOrderId, uint256 quantityFilled, uint256 takerRemainingQuantity, uint256 makerRemainingQuantity, uint256 fillPrice)",
  "event OrderCancelledSelfMatch(uint128 indexed orderId)",
  "event MakerOrderCancelledExceedsPosition(uint128 indexed orderId)",
  "event OrderCancelledPreFill(uint128 indexed orderId)",
]);

/** BinaryPool v2: side attribution + lifecycle. */
export const binaryPoolEventsAbi = parseAbi([
  // The ONLY authoritative side source (v2 stopped encoding side in userData).
  "event BinaryOrderPlaced(uint128 indexed orderId, uint8 kind)",
  "event PoolFinalized(uint64 indexed marketNonce, uint256 backing)",
  "event PoolRecycled(uint64 indexed marketNonce, address indexed market)",
  "event SetMinted(address indexed payer, address indexed yesTo, address indexed noTo, uint256 amount)",
  "event SetBurned(address indexed holder, uint256 amount)",
]);

/** BinaryMarketsModule: every market creation + finalize/release. */
export const binaryModuleEventsAbi = parseAbi([
  "event MarketCreated(bytes32 indexed marketId, address indexed market, address indexed pool, uint256 oracleQuestionId, uint32 operatorId, bytes32 venueId, address creator, address collateral, uint256 yesId, uint256 noId, uint64 nonce, uint8 outcomeSlotCount, uint8 marketType, uint64 tradingStart, uint64 expiry, uint8 voidPolicy, string asset, uint256 strike, string question, bytes context)",
  "event MarketFinalized(bytes32 indexed marketId, address indexed pool, uint256 marketKey)",
  "event PoolReleased(bytes32 indexed marketId, address indexed pool, address indexed creator)",
]);

/** MarketCreator rolling-series creation (13 fields, no venueId). */
export const marketCreatorEventsAbi = parseAbi([
  "event MarketCreated(bytes32 indexed marketId, address indexed market, address indexed pool, uint256 yesId, uint256 noId, address collateral, string asset, uint256 strike, uint64 tradingStart, uint64 expiry, uint256 oracleQuestionId, string question, uint64 intervalSec)",
]);

/** BinaryMarket lifecycle. */
export const binaryMarketEventsAbi = parseAbi([
  "event StatusChanged(uint8 indexed oldStatus, uint8 indexed newStatus)",
  "event Resolved(uint32 payoutDenominator, uint256[] payoutNumerators)",
  "event Voided()",
]);

/** BinarySettlement singleton. */
export const binarySettlementEventsAbi = parseAbi([
  "event MarketFinalized(uint256 indexed marketKey, address indexed pool, uint64 nonce, address collateralToken, uint256 netBacking, bool voided, uint8 winningOutcome)",
  "event SettlementFeeCharged(uint256 indexed marketKey, address indexed feeRecipient, uint256 grossBacking, uint256 fee)",
  "event Redeemed(uint256 indexed marketKey, address indexed holder, address indexed to, uint8 outcomeIdx, uint256 amountBurned, uint256 collateralOut)",
  "event PayoutOwed(address indexed owner, address indexed token, uint256 amount)",
  "event OwedClaimed(address indexed owner, address indexed token, uint256 amount)",
]);

/**
 * Events the SDK does NOT ship an ABI for, identified on Shannon on 2026-09-09 by
 * matching live topic0 hashes against candidate signatures (scripts/probe.ts §7
 * lists the raw topics; the match was done with keccak256 over guesses and
 * confirmed against the logs' indexed/data layout). Treat as "observed", not
 * "documented". The builder-fee event has not been observed (no builder-tagged
 * order on testnet yet) — see PROTOCOL_NOTES.md open questions.
 */
export const observedEventsAbi = parseAbi([
  // POOL, on the fill path (one per fill side, right after BinaryOrderPlaced /
  // before OrderFilled). amount is 0 on testnet because maker/taker fees are 0.
  // Indexer mirror: ProtocolFeeRecord(orderId, recipient, payer, token, amount, isTakerSide).
  // topic0 0xca4794943942203b51ce7e595d6bb619b6edb8ed8618ec8c4a2b0ad6813ada02
  "event ProtocolFeeCharged(uint128 indexed orderId, address indexed payer, address indexed token, uint256 amount, bool isTakerSide)",
  // MODULE, at resolution (before PoolFinalized / MarketFinalized).
  // topic0 0x4ca9766196d8679d9b2e01457f67073d844b29646ce302169de44cd72e593d11
  "event MarketResolved(bytes32 indexed marketId, uint256 indexed oracleQuestionId, uint32 payoutDenominator, uint256[] payoutNumerators, bool voided)",
  // SETTLEMENT singleton. NOTE: the SDK 0.29.0 `binarySettlementEventsAbi` declares
  // this with a trailing `uint8 winningOutcome`; the live deployment emits the
  // payout VECTOR instead (different topic0). Decode with THIS one.
  // topic0 0xb1884334e955f8d8727678d4fa52dd9fc7140ff5e4ad38d358453bd400ada178
  "event MarketFinalized(uint256 indexed marketKey, address indexed pool, uint64 nonce, address collateralToken, uint256 netBacking, bool voided, uint256[] payoutNumerators)",
  // POOL, right after BinaryOrderPlaced, ONLY when the order carried builder ≠ 0 —
  // emitted even at fee 0 (amount 0), so it is an attribution record, not just a
  // fee record. No payer field: join orderId → OrderPlaced.owner. Identified live
  // on Shannon 2026-09-08 (tx 0x0daeba75…) from a Relay-tagged order.
  // topic0 0xb603f98363ba2c49dc586ce0aa14affc3f62a5df0b81fa84c6bfb96ec4eccc93
  "event BuilderFeeCharged(uint128 indexed orderId, address indexed builder, address indexed token, uint256 amount)",
  // MODULE, right after MarketCreated on reference-mode (strike 0) markets: binds the
  // market to the OracleHub question whose answer is the OPENING price. Matches the
  // indexer's MarketReferenceLink.referenceQuestionId (verified live, Phase 1 step 6).
  // topic0 0xa304dae09530a82263c62fe0cfe08a427eb09e5dbf7506fbd3c4b19fdc76490e
  "event MarketReference(bytes32 indexed marketId, uint256 indexed referenceQuestionId)",
]);

/** Token transfer events that ride along in every fill receipt. */
export const tokenEventsAbi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  // ERC-6909 outcome-token singleton
  "event Transfer(address caller, address indexed from, address indexed to, uint256 indexed id, uint256 amount)",
  "event OperatorSet(address indexed owner, address indexed spender, bool approved)",
]);

export const builderFeeChargedEvent = observedEventsAbi[3];
export const marketReferenceEvent = observedEventsAbi[4];

export const moduleMarketCreatedEvent = binaryModuleEventsAbi[0];
export const creatorMarketCreatedEvent = marketCreatorEventsAbi[0];
export const orderFilledEvent = orderBookEventsAbi[5];
export const orderPlacedEvent = orderBookEventsAbi[0];
export const binaryOrderPlacedEvent = binaryPoolEventsAbi[0];

/**
 * Pinned topic0 hashes. `OrderFilled` comes from the kit
 * (dreamdex-bot-kit/packages/core/src/contract.ts). The rest are derived from
 * the SDK-pinned ABIs above at module load, so they can never drift from the
 * ABI we decode with.
 */
export const PINNED_TOPICS = {
  OrderFilled: "0xc87f4223e9e7c4e4f39f9b34fc9d64d78cdb95d9035b3748cbde59521261a399",
} as const;

export const TOPICS = {
  OrderFilled: toEventSelector(orderFilledEvent),
  BuilderFeeCharged: toEventSelector(observedEventsAbi[3]),
  OrderPlaced: toEventSelector(orderPlacedEvent),
  BinaryOrderPlaced: toEventSelector(binaryOrderPlacedEvent),
  ModuleMarketCreated: toEventSelector(moduleMarketCreatedEvent),
  CreatorMarketCreated: toEventSelector(creatorMarketCreatedEvent),
} as const;

/** Throws if the ABI-derived OrderFilled selector disagrees with the kit's pin. */
export function assertPinnedTopics(): void {
  if (TOPICS.OrderFilled.toLowerCase() !== PINNED_TOPICS.OrderFilled.toLowerCase()) {
    throw new Error(
      `OrderFilled topic mismatch: ABI-derived ${TOPICS.OrderFilled} vs kit-pinned ${PINNED_TOPICS.OrderFilled}. ` +
        "The event signature changed — do not scan fills until this is reconciled.",
    );
  }
}

/** Every event we can name, for classifying arbitrary pool/module logs. */
export const allKnownEvents: readonly AbiEvent[] = [
  ...orderBookEventsAbi,
  ...binaryPoolEventsAbi,
  ...binaryModuleEventsAbi,
  ...marketCreatorEventsAbi,
  ...binaryMarketEventsAbi,
  ...binarySettlementEventsAbi,
  ...observedEventsAbi,
  ...tokenEventsAbi,
];

/** Topics we have SEEN on Shannon but not yet matched to a signature (probe §7). */
export const UNRESOLVED_OBSERVED_TOPICS: Record<string, string> = {
  "0x776d26878b6eb1cb76f8ff17b78454323d7286d04fe482dd833e8c9e2241fe7d":
    "MODULE, once per MarketCreated: indexed (marketId, operatorId, venueId); data = feeRecipient + 5 words (all 0 on testnet). Almost certainly the per-market fee config (indexer MarketVenue: makerFeeBps, takerFeeBps, maxBuilderFeeBps, routingFeeBps, settlementFeeBps); exact types unknown.",
  "0xe0f81c53dd90cfc3dfa3fdf7977de4f78e3146e6832441463ef18995a578d734":
    "MODULE, on redeem: indexed (marketId, holder, operatorId); data = (venueId, amount, 0). A venue-attributed redeem record.",
};

const topicNameIndex: Map<string, string> = new Map(
  allKnownEvents.map((e) => [toEventSelector(e).toLowerCase(), e.name] as const),
);

/** Event name for a topic0, or null if none of our ABIs declare it. */
export function eventNameForTopic(topic0: string): string | null {
  return topicNameIndex.get(topic0.toLowerCase()) ?? null;
}
