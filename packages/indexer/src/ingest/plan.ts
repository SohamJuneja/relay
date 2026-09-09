// Pure planner: decoded logs of one chunk → row plans. No I/O, so the attribution
// join and the epoch mapping are unit-testable against the Phase 1 receipts.
//
// Ordering facts this relies on (verified in Phase 1, PROTOCOL_NOTES §11):
//   - within a placing tx: BinaryOrderPlaced(kind) → [BuilderFeeCharged] → …fills… → OrderPlaced LAST
//   - OrderRested / OrderCancelled / OrderExpired reference an orderId by (pool, orderId)
//   - PoolRecycled + MarketCreated land in the same tx: the new epoch starts at that block

import type { Address, Hex } from "viem";
import { decodeUserData, decodeOutcomeId, snapIntervalSec } from "@relay/core";
import { TOPIC, type DecodedLog } from "./decode.js";
import type { Epoch, EpochIndex } from "./epochs.js";

export const orderKey = (pool: string, orderId: bigint) => `${pool.toLowerCase()}:${orderId.toString()}`;

export interface MarketRow {
  marketId: Hex;
  marketAddress: Address;
  pool: Address;
  venueId: Hex;
  operatorId: number;
  creator: Address;
  collateral: Address;
  yesId: bigint;
  noId: bigint;
  nonce: bigint;
  asset: string;
  intervalSec: number;
  windowSec: number;
  tradingStart: bigint;
  expiry: bigint;
  strikeRaw: bigint;
  question: string;
  voidPolicy: number;
  oracleQuestionId: bigint;
  createdBlock: bigint;
  createdBlockHash: Hex;
  createdTx: Hex;
}

export interface OrderRow {
  key: string;
  pool: Address;
  orderId: bigint;
  marketId: Hex | null;
  owner: Address;
  isBid: boolean;
  kind: number | null;
  price: bigint;
  quantity: bigint;
  userData: bigint;
  tagVersion: number;
  partnerId: number | null;
  surfaceId: number | null;
  builder: Address | null;
  expireNs: bigint;
  placedBlock: bigint;
  blockHash: Hex;
  txHash: Hex;
  logIndex: number;
  restedQty: bigint | null;
  filledQty: bigint;
  cancelled: boolean;
  expired: boolean;
}

export interface OrderUpdate {
  pool: Address;
  orderId: bigint;
  kind?: number;
  builder?: Address;
  restedQty?: bigint;
  cancelled?: true;
  expired?: true;
  filledQtyAdd?: bigint;
}

export interface FillDraft {
  pool: Address;
  marketId: Hex | null;
  takerOrderId: bigint;
  makerOrderId: bigint;
  fillPrice: bigint;
  quantity: bigint;
  notional: bigint;
  block: bigint;
  blockHash: Hex;
  txHash: Hex;
  logIndex: number;
  takerKey: string;
  makerKey: string;
}

export interface OrderLookup {
  owner: Address;
  kind: number | null;
  partnerId: number | null;
  surfaceId: number | null;
  builder: Address | null;
}

export interface FillRow extends FillDraft {
  takerOwner: Address | null;
  makerOwner: Address | null;
  takerKind: number | null;
  makerKind: number | null;
  takerPartnerId: number | null;
  takerSurfaceId: number | null;
  makerPartnerId: number | null;
  takerBuilder: Address | null;
  makerBuilder: Address | null;
}

/**
 * The attribution join. The TAKER is the attributed side (Relay's user); maker
 * attribution is recorded separately and never mixed in. `lookup` resolves an
 * order key from this chunk's orders first, then the database.
 */
export function attributeFills(drafts: FillDraft[], lookup: (key: string) => OrderLookup | null): FillRow[] {
  return drafts.map((f) => {
    const t = lookup(f.takerKey);
    const m = lookup(f.makerKey);
    return {
      ...f,
      takerOwner: t?.owner ?? null,
      makerOwner: m?.owner ?? null,
      takerKind: t?.kind ?? null,
      makerKind: m?.kind ?? null,
      takerPartnerId: t?.partnerId ?? null,
      takerSurfaceId: t?.surfaceId ?? null,
      makerPartnerId: m?.partnerId ?? null,
      takerBuilder: t?.builder ?? null,
      makerBuilder: m?.builder ?? null,
    };
  });
}

