// The Relay bot.
//
//   pnpm --filter @relay/telegram bot
//
// Three commands and a scheduler. It never signs anything and never holds a key: its
// only job is to put a live window in front of someone and hand them a button that
// opens the mini-app, where their own device does the signing.
//
// Without TELEGRAM_BOT_TOKEN it runs in DRY RUN: every message it would send is
// printed instead, so the copy and the scheduler can be exercised without a token.

// FIRST, before anything can resolve a hostname. See the module for why.
import "./ipv4-first.js";
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Bot, InlineKeyboard } from "grammy";
import { copy, type MarketCardCopy } from "./copy.js";
import { RelayApi, cents, intervalLabel, money, movePct, nextWindowOpen, oraclePrice, type Market } from "./relay.js";
import { runPolling } from "./polling.js";

// Local development only; the deployed bot runs inside packages/server, which never
// reads a file for its configuration. See packages/indexer/src/config.ts.
if (process.env.NODE_ENV !== "production") {
  loadEnv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env") });
}

const TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const API = (process.env.RELAY_API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const MINIAPP_URL = (process.env.TELEGRAM_MINIAPP_URL ?? "").replace(/\/$/, "");
const CHAT_ID = (process.env.TELEGRAM_CHAT_ID ?? "").trim();
const SCHEDULE_INTERVAL_SEC = Number(process.env.TELEGRAM_SCHEDULE_INTERVAL_SEC ?? 900);
const DRY_RUN = !TOKEN || process.env.TELEGRAM_DRY_RUN === "true";

const api = new RelayApi(API);
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

/**
 * Telegram only opens a web_app button over https. Without a public URL the button
 * cannot exist, so the bot falls back to a plain link and says why — a button that
 * silently does nothing is worse than no button.
 */
const canOpenMiniApp = MINIAPP_URL.startsWith("https://");

function tradeKeyboard(label: string): InlineKeyboard | undefined {
  if (canOpenMiniApp) return new InlineKeyboard().webApp(label, MINIAPP_URL);
  if (MINIAPP_URL) return new InlineKeyboard().url(`${label} (opens in a browser)`, MINIAPP_URL);
  return undefined;
}

async function cardFor(asset: string, intervalSec = SCHEDULE_INTERVAL_SEC): Promise<{ text: string; market: Market } | null> {
  const [markets, price] = await Promise.all([api.liveMarkets({ asset, intervalSec, limit: 4 }), api.price(asset).catch(() => null)]);
  const m = markets.find((x) => x.status === 1 && x.secondsToExpiry > 0) ?? markets[0];
  if (!m) return null;
  const now = Math.floor(Date.now() / 1000);
  const card: MarketCardCopy = {
    asset: m.asset,
    intervalLabel: intervalLabel(m.intervalSec),
    question: m.question,
    price: price ? `$${money(price.price)}` : "—",
    openPrice: oraclePrice(m.openingPriceRaw),
    movePct: price ? movePct(price.price, m.openingPriceRaw) : null,
    upCents: cents(m.book?.bestAsk ?? null),
    downCents: m.book?.bestBid === null || m.book?.bestBid === undefined ? null : cents(1 - m.book.bestBid),
    secondsLeft: Math.max(0, m.expiry - now),
  };
  return { text: copy.marketCard(card), market: m };
}

// ── the bot ────────────────────────────────────────────────────────────────

const bot = TOKEN ? new Bot(TOKEN) : null;

if (bot) {
  bot.command("start", async (ctx) => {
    const kb = tradeKeyboard(copy.start.button);
    await ctx.reply(copy.start.text, { parse_mode: "HTML", ...(kb ? { reply_markup: kb } : {}) });
  });

  bot.command("help", (ctx) => ctx.reply(copy.help, { parse_mode: "HTML" }));

  bot.command("market", async (ctx) => {
    const arg = (ctx.match ?? "").toString().trim().toUpperCase() || "BTC";
    if (arg !== "BTC" && arg !== "ETH") {
      await ctx.reply(copy.unknownAsset(arg), { parse_mode: "HTML" });
      return;
    }
    const card = await cardFor(arg).catch(() => null);
    if (!card) {
      await ctx.reply(copy.noMarket(arg), { parse_mode: "HTML" });
      return;
    }
    const kb = tradeKeyboard(copy.marketButton);
    await ctx.reply(card.text, { parse_mode: "HTML", ...(kb ? { reply_markup: kb } : {}) });
  });

  bot.command("positions", async (ctx) => {
    const kb = tradeKeyboard(copy.positionsButton);
    await ctx.reply(copy.positions, { parse_mode: "HTML", ...(kb ? { reply_markup: kb } : {}) });
  });

  bot.catch((err) => log("bot error:", err.message));
}

// ── the scheduler ──────────────────────────────────────────────────────────
//
// Posts a card when a window opens, aligned to the VENUE's boundaries rather than to
// the wall clock: it waits for the live market to expire, because that instant is
// when its successor begins.

async function scheduleLoop(): Promise<void> {
  if (!CHAT_ID && !DRY_RUN) {
    log("no TELEGRAM_CHAT_ID — the scheduler is off; commands still work");
    return;
  }
  let lastPostedExpiry = 0;
  for (;;) {
    try {
      const markets = await api.liveMarkets({ asset: "BTC", intervalSec: SCHEDULE_INTERVAL_SEC, limit: 4 });
      const expiry = nextWindowOpen(markets, SCHEDULE_INTERVAL_SEC);
      if (expiry && expiry !== lastPostedExpiry) {
        // A window we have not posted yet: post it once, near its start.
        const m = markets.find((x) => x.expiry === expiry);
        const age = m ? Math.floor(Date.now() / 1000) - m.tradingStart : 0;
        if (m && age < SCHEDULE_INTERVAL_SEC / 3) {
          const card = await cardFor("BTC", SCHEDULE_INTERVAL_SEC);
          if (card) {
            const text = `${copy.scheduled.header}\n\n${card.text}`;
            if (DRY_RUN || !bot) {
              log(copy.dryRun(`to ${CHAT_ID || "<no chat id>"}\n${text}`));
            } else {
              const kb = tradeKeyboard(copy.marketButton);
              await bot.api.sendMessage(CHAT_ID, text, { parse_mode: "HTML", ...(kb ? { reply_markup: kb } : {}) });
              log(`posted the ${intervalLabel(SCHEDULE_INTERVAL_SEC)} window card to ${CHAT_ID}`);
            }
            lastPostedExpiry = expiry;
          }
        } else {
          // Mid-window at startup: skip it rather than posting a card that is already
          // half over, and wait for the next one.
          lastPostedExpiry = expiry;
        }
      }
    } catch (e) {
      log(`scheduler: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

// ── start ──────────────────────────────────────────────────────────────────

log(`Relay bot · API ${API} · mini-app ${MINIAPP_URL || "(not set)"} · ${DRY_RUN ? "DRY RUN" : "live"}`);
if (!canOpenMiniApp) {
  log(MINIAPP_URL ? "mini-app URL is not https — Telegram will not open it as a web app; using a plain link" : "no TELEGRAM_MINIAPP_URL — buttons are omitted. Run `pnpm --filter @relay/telegram tunnel` to get one.");
}

if (DRY_RUN) {
  log("no TELEGRAM_BOT_TOKEN (or TELEGRAM_DRY_RUN=true): printing what would be sent");
  for (const asset of ["BTC", "ETH"] as const) {
    const card = await cardFor(asset).catch(() => null);
    log(copy.dryRun(card ? `/market ${asset.toLowerCase()}\n${card.text}` : copy.noMarket(asset)));
  }
  log(copy.dryRun(`/start\n${copy.start.text}`));
  log(copy.dryRun(`/positions\n${copy.positions}`));
  void scheduleLoop();
} else if (bot) {
  void scheduleLoop();
  // Polling is the process's long-running work, not a step on the way to being
  // started: `bot.start()` resolves when polling STOPS. The supervisor proves the
  // token with one getMe, reports ready, and restarts polling with backoff if it
  // comes back — grammY rethrows on a 409 Conflict, which is what an overlapping
  // second instance looks like, and nothing inside grammY retries after that.
  const polling = runPolling(bot, { log });
  await polling.ready;
  const shutdown = (signal: string) => {
    log(`${signal} — stopping`);
    void polling.stop().then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
