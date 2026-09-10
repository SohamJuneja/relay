// The Telegram bot, as a task inside the server process.
//
// Long polling rather than a webhook: a webhook needs the public URL to exist before
// the service starts, which is a chicken-and-egg on a platform that assigns the URL
// at deploy time. Long polling just works, and at this volume costs nothing.
//
// Polling is a LONG-RUNNING TASK, not a startup step. `bot.start()` resolves when
// polling stops, so awaiting it here would mean the server never finishes booting,
// and any timeout wrapped around it would report a failure for a healthy bot. The
// supervisor in @relay/telegram/polling owns that distinction, and restarts polling
// with backoff when grammY rethrows — which it does on a 409 Conflict, the ordinary
// consequence of two instances overlapping during a deploy.
//
// Without TELEGRAM_BOT_TOKEN this does nothing at all and says so once. That is the
// normal state for a deployment that has not been given a bot.

import type { BotStatus } from "@relay/api/deps";

export interface BotHandle {
  stop(): Promise<void>;
  /** Whether long polling is currently supervised. False when there is no token. */
  running(): boolean;
  /** For /health — see BotStatus. */
  status(): BotStatus;
}

export function startBot(opts: { log: (...a: unknown[]) => void }): BotHandle {
  const log = (...a: unknown[]) => opts.log("[bot]", ...a);
  const token = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();

  if (!token) {
    log("no TELEGRAM_BOT_TOKEN — not starting");
    return {
      stop: async () => undefined,
      running: () => false,
      status: () => ({ enabled: false, running: false, lastPollAt: null, lastUpdateAt: null, lastError: "TELEGRAM_BOT_TOKEN is not set", restarts: 0, reachability: null }),
    };
  }

  let stopped = false;
  let stopFn: (() => Promise<void>) | null = null;
  let isRunning = () => false;
  let lastUpdateAt: number | null = null;
  let startupError: string | null = null;
  let reachability: string | null = null;

  // Can this host reach Telegram at all?
  //
  // The token check timing out says "no answer" and nothing about why. A plain
  // request to the API root, with its error surfaced verbatim, distinguishes the
  // cases that need different fixes: ENOTFOUND is DNS, ETIMEDOUT/ECONNREFUSED is the
  // network path, a 4xx/5xx means we got there and the problem is elsewhere.
  void (async () => {
    const parts: string[] = [];

    // What the name resolves to, and which family Node will actually try first.
    // Node 18 defaults to `verbatim`, which usually means AAAA first, and on a host
    // with no IPv6 route that connection hangs rather than being refused.
    try {
      const { promises: dnsp, getDefaultResultOrder } = await import("node:dns");
      const [v4, v6] = await Promise.all([
        dnsp.resolve4("api.telegram.org").catch((e: Error) => [`error:${e.message}`]),
        dnsp.resolve6("api.telegram.org").catch((e: Error) => [`error:${e.message}`]),
      ]);
      parts.push(`order=${getDefaultResultOrder()}`, `A=[${v4.join(",")}]`, `AAAA=[${v6.join(",")}]`);
    } catch (e) {
      parts.push(`dns probe failed: ${(e as Error).message}`);
    }

    const started = Date.now();
    try {
      const r = await fetch("https://api.telegram.org/", { signal: AbortSignal.timeout(15_000) });
      parts.push(`HTTP ${r.status} in ${Date.now() - started} ms`);
    } catch (e) {
      const err = e as Error & { cause?: { code?: string; message?: string } };
      parts.push(`${err.name}: ${err.cause?.code ?? err.cause?.message ?? err.message} after ${Date.now() - started} ms`);
    }
    reachability = parts.join(" · ");
    log(`api.telegram.org reachability — ${reachability}`);
  })();
  let pollingState: (() => { running: boolean; lastPollAt: number | null; lastError: string | null; restarts: number }) | null = null;

  // Imported lazily so a deployment without a bot never loads grammY at all — on a
  // 512 MB box, a dependency you do not use is memory you do not have.
  const started = (async () => {
    const [{ Bot, InlineKeyboard }, { copy }, relay, { runPolling }] = await Promise.all([
      import("grammy"),
      import("@relay/telegram/copy"),
      import("@relay/telegram/relay"),
      import("@relay/telegram/polling"),
    ]);

    const api = new relay.RelayApi(process.env.RELAY_API_URL ?? `http://127.0.0.1:${process.env.PORT || 8787}`);
    const miniapp = (process.env.MINIAPP_URL ?? process.env.TELEGRAM_MINIAPP_URL ?? "").replace(/\/$/, "");
    const canOpen = miniapp.startsWith("https://");
    const keyboard = (label: string) => (canOpen ? new InlineKeyboard().webApp(label, miniapp) : miniapp ? new InlineKeyboard().url(label, miniapp) : undefined);

    const card = async (asset: string, intervalSec = Number(process.env.TELEGRAM_SCHEDULE_INTERVAL_SEC ?? 900)) => {
      const [markets, price] = await Promise.all([api.liveMarkets({ asset, intervalSec, limit: 4 }), api.price(asset).catch(() => null)]);
      const m = markets.find((x) => x.status === 1 && x.secondsToExpiry > 0) ?? markets[0];
      if (!m) return null;
      const now = Math.floor(Date.now() / 1000);
      return copy.marketCard({
        asset: m.asset,
        intervalLabel: relay.intervalLabel(m.intervalSec),
        question: m.question,
        price: price ? `$${relay.money(price.price)}` : "—",
        openPrice: relay.oraclePrice(m.openingPriceRaw),
        movePct: price ? relay.movePct(price.price, m.openingPriceRaw) : null,
        upCents: relay.cents(m.book?.bestAsk ?? null),
        downCents: m.book?.bestBid === null || m.book?.bestBid === undefined ? null : relay.cents(1 - m.book.bestBid),
        secondsLeft: Math.max(0, m.expiry - now),
      });
    };

    const bot = new Bot(token);

    bot.command("start", async (ctx) => {
      const kb = keyboard(copy.start.button);
      await ctx.reply(copy.start.text, { parse_mode: "HTML", ...(kb ? { reply_markup: kb } : {}) });
    });
    bot.command("help", (ctx) => ctx.reply(copy.help, { parse_mode: "HTML" }));
    bot.command("positions", async (ctx) => {
      const kb = keyboard(copy.positionsButton);
      await ctx.reply(copy.positions, { parse_mode: "HTML", ...(kb ? { reply_markup: kb } : {}) });
    });
    bot.command("market", async (ctx) => {
      const arg = (ctx.match ?? "").toString().trim().toUpperCase() || "BTC";
      if (arg !== "BTC" && arg !== "ETH") return void ctx.reply(copy.unknownAsset(arg), { parse_mode: "HTML" });
      const text = await card(arg).catch(() => null);
      if (!text) return void ctx.reply(copy.noMarket(arg), { parse_mode: "HTML" });
      const kb = keyboard(copy.marketButton);
      await ctx.reply(text, { parse_mode: "HTML", ...(kb ? { reply_markup: kb } : {}) });
    });
    // Every update, before any handler. This is the field that proves messages are
    // actually arriving, as opposed to the poller merely believing it holds the slot.
    bot.use(async (_ctx, next) => {
      lastUpdateAt = Date.now();
      await next();
    });

    bot.catch((e) => log("handler error:", e.message));

    // The scheduler, aligned to the venue's window boundaries.
    const chatId = (process.env.TELEGRAM_CHAT_ID ?? "").trim();
    const intervalSec = Number(process.env.TELEGRAM_SCHEDULE_INTERVAL_SEC ?? 900);
    void (async () => {
      if (!chatId) {
        log("no TELEGRAM_CHAT_ID — the scheduler is off; commands still work");
        return;
      }
      let lastPosted = 0;
      while (!stopped) {
        try {
          const markets = await api.liveMarkets({ asset: "BTC", intervalSec, limit: 4 });
          const expiry = relay.nextWindowOpen(markets, intervalSec);
          const m = expiry ? markets.find((x) => x.expiry === expiry) : null;
          if (expiry && m && expiry !== lastPosted) {
            const age = Math.floor(Date.now() / 1000) - m.tradingStart;
            if (age < intervalSec / 3) {
              const text = await card("BTC", intervalSec);
              if (text) {
                const kb = keyboard(copy.marketButton);
                await bot.api.sendMessage(chatId, `${copy.scheduled.header}\n\n${text}`, { parse_mode: "HTML", ...(kb ? { reply_markup: kb } : {}) });
                log(`posted a window card to ${chatId}`);
              }
            }
            lastPosted = expiry;
          }
        } catch (e) {
          log(`scheduler: ${(e as Error).message}`);
        }
        await new Promise((r) => setTimeout(r, 15_000));
      }
    })();

    log(`long polling · mini-app ${miniapp || "(not set)"}${canOpen ? "" : " (not https — buttons degrade to links)"}`);

    // Launch polling under the supervisor and wait only for `ready`, which resolves
    // after one getMe. The poller itself runs until stop() and is never awaited here.
    const polling = runPolling(bot, { log });
    stopFn = async () => polling.stop();
    isRunning = () => polling.running();
    pollingState = () => polling.state();
    await polling.ready;
  })().catch((e) => {
    startupError = (e as Error).message;
    log(`failed to start: ${startupError}`);
  });

  return {
    running: () => isRunning(),
    status: () => {
      const p = pollingState?.() ?? null;
      return {
        enabled: true,
        running: p?.running ?? false,
        lastPollAt: p?.lastPollAt ? new Date(p.lastPollAt).toISOString() : null,
        lastUpdateAt: lastUpdateAt ? new Date(lastUpdateAt).toISOString() : null,
        // A startup failure outranks a polling error: if the import or the token check
        // never got as far as polling, that is the thing to report.
        lastError: startupError ?? p?.lastError ?? null,
        restarts: p?.restarts ?? 0,
        reachability,
      };
    },
    async stop() {
      stopped = true;
      await stopFn?.().catch(() => undefined);
      await started;
    },
  };
}