export const lookupFromOrders = (rows: Iterable<OrderRow>): ((key: string) => OrderLookup | null) => {
  const m = new Map<string, OrderRow>();
  for (const o of rows) m.set(o.key, o);
  return (k) => {
    const o = m.get(k);
    return o ? { owner: o.owner, kind: o.kind, partnerId: o.partnerId, surfaceId: o.surfaceId, builder: o.builder } : null;
  };
};

export interface EventRow {
  pool?: Address;
  marketId: Hex | null;
  block: bigint;
  blockHash: Hex;
  txHash: Hex;
  logIndex: number;
}

export interface ChunkPlan {
  markets: MarketRow[];
  references: { marketId: Hex; referenceQuestionId: bigint }[];
  resolved: { marketId: Hex; oracleQuestionId: bigint; payoutDenominator: bigint; payoutNumerators: bigint[]; voided: boolean; block: bigint; winner: 0 | 1 | null }[];
  finalized: { marketId: Hex | null; pool: Address; nonce: bigint; voided: boolean; netBacking: bigint; payoutNumerators: bigint[]; block: bigint }[];
  epochsOpened: Epoch[];
  epochsClosed: Epoch[];
  orders: OrderRow[];
  orderUpdates: OrderUpdate[];
  fills: FillDraft[];
  builderFees: (EventRow & { orderId: bigint; builder: Address; token: Address; amount: bigint })[];
  protocolFees: (EventRow & { orderId: bigint; payer: Address; token: Address; amount: bigint; isTakerSide: boolean })[];
  redemptions: (EventRow & { marketKey: bigint; nonce: bigint | null; holder: Address; to: Address; outcomeIdx: number; amountBurned: bigint; collateralOut: bigint })[];
  raw: (EventRow & { address: Address; topic0: Hex; name: string | null; topics: Hex[]; data: Hex; args: Record<string, string> | null })[];
  blockHashes: Map<bigint, Hex>;
  unknownPoolLogs: number;
}

export interface PlanContext {
  binaryModule: Address;
  binarySettlement: Address;
  /** 10^collateralDecimals, for notional = price × qty / one. */
  one: bigint;
  epochs: EpochIndex;
}

const asStr = (v: unknown): string => (typeof v === "bigint" ? v.toString() : Array.isArray(v) ? JSON.stringify(v.map(String)) : String(v));
const argsToStrings = (a: Record<string, unknown> | null): Record<string, string> | null =>
  a ? Object.fromEntries(Object.entries(a).map(([k, v]) => [k, asStr(v)])) : null;

