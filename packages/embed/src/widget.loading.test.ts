// The widget must not make a claim about the venue before it has asked.
//
// For ~1.5 s after mount `market` is null simply because the first request has not
// come back, and the card rendered "No live BTC 15m window right now" — a statement
// about the venue, shown on every publisher's page on every load. The fix is a
// `loaded` flag, and what these assert is the decision table it drives.

import { describe, expect, it } from "vitest";

/** The three states the card can be in for a series, given what it knows. */
export type CardState = "loading" | "empty" | "market";
export function cardState(input: { market: unknown | null; loaded: boolean }): CardState {
  if (input.market) return "market";
  return input.loaded ? "empty" : "loading";
}

describe("cardState", () => {
  it("is loading before the first lookup settles", () => {
    expect(cardState({ market: null, loaded: false })).toBe("loading");
  });

  it("only claims the venue is empty once the lookup has settled", () => {
    expect(cardState({ market: null, loaded: true })).toBe("empty");
  });

  it("shows the market whenever there is one, settled or not", () => {
    expect(cardState({ market: { id: 1 }, loaded: false })).toBe("market");
    expect(cardState({ market: { id: 1 }, loaded: true })).toBe("market");
  });

  it("never reports empty while unloaded — the case that shipped", () => {
    for (const loaded of [false, true]) {
      const s = cardState({ market: null, loaded });
      if (!loaded) expect(s).not.toBe("empty");
    }
  });
});
