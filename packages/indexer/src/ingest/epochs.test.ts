import { describe, expect, it } from "vitest";
import type { Address, Hex } from "viem";
import { EpochIndex } from "./epochs.js";

const P = "0x0000000000000000000000000000000000000001" as Address;
const A = "0x00000000000000000000000000000000000000000000000000000000000000aa" as Hex;
const B = "0x00000000000000000000000000000000000000000000000000000000000000bb" as Hex;

describe("pool epochs across a recycle", () => {
  it("attributes by (pool, block), never by pool alone", () => {
    const idx = new EpochIndex();
    const first = idx.open({ pool: P, marketId: A, nonce: 1n, fromBlock: 100n });
    expect(first.opened?.marketId).toBe(A);
    expect(first.closed).toBeNull();
    const second = idx.open({ pool: P, marketId: B, nonce: 2n, fromBlock: 200n });
    expect(second.closed?.marketId).toBe(A);
    expect(second.closed?.toBlock).toBe(199n);

    expect(idx.resolve(P, 99n)).toBeNull(); // before any market
    expect(idx.resolve(P, 100n)?.marketId).toBe(A);
    expect(idx.resolve(P, 150n)?.marketId).toBe(A);
    expect(idx.resolve(P, 199n)?.marketId).toBe(A);
    expect(idx.resolve(P, 200n)?.marketId).toBe(B); // the recycle block belongs to the new market
    expect(idx.resolve(P, 250n)?.marketId).toBe(B);
    expect(idx.byPoolNonce(P, 1n)?.marketId).toBe(A);
    expect(idx.byPoolNonce(P, 2n)?.marketId).toBe(B);
  });

  it("is idempotent for a market seen twice and case-insensitive on the pool", () => {
    const idx = new EpochIndex();
    idx.open({ pool: P, marketId: A, nonce: 1n, fromBlock: 100n });
    const again = idx.open({ pool: P.toUpperCase() as Address, marketId: A.toUpperCase() as Hex, nonce: 1n, fromBlock: 100n });
    expect(again.opened).toBeNull();
    expect(idx.resolve(P.toUpperCase(), 150n)?.marketId).toBe(A);
  });

  it("rolls back epochs opened after a block and reopens ones closed after it", () => {
    const idx = new EpochIndex();
    idx.open({ pool: P, marketId: A, nonce: 1n, fromBlock: 100n });
    idx.open({ pool: P, marketId: B, nonce: 2n, fromBlock: 200n });
    idx.rollback(180n);
    expect(idx.byMarketId(B)).toBeNull();
    expect(idx.resolve(P, 250n)?.marketId).toBe(A); // A is open again
  });
});
