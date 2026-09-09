// Phase 2 · verification 3 — register "Relay Demo", place ONE tagged trade,
// and time how long until it is visible via REST and via the WS stream.
//
//   API_URL=http://localhost:8787 pnpm tsx scripts/phase2-partner-test.ts

import { writeFileSync } from "node:fs";
import { contractErrorsAbi } from "@somnia-chain/markets-sdk";
import { SURFACE, encodeUserData, placeTakerBuy } from "@relay/core";
import { loadPhase1Env, txUrl } from "./_env.js";
import { loadState, pickTradingMarket } from "./_pick.js";

const API = (process.env.API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const WS = API.replace(/^http/, "ws") + "/v1/stream";

async function main(): Promise<void> {
  const env = loadPhase1Env();
  const st = loadState();
  const builder = st.partner?.builder;
  if (!builder) throw new Error("no Phase 1 PARTNER address in artifacts/phase1.json");

  // 1. register the partner
  const reg = await fetch(`${API}/v1/partners`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Relay Demo", builderAddress: builder }) });
  if (reg.status !== 201) throw new Error(`POST /v1/partners → ${reg.status} ${await reg.text()}`);
  const partner = (await reg.json()) as { partnerId: number; apiKey: string; userDataHint: { example: string } };
  console.log(`partner registered: id ${partner.partnerId} builder ${builder} (apiKey ${partner.apiKey.slice(0, 6)}… stored hashed)`);
  const userData = encodeUserData({ partnerId: partner.partnerId, surfaceId: SURFACE.WEB });
  if (userData.toString() !== partner.userDataHint.example) throw new Error("API userData hint disagrees with core encodeUserData");

  // 2. WS subscribe (all) before trading
  const ws = new WebSocket(WS);
  let wsFillAt: number | null = null;
  let wsFill: unknown = null;
  let txHashSeen: string | null = null;
  await new Promise<void>((res, rej) => {
    ws.onopen = () => {
      ws.send(JSON.stringify({ subscribe: { all: true } }));
      res();
    };
    ws.onerror = () => rej(new Error("ws error"));
  });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as { type: string; data: { txHash?: string } };
    if (msg.type === "fill" && txHashSeen && msg.data.txHash?.toLowerCase() === txHashSeen.toLowerCase() && wsFillAt === null) {
      wsFillAt = Date.now();
      wsFill = msg.data;
    }
  };

  // 3. the trade: 15m DreamDEX market, 1 contract, UP, builder = partner, userData = tag
  const pick = await pickTradingMarket(env, { minLeftSec: 90, preferIntervals: [900, 300] });
  console.log(`market ${pick.m.marketId} ${pick.m.asset} ${pick.m.intervalSec}s (expires in ${pick.m.expiry - Math.floor(Date.now() / 1000)}s)`);
  const r = await placeTakerBuy({
    publicClient: env.publicClient,
    walletClient: env.walletClient,
    account: env.account,
    binaryModule: env.addresses.binaryModule,
    marketId: pick.m.marketId,
    outcome: "UP",
    budgetCollateral: 2n * env.one,
    maxPrice: env.one - 1n,
    quantity: 1n * env.one,
    partner: { builder, builderFeeBpsTimes1k: 0n, userData },
    extraErrorsAbi: contractErrorsAbi,
    log: (s) => console.log(`  · ${s}`),
  });
  const minedAt = Date.now();
  txHashSeen = r.hash;
  const blk = await env.publicClient.getBlock({ blockNumber: r.blockNumber });
  console.log(`trade tx ${r.hash} block ${r.blockNumber} (block ts ${new Date(Number(blk.timestamp) * 1000).toISOString()})\n  ${txUrl(env.explorer, r.hash)}\n  filled ${r.filled} @ ${r.fillPriceOwn} · BuilderFeeCharged ${r.logs.some((l) => l.eventName === "BuilderFeeCharged") ? "yes" : "no"}`);

  // 4. poll REST until the fill shows up for the partner
  let restAt: number | null = null;
  let restRow: unknown = null;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline && (restAt === null || wsFillAt === null)) {
    if (restAt === null) {
      const res = await fetch(`${API}/v1/partners/${partner.partnerId}/fills?limit=20`, { headers: { "x-api-key": partner.apiKey } });
      const rows = (await res.json()) as { txHash: string }[];
      const hit = rows.find((x) => x.txHash.toLowerCase() === r.hash.toLowerCase());
      if (hit) {
        restAt = Date.now();
        restRow = hit;
      }
    }
    await new Promise((x) => setTimeout(x, 200));
  }
  ws.close();
  const restLatency = restAt === null ? null : (restAt - minedAt) / 1000;
  const wsLatency = wsFillAt === null ? null : (wsFillAt - minedAt) / 1000;
  console.log(`\nREST visible after ${restLatency === null ? "TIMEOUT" : restLatency.toFixed(2) + " s"} (receipt → GET /v1/partners/${partner.partnerId}/fills)`);
  console.log(`WS   fill event after ${wsLatency === null ? "TIMEOUT" : wsLatency.toFixed(2) + " s"} (receipt → /v1/stream)`);
  console.log(`fill row (REST):\n${JSON.stringify(restRow, null, 2)}`);
  const stats = await (await fetch(`${API}/v1/partners/${partner.partnerId}/stats`, { headers: { "x-api-key": partner.apiKey } })).json();
  console.log(`partner stats:\n${JSON.stringify(stats, null, 2)}`);
  writeFileSync("artifacts/phase2-partner.json", JSON.stringify({ partner: { partnerId: partner.partnerId, apiKey: partner.apiKey, builder }, tx: r.hash, marketId: pick.m.marketId, minedAt, restAt, wsFillAt, restLatencySec: restLatency, wsLatencySec: wsLatency, restRow, wsFill, stats }, null, 2));
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
