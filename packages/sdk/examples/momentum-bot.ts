// Buy whatever the last three 5-minute windows resolved to, $1 a go.
//
// Not a strategy anyone should run with money — three windows is noise, and a market
// that has gone UP three times is not thereby more likely to go UP again. It is here
// to show the shape: read, decide, buy, and have the order carry the operator's
// partner id and builder code without the bot doing anything special about it.
//
//   RPC_URL=… PRIVATE_KEY=0x… API_URL=… RELAY_PARTNER_ID=… RELAY_BUILDER=0x… \
//     pnpm --filter @relay/sdk example:momentum

import { createRelay } from "../src/index.js";

const relay = createRelay({
  rpcUrl: process.env.RPC_URL!,
  privateKey: process.env.PRIVATE_KEY! as `0x${string}`,
  apiUrl: process.env.API_URL!,
  partnerId: Number(process.env.RELAY_PARTNER_ID),
  builder: process.env.RELAY_BUILDER as `0x${string}`,
  log: (s) => console.log(`  ${s}`),
});

const WINDOWS = Number(process.env.WINDOWS ?? 2);

for (let i = 0; i < WINDOWS; i++) {
  // winner: 0 = YES (UP), 1 = NO (DOWN). Resolved windows only.
  const recent = await relay.markets.recent({ asset: "BTC", intervalSec: 300, limit: 12 });
  const settled = recent.filter((m) => m.status === 4).slice(0, 3);
  if (settled.length < 3) {
    console.log("not enough settled windows yet, waiting");
    await new Promise((r) => setTimeout(r, 30_000));
    continue;
  }

  const ups = settled.filter((m) => (m as { winner?: number | null }).winner === 0).length;
  const side = ups >= 2 ? "UP" : "DOWN";
  console.log(`last 3 windows: ${ups} UP / ${3 - ups} DOWN → buying ${side}`);

  const res = await relay.buy({ asset: "BTC", intervalSec: 300, side, budget: 1 });
  console.log(`  ${res.txHash} · filled ${res.filled} @ ${res.avgPrice} · partner ${res.tag.partnerId} surface ${res.tag.surfaceId}`);

  // Wait out the window, then take anything that won.
  await new Promise((r) => setTimeout(r, 5 * 60_000 + 30_000));
  const claimed = await relay.claimAll();
  if (claimed.total > 0) console.log(`  claimed $${claimed.total.toFixed(3)} across ${claimed.claimed.length} position(s)`);
}

console.log(`done · agent ${relay.address} · partner ${relay.partnerId} · builder ${relay.builder}`);
