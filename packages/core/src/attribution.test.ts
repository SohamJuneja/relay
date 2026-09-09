import { describe, expect, it } from "vitest";
import {
  MAX_PARTNER_ID,
  MAX_SURFACE_ID,
  SURFACE,
  UINT64_MAX,
  decodeUserData,
  encodeUserData,
  formatUserData,
  isRelayTagged,
  projectBuilderFee,
} from "./attribution.js";

describe("userData tag", () => {
  it("round-trips a v1 tag", () => {
    const raw = encodeUserData({ partnerId: 42, surfaceId: SURFACE.TELEGRAM });
    const d = decodeUserData(raw);
    expect(d.version).toBe(1);
    expect(d.partnerId).toBe(42);
    expect(d.surfaceId).toBe(SURFACE.TELEGRAM);
    expect(d.surface).toBe("TELEGRAM");
    expect(d.reserved).toBe(0);
    expect(d.tagged).toBe(true);
    expect(d.raw).toBe(raw);
  });

  it("lays bits out as [8 version][32 partner][16 surface][8 reserved]", () => {
    const raw = encodeUserData({ partnerId: 0x01020304, surfaceId: 0x0506, reserved: 0x07 });
    expect(raw).toBe(0x01_01020304_0506_07n);
    expect(raw).toBeLessThanOrEqual(UINT64_MAX);
  });

  it("treats version 0 (kit / app orders) as untagged", () => {
    expect(decodeUserData(0n).tagged).toBe(false);
    expect(isRelayTagged(0)).toBe(false);
    expect(formatUserData(0n)).toBe("untagged (0)");
    // A foreign uint64 whose top byte is 0 is untagged even if the lower bits look plausible.
    expect(decodeUserData(0x00_00000042_0001_00n).tagged).toBe(false);
  });

  it("rejects partnerId 0 and out-of-range fields", () => {
    expect(() => encodeUserData({ partnerId: 0 })).toThrow(RangeError);
    expect(() => encodeUserData({ partnerId: MAX_PARTNER_ID + 1 })).toThrow(RangeError);
    expect(() => encodeUserData({ partnerId: 1, surfaceId: MAX_SURFACE_ID + 1 })).toThrow(RangeError);
    expect(() => encodeUserData({ partnerId: 1, reserved: 256 })).toThrow(RangeError);
    expect(() => encodeUserData({ partnerId: 1.5 })).toThrow(RangeError);
  });

  it("accepts the maximum values and stays inside uint64", () => {
    const raw = encodeUserData({ partnerId: MAX_PARTNER_ID, surfaceId: MAX_SURFACE_ID, reserved: 0 });
    expect(raw <= UINT64_MAX).toBe(true);
    const d = decodeUserData(raw);
    expect(d.partnerId).toBe(MAX_PARTNER_ID);
    expect(d.surfaceId).toBe(MAX_SURFACE_ID);
    expect(d.tagged).toBe(true);
  });

  it("decodes from string and number inputs", () => {
    const raw = encodeUserData({ partnerId: 7, surfaceId: SURFACE.WEB });
    expect(decodeUserData(raw.toString()).partnerId).toBe(7);
    expect(decodeUserData(Number(raw)).partnerId).toBe(7); // < 2^53 for small partner ids? no — check explicitly
  });

  it("rejects values outside uint64", () => {
    expect(() => decodeUserData(UINT64_MAX + 1n)).toThrow(RangeError);
    expect(() => decodeUserData(-1n)).toThrow(RangeError);
  });

  it("reserved ≠ 0 is not a valid v1 tag (forward-compat guard)", () => {
    const raw = encodeUserData({ partnerId: 9, reserved: 1 });
    expect(decodeUserData(raw).tagged).toBe(false);
  });

  it("formats for logs", () => {
    expect(formatUserData(encodeUserData({ partnerId: 3, surfaceId: SURFACE.WEB }))).toBe("relay:v1 partner=3 surface=WEB");
  });
});

describe("projectBuilderFee", () => {
  it("1% cap on 100 collateral notional = 1 collateral (taker only)", () => {
    const one = 10n ** 18n;
    expect(projectBuilderFee({ notionalRaw: 100n * one, builderFeeBpsTimes1k: 100_000n })).toBe(1n * one);
  });
  it("doubles when modelled on both sides", () => {
    expect(projectBuilderFee({ notionalRaw: 1_000_000n, builderFeeBpsTimes1k: 100_000n, sides: 2 })).toBe(20_000n);
  });
  it("is 0 at cap 0 (testnet)", () => {
    expect(projectBuilderFee({ notionalRaw: 123_456n, builderFeeBpsTimes1k: 0n })).toBe(0n);
  });
});
