// The two things in this package that can be wrong without anyone noticing: the card
// a channel sees, and the moment the scheduler decides a window has opened.

import { describe, expect, it } from "vitest";
import { copy, escapeHtml } from "./copy.js";
import { cents, intervalLabel, movePct, nextWindowOpen, oraclePrice, type Market } from "./relay.js";

const market = (over: Partial<Market> = {}): Market => ({
  marketId: "0x1",
  asset: "BTC",
  intervalSec: 900,
  expiry: 1_000_900,
  secondsToExpiry: 400,
  status: 1,
  question: "BTC closes at or above its opening price",
  openingPriceRaw: "7879510",
  tradingStart: 1_000_000,
  book: { bestBid: 0.86, bestAsk: 0.882 },
  ...over,
});

describe("the market card", () => {
  it("names the price, the open, the move and both sides", () => {
    const text = copy.marketCard({
      asset: "BTC",
      intervalLabel: "15m",
      question: market().question,
      price: "$78,848.55",
      openPrice: oraclePrice("7879510"),
      movePct: movePct(78848.55, "7879510"),
      upCents: cents(0.882),
      downCents: cents(1 - 0.86),
      secondsLeft: 179,
    });
    expect(text).toContain("<b>BTC · 15m window</b>");
    expect(text).toContain("opened 78,795.10");
    expect(text).toContain("+0.07%");
    expect(text).toContain("UP <b>88.2¢</b> · DOWN <b>14.0¢</b>");
    expect(text).toContain("Closes in <b>2m 59s</b>");
  });

  it("says the opening price is still landing rather than showing a blank", () => {
    const text = copy.marketCard({
      asset: "ETH",
      intervalLabel: "5m",
      question: "q",
      price: "$2,496.52",
      openPrice: null,
      movePct: null,
      upCents: cents(0.5),
      downCents: cents(0.5),
      secondsLeft: 30,
    });
    expect(text).toContain("opening price still landing");
    expect(text).not.toContain("opened —");
  });

  it("says nobody is quoting rather than printing two dashes", () => {
    const text = copy.marketCard({
      asset: "BTC",
      intervalLabel: "1h",
      question: "q",
      price: "$1",
      openPrice: "1.00",
      movePct: "+0.00%",
      upCents: null,
      downCents: null,
      secondsLeft: 5,
    });
    expect(text).toContain("No one is quoting this window yet.");
  });

  it("escapes anything the market could put in its own question", () => {
    // The question comes from chain data. HTML parse mode plus an unescaped angle
    // bracket is a message Telegram refuses to send at all.
    expect(escapeHtml('a <b>bold</b> & "quoted"')).toBe('a &lt;b&gt;bold&lt;/b&gt; &amp; "quoted"');
    const text = copy.marketCard({
      asset: "BTC",
      intervalLabel: "15m",
      question: "will BTC > 79k <soon>?",
      price: "$1",
      openPrice: null,
      movePct: null,
      upCents: null,
      downCents: null,
      secondsLeft: 10,
    });
    expect(text).toContain("&lt;soon&gt;");
    expect(text).not.toContain("<soon>");
  });

  it("counts down in minutes and seconds, and says so at zero", () => {
    const at = (secondsLeft: number) =>
      copy.marketCard({ asset: "BTC", intervalLabel: "15m", question: "q", price: "$1", openPrice: null, movePct: null, upCents: null, downCents: null, secondsLeft });
    expect(at(605)).toContain("10m 05s");
    expect(at(45)).toContain("45s");
    expect(at(0)).toContain("closing now");
  });
});

describe("the scheduler's idea of a window boundary", () => {
  it("takes the next boundary from the live market, not the wall clock", () => {
    // These expiries are deliberately off any neat clock time. A wall-clock scheduler
    // would post into the wrong window; this one follows the venue.
    const markets = [market({ expiry: 1_000_937, intervalSec: 900 }), market({ expiry: 1_001_837, intervalSec: 900 }), market({ expiry: 1_000_100, intervalSec: 300 })];
    expect(nextWindowOpen(markets, 900)).toBe(1_000_937);
  });

  it("ignores markets of another cadence", () => {
    const markets = [market({ expiry: 1_000_100, intervalSec: 300 })];
    expect(nextWindowOpen(markets, 900)).toBeNull();
  });

  it("ignores windows that are no longer trading", () => {
    const markets = [market({ expiry: 1_000_500, status: 2 }), market({ expiry: 1_000_900, status: 1 })];
    expect(nextWindowOpen(markets, 900)).toBe(1_000_900);
  });
});

describe("number formatting", () => {
  it("shows an ask as cents per $1 share", () => {
    expect(cents(0.882)).toBe("88.2¢");
    expect(cents(null)).toBeNull();
  });

  it("signs the move with a real minus sign", () => {
    expect(movePct(78700, "7879510")).toMatch(/^−/);
    expect(movePct(78900, "7879510")).toMatch(/^\+/);
    expect(movePct(78900, null)).toBeNull();
  });

  it("labels cadences the way the widget does", () => {
    expect(intervalLabel(300)).toBe("5m");
    expect(intervalLabel(3600)).toBe("1h");
    expect(intervalLabel(86400)).toBe("1d");
  });
});