export function planChunk(logs: DecodedLog[], ctx: PlanContext): ChunkPlan {
  const plan: ChunkPlan = {
    markets: [],
    references: [],
    resolved: [],
    finalized: [],
    epochsOpened: [],
    epochsClosed: [],
    orders: [],
    orderUpdates: [],
    fills: [],
    builderFees: [],
    protocolFees: [],
    redemptions: [],
    raw: [],
    blockHashes: new Map(),
    unknownPoolLogs: 0,
  };
  const module = ctx.binaryModule.toLowerCase();
  const settlement = ctx.binarySettlement.toLowerCase();
  const ordersInChunk = new Map<string, OrderRow>();
  // taker fills seen before the taker's own OrderPlaced (same tx)
  const pendingTakerFills = new Map<string, bigint>();
  // per-tx pending side/builder, consumed by the trailing OrderPlaced
  let curTx: Hex | null = null;
  let pendingKind = new Map<string, number>();
  let pendingBuilder = new Map<string, Address>();
  const flushPending = () => {
    for (const [k, kind] of pendingKind) {
      const row = ordersInChunk.get(k);
      if (row) row.kind = kind;
      else {
        const [pool, id] = k.split(":");
        plan.orderUpdates.push({ pool: pool as Address, orderId: BigInt(id!), kind });
      }
    }
    for (const [k, builder] of pendingBuilder) {
      const row = ordersInChunk.get(k);
      if (row) row.builder = builder;
      else {
        const [pool, id] = k.split(":");
        plan.orderUpdates.push({ pool: pool as Address, orderId: BigInt(id!), builder });
      }
    }
    pendingKind = new Map();
    pendingBuilder = new Map();
  };
  const evRow = (l: DecodedLog, marketId: Hex | null, pool?: Address): EventRow => ({
    ...(pool ? { pool } : {}),
    marketId,
    block: l.blockNumber,
    blockHash: l.blockHash,
    txHash: l.transactionHash,
    logIndex: l.logIndex,
  });
  const rawRow = (l: DecodedLog, marketId: Hex | null) =>
    plan.raw.push({ ...evRow(l, marketId), address: l.address, topic0: l.topic0, name: l.name, topics: l.topics, data: l.data, args: argsToStrings(l.args) });
  const marketOf = (pool: string, block: bigint): Hex | null => ctx.epochs.resolve(pool, block)?.marketId ?? null;
  const updateOrder = (pool: Address, orderId: bigint, u: Omit<OrderUpdate, "pool" | "orderId">) => {
    const row = ordersInChunk.get(orderKey(pool, orderId));
    if (row) {
      if (u.restedQty !== undefined) row.restedQty = u.restedQty;
      if (u.cancelled) row.cancelled = true;
      if (u.expired) row.expired = true;
      if (u.filledQtyAdd) row.filledQty += u.filledQtyAdd;
      if (u.kind !== undefined) row.kind = u.kind;
      if (u.builder) row.builder = u.builder;
    } else plan.orderUpdates.push({ pool, orderId, ...u });
  };

  for (const l of logs) {
    plan.blockHashes.set(l.blockNumber, l.blockHash);
    if (l.transactionHash !== curTx) {
      flushPending();
      curTx = l.transactionHash;
    }
    const addr = l.address.toLowerCase();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- decoded ABI args are dynamically typed here
    const a = (l.args ?? {}) as Record<string, any>;

    // ───────────── module ─────────────
    if (addr === module) {
      if (l.topic0 === TOPIC.ModuleMarketCreated && l.args) {
        const tradingStart = BigInt(a["tradingStart"]);
        const expiry = BigInt(a["expiry"]);
        const windowSec = Number(expiry - tradingStart);
        const row: MarketRow = {
          marketId: a["marketId"] as Hex,
          marketAddress: (a["market"] as string).toLowerCase() as Address,
          pool: (a["pool"] as string).toLowerCase() as Address,
          venueId: (a["venueId"] as string).toLowerCase() as Hex,
          operatorId: Number(a["operatorId"]),
          creator: (a["creator"] as string).toLowerCase() as Address,
          collateral: (a["collateral"] as string).toLowerCase() as Address,
          yesId: BigInt(a["yesId"]),
          noId: BigInt(a["noId"]),
          nonce: BigInt(a["nonce"]),
          asset: String(a["asset"]),
          intervalSec: snapIntervalSec(windowSec),
          windowSec,
          tradingStart,
          expiry,
          strikeRaw: BigInt(a["strike"]),
          question: String(a["question"]),
          voidPolicy: Number(a["voidPolicy"]),
          oracleQuestionId: BigInt(a["oracleQuestionId"]),
          createdBlock: l.blockNumber,
          createdBlockHash: l.blockHash,
          createdTx: l.transactionHash,
        };
        plan.markets.push(row);
        const { opened, closed } = ctx.epochs.open({ pool: row.pool, marketId: row.marketId, nonce: row.nonce, fromBlock: l.blockNumber });
        if (opened) plan.epochsOpened.push(opened);
        if (closed) plan.epochsClosed.push(closed);
        continue;
      }
      if (l.topic0 === TOPIC.MarketReference && l.args) {
        plan.references.push({ marketId: a["marketId"] as Hex, referenceQuestionId: BigInt(a["referenceQuestionId"]) });
        continue;
      }
      if (l.topic0 === TOPIC.MarketResolved && l.args) {
        const nums = (a["payoutNumerators"] as readonly bigint[]).map(BigInt);
        const voided = Boolean(a["voided"]);
        let winner: 0 | 1 | null = null;
        if (!voided && nums.length >= 2) winner = (nums[1]! > nums[0]! ? 1 : 0) as 0 | 1;
        plan.resolved.push({ marketId: a["marketId"] as Hex, oracleQuestionId: BigInt(a["oracleQuestionId"]), payoutDenominator: BigInt(a["payoutDenominator"]), payoutNumerators: nums, voided, block: l.blockNumber, winner });
        continue;
      }
      // MarketFinalized(module), PoolReleased, fee-config (0x776d…), venue redeem (0xe0f8…) → raw
      const mid = (l.topics[1] && l.topic0 !== TOPIC.PoolReleased ? (l.topics[1] as Hex) : null) as Hex | null;
      rawRow(l, l.topic0 === TOPIC.RawFeeConfig || l.topic0 === TOPIC.RawVenueRedeem || l.topic0 === TOPIC.ModuleMarketFinalized || l.topic0 === TOPIC.PoolReleased ? mid : null);
      continue;
    }

    // ───────────── settlement ─────────────
    if (addr === settlement) {
      if (l.topic0 === TOPIC.SettlementMarketFinalized && l.args) {
        const pool = (a["pool"] as string).toLowerCase() as Address;
        const nonce = BigInt(a["nonce"]);
        const ep = ctx.epochs.byPoolNonce(pool, nonce);
        plan.finalized.push({ marketId: ep?.marketId ?? null, pool, nonce, voided: Boolean(a["voided"]), netBacking: BigInt(a["netBacking"]), payoutNumerators: (a["payoutNumerators"] as readonly bigint[]).map(BigInt), block: l.blockNumber });
        continue;
      }
      if (l.topic0 === TOPIC.SettlementRedeemed && l.args) {
        const marketKey = BigInt(a["marketKey"]);
        const { pool, nonce } = decodeOutcomeId(marketKey << 8n);
        const ep = ctx.epochs.byPoolNonce(pool, nonce);
        plan.redemptions.push({
          ...evRow(l, ep?.marketId ?? null, pool),
          marketKey,
          nonce,
          holder: (a["holder"] as string).toLowerCase() as Address,
          to: (a["to"] as string).toLowerCase() as Address,
          outcomeIdx: Number(a["outcomeIdx"]),
          amountBurned: BigInt(a["amountBurned"]),
          collateralOut: BigInt(a["collateralOut"]),
        });
        continue;
      }
      rawRow(l, null);
      continue;
    }

    // ───────────── pools ─────────────
    const pool = l.address.toLowerCase() as Address;
    const marketId = marketOf(pool, l.blockNumber);
    switch (l.topic0) {
      case TOPIC.BinaryOrderPlaced: {
        if (!l.args) break;
        pendingKind.set(orderKey(pool, BigInt(a["orderId"])), Number(a["kind"]));
        break;
      }
      case TOPIC.BuilderFeeCharged: {
        if (!l.args) break;
        const orderId = BigInt(a["orderId"]);
        const builder = (a["builder"] as string).toLowerCase() as Address;
        pendingBuilder.set(orderKey(pool, orderId), builder);
        plan.builderFees.push({ ...evRow(l, marketId, pool), orderId, builder, token: (a["token"] as string).toLowerCase() as Address, amount: BigInt(a["amount"]) });
        break;
      }
      case TOPIC.ProtocolFeeCharged: {
        if (!l.args) break;
        plan.protocolFees.push({ ...evRow(l, marketId, pool), orderId: BigInt(a["orderId"]), payer: (a["payer"] as string).toLowerCase() as Address, token: (a["token"] as string).toLowerCase() as Address, amount: BigInt(a["amount"]), isTakerSide: Boolean(a["isTakerSide"]) });
        break;
      }
      case TOPIC.OrderFilled: {
        if (!l.args) break;
        const takerOrderId = BigInt(a["takerOrderId"]);
        const makerOrderId = BigInt(a["makerOrderId"]);
        const quantity = BigInt(a["quantityFilled"]);
        const fillPrice = BigInt(a["fillPrice"]);
        plan.fills.push({
          pool,
          marketId,
          takerOrderId,
          makerOrderId,
          fillPrice,
          quantity,
          notional: (fillPrice * quantity) / ctx.one,
          block: l.blockNumber,
          blockHash: l.blockHash,
          txHash: l.transactionHash,
          logIndex: l.logIndex,
          takerKey: orderKey(pool, takerOrderId),
          makerKey: orderKey(pool, makerOrderId),
        });
        updateOrder(pool, makerOrderId, { filledQtyAdd: quantity });
        // taker's OrderPlaced arrives later in the tx → filledQty applied when it lands (see OrderPlaced)
        pendingTakerFills.set(orderKey(pool, takerOrderId), (pendingTakerFills.get(orderKey(pool, takerOrderId)) ?? 0n) + quantity);
        break;
      }
      case TOPIC.OrderPlaced: {
        if (!l.args) break;
        const po = a["placedOrder"] as { orderId: bigint; isBid: boolean; owner: string; userData: bigint; price: bigint; fullQuantity: bigint; quantityRemaining: bigint; expireTimestampNs: bigint };
        const orderId = BigInt(po.orderId);
        const key = orderKey(pool, orderId);
        const tag = decodeUserData(BigInt(po.userData));
        const row: OrderRow = {
          key,
          pool,
          orderId,
          marketId,
          owner: po.owner.toLowerCase() as Address,
          isBid: Boolean(po.isBid),
          kind: pendingKind.get(key) ?? null,
          price: BigInt(po.price),
          quantity: BigInt(po.fullQuantity),
          userData: BigInt(po.userData),
          tagVersion: tag.version,
          partnerId: tag.tagged ? tag.partnerId : null,
          surfaceId: tag.tagged ? tag.surfaceId : null,
          builder: pendingBuilder.get(key) ?? null,
          expireNs: BigInt(po.expireTimestampNs),
          placedBlock: l.blockNumber,
          blockHash: l.blockHash,
          txHash: l.transactionHash,
          logIndex: l.logIndex,
          restedQty: null,
          filledQty: pendingTakerFills.get(key) ?? (BigInt(po.fullQuantity) - BigInt(po.quantityRemaining)),
          cancelled: false,
          expired: false,
        };
        pendingKind.delete(key);
        pendingBuilder.delete(key);
        pendingTakerFills.delete(key);
        ordersInChunk.set(key, row);
        plan.orders.push(row);
        break;
      }
      case TOPIC.OrderRested: {
        if (!l.args) break;
        const orderId = BigInt(a["orderId"]);
        const row = ordersInChunk.get(orderKey(pool, orderId));
        updateOrder(pool, orderId, { restedQty: row ? row.quantity - row.filledQty : 0n });
        break;
      }
      case TOPIC.OrderCancelled:
      case TOPIC.OrderCancelledSelfMatch:
      case TOPIC.OrderCancelledPreFill:
      case TOPIC.MakerOrderCancelledExceedsPosition: {
        if (!l.args) break;
        updateOrder(pool, BigInt(a["orderId"]), { cancelled: true });
        break;
      }
      case TOPIC.OrderExpired: {
        if (!l.args) break;
        updateOrder(pool, BigInt(a["orderId"]), { expired: true });
        break;
      }
      case TOPIC.OrderReduced: {
        if (!l.args) break;
        updateOrder(pool, BigInt(a["orderId"]), { restedQty: BigInt(a["newQuantity"]) });
        break;
      }
      case TOPIC.PoolRecycled:
      case TOPIC.PoolFinalized:
      case TOPIC.SetMinted:
      case TOPIC.SetBurned: {
        rawRow(l, marketId);
        break;
      }
      default: {
        plan.unknownPoolLogs++;
        rawRow(l, marketId);
      }
    }
  }
  flushPending();
  // leftover taker fills whose OrderPlaced is outside this chunk (cannot happen — same tx — but be safe)
  for (const [k, q] of pendingTakerFills) {
    const [pool, id] = k.split(":");
    plan.orderUpdates.push({ pool: pool as Address, orderId: BigInt(id!), filledQtyAdd: q });
  }
  return plan;
}
