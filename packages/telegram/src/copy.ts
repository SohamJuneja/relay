// Every word the bot says, in one file.
//
// Bot copy gets edited far more often than bot logic, usually by someone who is not
// going to read the handler that contains it. Keeping it here means a wording change
// is a one-line diff in a file with no control flow in it.
//
// Telegram's HTML parse mode is used throughout: <b>, <i>, <code>, <a href>. Anything
// that could contain a market's own text goes through `escapeHtml` first.

export const escapeHtml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface MarketCardCopy {
  asset: string;
  intervalLabel: string;
  question: string;
  price: string;
  openPrice: string | null;
  movePct: string | null;
  upCents: string | null;
  downCents: string | null;
  secondsLeft: number;
}

const clock = (s: number): string => {
  if (s <= 0) return "closing now";
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return m > 0 ? `${m}m ${String(sec).padStart(2, "0")}s` : `${sec}s`;
};

export const copy = {
  start: {
    text: [
      "<b>Relay</b> — trade the next fifteen minutes.",
      "",
      "Binary event contracts on Somnia: will BTC be above where this window opened when it closes? Pick a side, pay a few cents per $1 share, and the window settles itself.",
      "",
      "The mini-app creates a testnet wallet in your Telegram browser, funds it, and places the order. Nothing leaves your device except the signed transaction.",
      "",
      "<i>Testnet only. Not financial advice.</i>",
    ].join("\n"),
    button: "Open Relay",
  },

  help: [
    "<b>Commands</b>",
    "/market — the live BTC window, with a button to trade it",
    "/market eth — the ETH window instead",
    "/positions — where to find what you are holding",
    "/start — what this is",
  ].join("\n"),

  positions: [
    "Your positions live in the mini-app, not here.",
    "",
    "The wallet is created inside Telegram's browser and its key never leaves your device — which also means this bot cannot see it, and cannot tell you what you hold. Open the mini-app and the card shows every open position and anything ready to claim.",
  ].join("\n"),

  positionsButton: "Open my positions",

  /** The card posted by /market and by the scheduler. */
  marketCard(m: MarketCardCopy): string {
    const lines = [
      `<b>${escapeHtml(m.asset)} · ${escapeHtml(m.intervalLabel)} window</b>`,
      escapeHtml(m.question),
      "",
      m.openPrice ? `Now <b>${escapeHtml(m.price)}</b> · opened ${escapeHtml(m.openPrice)}${m.movePct ? ` (${escapeHtml(m.movePct)})` : ""}` : `Now <b>${escapeHtml(m.price)}</b> · opening price still landing`,
      m.upCents && m.downCents
        ? `UP <b>${escapeHtml(m.upCents)}</b> · DOWN <b>${escapeHtml(m.downCents)}</b> per $1 share`
        : "No one is quoting this window yet.",
      "",
      `Closes in <b>${clock(m.secondsLeft)}</b>.`,
    ];
    return lines.join("\n");
  },

  marketButton: "Trade this window",
  noMarket: (asset: string) => `No live ${escapeHtml(asset)} window right now. The next one opens within a couple of minutes.`,
  unknownAsset: (asset: string) => `I only know BTC and ETH — not ${escapeHtml(asset)}.`,

  scheduled: {
    /** Prefix on the card the scheduler posts, so a channel reader knows why it appeared. */
    header: "<b>New window open</b>",
  },

  dryRun: (what: string) => `[dry run] would send: ${what}`,
} as const;
