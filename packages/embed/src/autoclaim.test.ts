// The rule that decides whether the widget signs on its own.
//
// It only ever gets to do that because the instant wallet's key is already in this
// browser and it already signs every trade with it. An injected wallet's every
// signature is a prompt a person answers, so a page that fires them unprompted is
// doing something no reader agreed to. That distinction is the whole test.

import { describe, expect, it } from "vitest";
import { claimMode } from "./autoclaim.js";

describe("claimMode", () => {
  it("redeems on its own for an instant wallet", () => {
    expect(claimMode({ kind: "instant", total: 1.42, enabled: true })).toBe("auto");
  });

  it("never redeems on its own for an injected wallet, even with the flag on", () => {
    expect(claimMode({ kind: "injected", total: 1.42, enabled: true })).toBe("manual");
  });

  it("falls back to the button when data-auto-claim is off", () => {
    expect(claimMode({ kind: "instant", total: 1.42, enabled: false })).toBe("manual");
  });

  it("shows nothing when there is nothing to claim", () => {
    expect(claimMode({ kind: "instant", total: 0, enabled: true })).toBe("none");
    expect(claimMode({ kind: "injected", total: 0, enabled: true })).toBe("none");
    expect(claimMode({ kind: null, total: 5, enabled: true })).toBe("none");
  });

  it("treats a negative total as nothing rather than as something", () => {
    expect(claimMode({ kind: "instant", total: -1, enabled: true })).toBe("none");
  });

  it("only ever returns auto for the instant wallet", () => {
    const kinds = ["instant", "injected", null] as const;
    for (const kind of kinds) {
      for (const enabled of [true, false]) {
        for (const total of [0, 0.01, 100]) {
          const m = claimMode({ kind, total, enabled });
          if (m === "auto") {
            expect(kind).toBe("instant");
            expect(enabled).toBe(true);
            expect(total).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});
