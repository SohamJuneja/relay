// Raw eth_getLogs rows → decoded events, using ONLY the ABIs pinned in @relay/core.
// Unknown topics are kept (name = null) so nothing is silently dropped.

import { decodeEventLog, toEventSelector, type AbiEvent, type Address, type Hex } from "viem";
import { allKnownEvents, binaryModuleEventsAbi, binaryPoolEventsAbi, binarySettlementEventsAbi, observedEventsAbi, orderBookEventsAbi } from "@relay/core";

export interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
}

export interface DecodedLog extends RawLog {
  topic0: Hex;
  name: string | null;
  args: Record<string, unknown> | null;
}

/** topic0 → ABI item. Names collide across contracts (two MarketCreated, two MarketFinalized,
 *  two Transfer) but topic0s do not, so this map is exact. */
const BY_TOPIC = new Map<Hex, AbiEvent>();
for (const e of allKnownEvents) BY_TOPIC.set(toEventSelector(e).toLowerCase() as Hex, e);

export function abiForTopic(topic0: Hex): AbiEvent | undefined {
  return BY_TOPIC.get(topic0.toLowerCase() as Hex);
}

export function decodeLog(l: RawLog): DecodedLog {
  const topic0 = (l.topics[0] ?? "0x") as Hex;
  const item = abiForTopic(topic0);
  if (!item) return { ...l, topic0, name: null, args: null };
  try {
    const d = decodeEventLog({ abi: [item], data: l.data, topics: l.topics as [Hex, ...Hex[]], strict: false });
    return { ...l, topic0, name: d.eventName, args: (d.args ?? {}) as Record<string, unknown> };
  } catch {
    return { ...l, topic0, name: item.name, args: null };
  }
}

/** Normalise a JSON-RPC log object (hex quantities) into RawLog. */
export function normaliseRpcLog(x: {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: string;
  logIndex: string;
}): RawLog {
  return {
    address: x.address.toLowerCase() as Address,
    topics: x.topics as Hex[],
    data: x.data as Hex,
    blockNumber: BigInt(x.blockNumber),
    blockHash: x.blockHash as Hex,
    transactionHash: x.transactionHash as Hex,
    transactionIndex: Number(x.transactionIndex),
    logIndex: Number(x.logIndex),
  };
}

const sel = (abi: readonly AbiEvent[], name: string): Hex => {
  const e = abi.find((x) => x.name === name);
  if (!e) throw new Error(`no event ${name}`);
  return toEventSelector(e);
};

/** Pool events the indexer ingests (everything except the token Transfers). */
export const POOL_TOPICS: Hex[] = [
  sel(orderBookEventsAbi, "OrderPlaced"),
  sel(orderBookEventsAbi, "OrderRested"),
  sel(orderBookEventsAbi, "OrderCancelled"),
  sel(orderBookEventsAbi, "OrderExpired"),
  sel(orderBookEventsAbi, "OrderReduced"),
  sel(orderBookEventsAbi, "OrderFilled"),
  sel(orderBookEventsAbi, "OrderCancelledSelfMatch"),
  sel(orderBookEventsAbi, "OrderCancelledPreFill"),
  sel(orderBookEventsAbi, "MakerOrderCancelledExceedsPosition"),
  sel(binaryPoolEventsAbi, "BinaryOrderPlaced"),
  sel(binaryPoolEventsAbi, "PoolFinalized"),
  sel(binaryPoolEventsAbi, "PoolRecycled"),
  sel(binaryPoolEventsAbi, "SetMinted"),
  sel(binaryPoolEventsAbi, "SetBurned"),
  sel(observedEventsAbi, "ProtocolFeeCharged"),
  sel(observedEventsAbi, "BuilderFeeCharged"),
];

export const TOPIC = {
  ModuleMarketCreated: sel(binaryModuleEventsAbi, "MarketCreated"),
  ModuleMarketFinalized: sel(binaryModuleEventsAbi, "MarketFinalized"),
  PoolReleased: sel(binaryModuleEventsAbi, "PoolReleased"),
  MarketReference: sel(observedEventsAbi, "MarketReference"),
  MarketResolved: sel(observedEventsAbi, "MarketResolved"),
  SettlementMarketFinalized: sel(observedEventsAbi, "MarketFinalized"),
  SettlementRedeemed: sel(binarySettlementEventsAbi, "Redeemed"),
  SettlementFeeCharged: sel(binarySettlementEventsAbi, "SettlementFeeCharged"),
  OrderPlaced: sel(orderBookEventsAbi, "OrderPlaced"),
  OrderRested: sel(orderBookEventsAbi, "OrderRested"),
  OrderCancelled: sel(orderBookEventsAbi, "OrderCancelled"),
  OrderExpired: sel(orderBookEventsAbi, "OrderExpired"),
  OrderReduced: sel(orderBookEventsAbi, "OrderReduced"),
  OrderFilled: sel(orderBookEventsAbi, "OrderFilled"),
  OrderCancelledSelfMatch: sel(orderBookEventsAbi, "OrderCancelledSelfMatch"),
  OrderCancelledPreFill: sel(orderBookEventsAbi, "OrderCancelledPreFill"),
  MakerOrderCancelledExceedsPosition: sel(orderBookEventsAbi, "MakerOrderCancelledExceedsPosition"),
  BinaryOrderPlaced: sel(binaryPoolEventsAbi, "BinaryOrderPlaced"),
  PoolRecycled: sel(binaryPoolEventsAbi, "PoolRecycled"),
  PoolFinalized: sel(binaryPoolEventsAbi, "PoolFinalized"),
  SetMinted: sel(binaryPoolEventsAbi, "SetMinted"),
  SetBurned: sel(binaryPoolEventsAbi, "SetBurned"),
  ProtocolFeeCharged: sel(observedEventsAbi, "ProtocolFeeCharged"),
  BuilderFeeCharged: sel(observedEventsAbi, "BuilderFeeCharged"),
  /** Unnamed module events we store raw. */
  RawFeeConfig: "0x776d26878b6eb1cb76f8ff17b78454323d7286d04fe482dd833e8c9e2241fe7d" as Hex,
  RawVenueRedeem: "0xe0f81c53dd90cfc3dfa3fdf7977de4f78e3146e6832441463ef18995a578d734" as Hex,
} as const;

export const lc = (s: string) => s.toLowerCase();
