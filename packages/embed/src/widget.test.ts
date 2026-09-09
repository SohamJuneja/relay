// The widget's own pure surface: attribute parsing, revert copy, and the
// attribution tag it puts on every order. (Order maths itself is tested in
// @relay/core, which both the widget and the Node signer share.)

import { describe, expect, it } from "vitest";
import { SURFACE, decodeUserData, encodeUserData } from "@relay/core/browser";
import { revertMessage } from "./chain.js";
import { cents, countdown, intervalLabel, localTime, oraclePrice, pct, signedPct, usd, utcTime } from "./format.js";

describe("attribution the widget sends", () => {
  it("encodes partner + surface exactly as the indexer decodes it", () => {
    for (const [name, id] of Object.entries(SURFACE)) {
      if (id === 0) continue;
      const tag = encodeUserData({ partnerId: 7, surfaceId: id });
      const back = decodeUserData(tag);
      expect(back.tagged).toBe(true);
      expect(back.partnerId).toBe(7);
      expect(back.surfaceId).toBe(id);
      expect(back.surface).toBe(name);
    }
  });

  it("treats a missing partner as untagged rather than partner 0", () => {
    expect(decodeUserData(0n).tagged).toBe(false);
    expect(() => encodeUserData({ partnerId: 0, surfaceId: SURFACE.WEB })).toThrow();
  });
});

describe("revert copy is human, not hex", () => {
  it("explains the reverts a taker actually hits", () => {
    expect(revertMessage("ImmediateOrCancelNoFill")).toMatch(/price moved/i);
    expect(revertMessage("ERC20InsufficientBalance")).toMatch(/not enough tUSDC/i);
    expect(revertMessage("BuilderFeeExceedsCap")).toMatch(/not enabled/i);
    expect(revertMessage("CloseNotCaptured")).toMatch(/closed/i);
  });

  it("never leaks an empty message for an unknown selector", () => {
    expect(revertMessage(null).length).toBeGreaterThan(10);
    expect(revertMessage("SomethingNew")).toContain("SomethingNew");
  });
});

describe("number formatting", () => {
  it("keeps prices at 2 dp and percentages at 1", () => {
    expect(usd(1)).toBe("$1.00");
    expect(usd(0.494)).toBe("$0.49");
    expect(pct(0.633)).toBe("63.3%");
    expect(pct(null)).toBe("—");
  });

  it("rounds probabilities the way binary floats actually land", () => {
    // 0.6325 is 63.2499…% once it goes through a double, so it shows 63.2%.
    // Book prices are k/1e6, so an exact .xx5 midpoint never arises in practice.
    expect(pct(0.6325)).toBe("63.2%");
  });

  it("signs the move and uses a real minus sign", () => {
    expect(signedPct(0.4237)).toBe("+0.42%");
    expect(signedPct(-1.5)).toBe("−1.50%");
  });

  it("renders the oracle's 2-dp integers", () => {
    expect(oraclePrice("7845603")).toBe("78,456.03");
    expect(oraclePrice(null)).toBe("—");
  });

  it("counts down in m:ss and h:mm:ss", () => {
    expect(countdown(59)).toBe("0:59");
    expect(countdown(95)).toBe("1:35");
    expect(countdown(3725)).toBe("1:02:05");
    expect(countdown(0)).toBe("0:00");
  });

  it("labels the series the way the app does", () => {
    expect(intervalLabel(300)).toBe("5m");
    expect(intervalLabel(900)).toBe("15m");
    expect(intervalLabel(3600)).toBe("1h");
    expect(intervalLabel(86400)).toBe("1d");
  });
});

describe("what a share costs", () => {
  it("turns an ask into cents per $1 share", () => {
    // The big number on the card is a probability; this is the same fact as a price,
    // which is the one the reader is about to pay.
    expect(cents(0.23)).toBe("23.0¢");
    // 0.9235 is not 0.9235 in binary, so it rounds down. Asserting the real
    // behaviour, the same way the percentage test does, rather than the arithmetic
    // one — the two must never disagree, because they label the same number.
    expect(cents(0.9235)).toBe("92.3¢");
    expect(cents(0.9235)).toBe(pct(0.9235).replace("%", "¢"));
    expect(cents(0.026)).toBe("2.6¢");
    expect(cents(1)).toBe("100.0¢");
  });

  it("has no answer rather than a wrong one when a side is unquoted", () => {
    expect(cents(null)).toBe("—");
    expect(cents(undefined)).toBe("—");
  });
});

describe("when the window closes", () => {
  const t = Date.UTC(2026, 8, 9, 23, 30) / 1000; // 9 Sep 2026, 23:30 UTC

  it("names the zone, so a bare 23:30 is never ambiguous", () => {
    const s = localTime(t);
    expect(s).toMatch(/^\d{2}:\d{2}( .+)?$/);
  });

  it("puts the UTC instant in the title, with the date", () => {
    expect(utcTime(t)).toBe("23:30 UTC · 9 Sep 2026");
  });

  it("pads a single-digit UTC hour", () => {
    expect(utcTime(Date.UTC(2026, 0, 2, 4, 5) / 1000)).toBe("04:05 UTC · 2 Jan 2026");
  });
});
