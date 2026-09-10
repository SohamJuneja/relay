// The momentum example, running on the server, so the leaderboard keeps showing live
// agent flow.
//
// This is the packages/sdk example bot as a background task: buy whichever way the
// last three 5-minute windows resolved, $1 a window, claim what wins. It exists so a
// judge looking at the ecosystem page sees agent flow arriving rather than a static
// row from a run that finished hours ago.
//
// OFF by default, and deliberately so: it spends real testnet collateral from the
// server's own wallet, once every five minutes, forever. RELAY_EXAMPLE_AGENT=1 turns
// it on.
//
// It is not a strategy. Three windows is noise, and a market that has gone up three
// times is not thereby more likely to go up again.

import type { Address, Hex } from "viem";

export interface ExampleAgentHandle {
  stop(): Promise<void>;
  status(): { enabled: boolean; running: boolean; trades: number; lastTradeAt: string | null; lastError: string | null };
}

const OFF: ExampleAgentHandle = {
  stop: async () => undefined,
  status: () => ({ enabled: false, running: false, trades: 0, lastTradeAt: null, lastError: null }),
};

export function startExampleAgent(opts: { log: (...a: unknown[]) => void }): ExampleAgentHandle {
  const log = (...a: unknown[]) => opts.log("[agent]", ...a);
  if (process.env.RELAY_EXAMPLE_AGENT !== "1") return OFF;

  const privateKey = (process.env.PRIVATE_KEY ?? "").trim() as Hex;
  const partnerId = Number(process.env.RELAY_AGENT_PARTNER_ID ?? "0");
  const builder = (process.env.RELAY_AGENT_BUILDER ?? "").trim() as Address;
  const apiUrl = (process.env.PUBLIC_API_URL ?? `http://127.0.0.1:${process.env.PORT || 8787}`).replace(/\/$/, "");
  const budget = Number(process.env.RELAY_EXAMPLE_AGENT_BUDGET ?? "1");

  if (!privateKey || !Number.isInteger(partnerId) || partnerId <= 0) {
    log("enabled but not configured — needs PRIVATE_KEY and RELAY_AGENT_PARTNER_ID; not starting");
    return { ...OFF, status: () => ({ enabled: true, running: false, trades: 0, lastTradeAt: null, lastError: "PRIVATE_KEY or RELAY_AGENT_PARTNER_ID is missing" }) };
  }

  let stopping = false;
  let trades = 0;
  let lastTradeAt: number | null = null;
  let lastError: string | null = null;
  let running = false;

  const loop = (async () => {
    // Lazily imported so a server with the flag off never loads the SDK or viem's
    // wallet client at all.
    const { createRelay } = await import("@relay/sdk");
    const relay = createRelay({ rpcUrl: process.env.RPC_URL!, privateKey, apiUrl, partnerId, builder, log: (s) => log(s) });
    running = true;
    log(`running · agent ${relay.address} · partner ${partnerId} · $${budget} per 5m window`);

    let lastTradedExpiry = 0;
    while (!stopping) {
      try {
        const recent = await relay.markets.recent({ asset: "BTC", intervalSec: 300, limit: 12 });
        const settled = recent.filter((m) => m.status === 4 && m.winner).slice(0, 3);
        const live = await relay.markets.live({ asset: "BTC", intervalSec: 300, limit: 4 });
        const window = live.find((m) => m.status === 1 && m.secondsToExpiry > 45);

        // One trade per window: the loop ticks faster than a window closes, and
        // without this it would buy the same window repeatedly.
        if (settled.length === 3 && window && window.expiry !== lastTradedExpiry) {
          const ups = settled.filter((m) => m.winner === "UP").length;
          const side = ups >= 2 ? "UP" : "DOWN";
          const res = await relay.buy({ marketId: window.marketId, side, budget });
          lastTradedExpiry = window.expiry;
          trades += 1;
          lastTradeAt = Date.now();
          lastError = null;
          log(`${side} · ${res.txHash} · filled ${res.filled} @ ${res.avgPrice} · surface ${res.tag.surfaceId}`);
        }

        const claimed = await relay.claimAll();
        if (claimed.total > 0) log(`claimed $${claimed.total.toFixed(3)} across ${claimed.claimed.length} position(s)`);
      } catch (e) {
        // A failed window is a skipped window, never a stopped agent.
        lastError = (e as Error).message.split("\n")[0]!;
        log(`skipped: ${lastError}`);
      }
      for (let i = 0; i < 30 && !stopping; i++) await new Promise((r) => setTimeout(r, 1000));
    }
  })().catch((e) => {
    running = false;
    lastError = (e as Error).message;
    log(`stopped: ${lastError}`);
  });

  return {
    async stop() {
      stopping = true;
      await loop.catch(() => undefined);
      running = false;
    },
    status: () => ({ enabled: true, running, trades, lastTradeAt: lastTradeAt ? new Date(lastTradeAt).toISOString() : null, lastError }),
  };
}
