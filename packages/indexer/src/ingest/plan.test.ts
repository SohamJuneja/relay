// Attribution join against the REAL logs of the four Phase 1 transactions
// (fixtures/phase1-receipts.json), plus the module logs that created the two
// markets they traded on (so pool→market epochs resolve).

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { ADDRESSES, SURFACE, decodeUserData, encodeUserData } from "@relay/core";
import { decodeLog, type RawLog } from "./decode.js";
import { EpochIndex } from "./epochs.js";
import { attributeFills, lookupFromOrders, planChunk } from "./plan.js";

const FIX = JSON.parse(readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../fixtures/phase1-receipts.json"), "utf8")) as Record<string, unknown>;

interface FixLog {
  address: string;
  topics: string[];
  data: string;
  logIndex: number;
  blockNumber: string;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
}
const toRaw = (l: FixLog): RawLog => ({
  address: l.address.toLowerCase() as Address,
  topics: l.topics as Hex[],
  data: l.data as Hex,
  blockNumber: BigInt(l.blockNumber),
  blockHash: l.blockHash as Hex,
  transactionHash: l.transactionHash as Hex,
  transactionIndex: Number(l.transactionIndex),
  logIndex: Number(l.logIndex),
});
const receipt = (k: string) => FIX[k] as { logs: FixLog[]; hash: string };
const A = ADDRESSES.testnet;
const ctx = () => ({ binaryModule: A.binaryModule, binarySettlement: A.binarySettlement, one: 10n ** 6n, epochs: new EpochIndex() });
const PARTNER = "0xb5ecf004491aa8589a82af91633d18867fcff038";
const ME = "0xbe9ad0286cbdfdcbcbf776262c195d0338999da9";
const M1 = "0x00000000000000000000000000000000000000000000000000000000000177a2";
const M2 = "0x00000000000000000000000000000000000000000000000000000000000177b0";

function allLogs(): RawLog[] {
  const moduleLogs = (FIX["module_logs_for_markets"] as FixLog[]).map(toRaw);
  const txLogs = ["run1_A_up_builder0", "run1_B_up_partner", "run2_A_up_builder0", "run2_B_down_partner", "run2_redeem"].flatMap((k) => receipt(k).logs.map(toRaw));
  return [...moduleLogs, ...txLogs].sort((a, b) => (a.blockNumber !== b.blockNumber ? (a.blockNumber < b.blockNumber ? -1 : 1) : a.logIndex - b.logIndex));
}

describe("planChunk on the Phase 1 receipts", () => {
  const c = ctx();
  const plan = planChunk(allLogs().map(decodeLog), c);

  it("creates both markets and their epochs from the module logs", () => {
    expect(plan.markets.map((m) => m.marketId)).toEqual([M1, M2]);
    expect(plan.references.map((r) => r.referenceQuestionId)).toEqual([52355n, 52351n]);
    expect(c.epochs.byMarketId(M1)?.pool).toBe("0x4143f9c602547a3159bbae017395025f98752518");
    expect(c.epochs.byMarketId(M2)?.pool).toBe("0x4143cd6dcbac98d05a7e0406947d46eb14651ec9");
    // the unnamed fee-config event is kept raw
    expect(plan.raw.some((r) => r.topic0.startsWith("0x776d2687") && r.name === null)).toBe(true);
  });

  it("decodes our four orders with the Relay tag (partner 1, surface WEB)", () => {
    const ours = plan.orders.filter((o) => o.owner === ME);
    expect(ours).toHaveLength(4);
    const expected = encodeUserData({ partnerId: 1, surfaceId: SURFACE.WEB });
    for (const o of ours) {
      expect(o.userData).toBe(expected);
      expect(o.tagVersion).toBe(1);
      expect(o.partnerId).toBe(1);
      expect(o.surfaceId).toBe(SURFACE.WEB);
      expect(decodeUserData(o.userData).tagged).toBe(true);
    }
    // kinds: UP, UP, UP, DOWN(BUY_NO = 2)
    expect(ours.map((o) => o.kind)).toEqual([0, 0, 0, 2]);
    expect(ours.map((o) => o.isBid)).toEqual([true, true, true, false]);
  });

  it("sets builder from BuilderFeeCharged only on the two PARTNER-tagged orders", () => {
    const ours = plan.orders.filter((o) => o.owner === ME);
    expect(ours.map((o) => o.builder)).toEqual([null, PARTNER, null, PARTNER]);
    expect(plan.builderFees).toHaveLength(2);
    expect(plan.builderFees.every((b) => b.builder === PARTNER && b.amount === 0n)).toBe(true);
  });

  it("attributes every fill to the market active on the pool and to the TAKER", () => {
    expect(plan.fills).toHaveLength(4);
    expect(plan.fills.map((f) => f.marketId)).toEqual([M1, M1, M2, M2]);
    const rows = attributeFills(plan.fills, lookupFromOrders(plan.orders));
    for (const r of rows) {
      expect(r.takerOwner).toBe(ME);
      expect(r.takerPartnerId).toBe(1);
      expect(r.takerSurfaceId).toBe(SURFACE.WEB);
      // maker is the venue's market maker: an order outside this batch → unattributed, kept separate
      expect(r.makerPartnerId).toBeNull();
      expect(r.makerOwner).toBeNull();
    }
    expect(rows.map((r) => r.takerBuilder)).toEqual([null, PARTNER, null, PARTNER]);
    expect(rows.map((r) => r.fillPrice)).toEqual([344000n, 338000n, 315000n, 287000n]);
    expect(rows.map((r) => r.notional)).toEqual([344000n, 338000n, 315000n, 287000n]);
    // taker filledQty is applied even though OrderFilled precedes the taker's OrderPlaced
    expect(plan.orders.filter((o) => o.owner === ME).every((o) => o.filledQty === 1_000_000n)).toBe(true);
  });

  it("keeps protocol fee events with the maker order id and the taker-side flag", () => {
    expect(plan.protocolFees).toHaveLength(3); // run2 B (BUY_NO / SetMinted path) emits none
    expect(plan.protocolFees.every((p) => p.isTakerSide && p.amount === 0n)).toBe(true);
  });

  it("records the settlement redemption for market 2, outcome YES (holder = module, to = wallet)", () => {
    expect(plan.redemptions).toHaveLength(1);
    const r = plan.redemptions[0]!;
    // The module pulls the outcome tokens and redeems on the wallet's behalf:
    // `holder` is the BinaryMarketsModule, the wallet is `to`. Attribute payouts by `to`.
    expect(r.holder).toBe(A.binaryModule.toLowerCase());
    expect(r.to).toBe(ME);
    expect(r.outcomeIdx).toBe(0);
    expect(r.amountBurned).toBe(1_000_000n);
    expect(r.collateralOut).toBe(1_000_000n);
    expect(r.marketId).toBe(M2);
  });
});
