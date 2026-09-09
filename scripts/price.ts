// Phase 1 · Step 6 — underlying price for the widget, and where a reference-mode
// market's OPENING price lives.
//
//   pnpm price

import { formatUnits, pad, parseAbi, toHex, type Address, type Hex } from "viem";
import { SomniaMarkets, SOMNIA_TESTNET_ADDRESSES, SOMNIA_TESTNET_PRICE_FEED } from "@somnia-chain/markets-sdk";
import { somniaShannon } from "@somnia-chain/markets-sdk/chains";
import { MarketStatus, binaryModuleEventsAbi, discoverMarketsFromLogs, observedEventsAbi, readMarketRecord, readMarketStatuses, scanLogs } from "@relay/core";
import { iso, loadPhase1Env, nowSec } from "./_env.js";
import { loadState } from "./_pick.js";

const adapterAbi = parseAbi([
  "function pullNumericAnswer(uint256 oracleQuestionId) view returns (int256 numericValue, bool voided)",
  "function PRICE_DECIMALS() view returns (uint256)",
  "function pullAnswer(uint256 oracleQuestionId) view returns (uint8 outcomeIdx, bool voided)",
]);
const UNRESOLVED_BIND_TOPIC = "0xa304dae09530a82263c62fe0cfe08a427eb09e5dbf7506fbd3c4b19fdc76490e";

function fmtAnswer(v: bigint, dp: number): string {
  return `${formatUnits(v, dp)} (raw ${v}, ${dp} dp)`;
}

async function main(): Promise<void> {
  const env = loadPhase1Env();
  const pc = env.publicClient;

  // ── 1. live underlying prices from the SDK's testnet price feed ──
  const ex = new SomniaMarkets({
    indexerUrl: env.indexerUrl,
    chain: somniaShannon,
    wsRpcUrl: env.wsRpcUrl,
    addresses: SOMNIA_TESTNET_ADDRESSES,
    priceFeed: SOMNIA_TESTNET_PRICE_FEED,
  });
  console.log(`price feed ${SOMNIA_TESTNET_PRICE_FEED.url} (quote ${SOMNIA_TESTNET_PRICE_FEED.quote})`);
  for (const asset of ["BTC", "ETH"]) {
    try {
      const p = await ex.fetchPrice(asset);
      if (!p) {
        console.log(`  ${asset}: no price`);
        continue;
      }
      const info = p.info as { blockNumber?: number; blockTimestamp?: number };
      console.log(`  ${asset}  price ${p.price}  ema ${p.ema}  at ${p.datetime} (block ${info.blockNumber ?? "?"}) · local now ${iso(nowSec())} · age ${(nowSec() - Math.floor(p.timestamp / 1000)).toFixed(0)}s`);
    } catch (e) {
      console.log(`  ${asset}: fetchPrice failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }

  // ── 2. where does a reference-mode market's OPENING price live? ──
  const st = loadState();
  let marketId = st.market?.marketId as Hex | undefined;
  let asset = st.market?.asset;
  let tradingStart = st.market?.tradingStart;
  let expiry = st.market?.expiry;
  if (!marketId) {
    // fall back to the most recent Resolved reference-mode market on our venue
    const head = await pc.getBlockNumber();
    const ms = await discoverMarketsFromLogs({ client: pc, binaryModule: env.addresses.binaryModule, fromBlock: head - 20_000n, toBlock: head, concurrency: 8 });
    const cand = ms.filter((m) => m.venueId.toLowerCase() === env.venueId && m.strike === 0n && m.expiry < nowSec());
    const sts = await readMarketStatuses(pc, cand.map((m) => m.market));
    const r = cand.filter((_, i) => sts[i] === MarketStatus.Resolved).at(-1);
    if (!r) throw new Error("no resolved reference-mode market found to investigate");
    marketId = r.marketId;
    asset = r.asset;
    tradingStart = r.tradingStart;
    expiry = r.expiry;
  }
  console.log(`\nreference-price investigation for market ${marketId} (${asset}, open ${iso(tradingStart!)} → expiry ${iso(expiry!)})`);
  const rec = (await readMarketRecord(pc, env.addresses.binaryModule, marketId))!;
  console.log(`  module.markets(): oracleQuestionId=${rec.oracleQuestionId} oracleAdapter=${rec.oracleAdapter}`);
  console.log(`  oracleHub (deployment)      ${env.addresses.oracleHub}${rec.oracleAdapter.toLowerCase() === env.addresses.oracleHub.toLowerCase() ? "  ← adapter IS the hub" : "  (adapter is a different contract)"}`);

  // 2a. the market's OWN question answer on chain (closing price once resolved)
  const readAnswer = async (adapter: Address, qid: bigint, label: string) => {
    const dp = await pc.readContract({ address: adapter, abi: adapterAbi, functionName: "PRICE_DECIMALS" }).then(Number).catch(() => null);
    try {
      const [v, voided] = await pc.readContract({ address: adapter, abi: adapterAbi, functionName: "pullNumericAnswer", args: [qid] });
      console.log(`  ${label}: pullNumericAnswer(${qid}) = ${dp !== null ? fmtAnswer(v, dp) : `raw ${v} (no PRICE_DECIMALS getter; hub answers are 2 dp)`} voided=${voided}`);
      return { v, dp };
    } catch (e) {
      console.log(`  ${label}: pullNumericAnswer(${qid}) reverted — not answered yet (${((e as Error).message.split("\n")[0] ?? "").slice(0, 80)})`);
      return null;
    }
  };
  await readAnswer(rec.oracleAdapter, rec.oracleQuestionId, "closing (market's own question)");

  // 2b. indexer: MarketReferenceLink → referenceQuestionId, opening/closing answers
  let refQid: bigint | null = null;
  try {
    const r = await ex.client.getMarketResolution(marketId);
    refQid = r.reference?.oracleQuestionId ? BigInt(r.reference.oracleQuestionId) : null;
    console.log(`  indexer getMarketResolution: reference.oracleQuestionId=${r.reference?.oracleQuestionId ?? "null"} pending=${(r.reference as { pending?: boolean } | null)?.pending ?? "?"}`);
    console.log(`    openingAnswer  ${r.openingAnswer ? `numericValue=${r.openingAnswer.numericValue} resolvedAt=${r.openingAnswer.resolvedAt}` : "null"}`);
    console.log(`    closingAnswer  ${r.closingAnswer ? `numericValue=${r.closingAnswer.numericValue} resolvedAt=${r.closingAnswer.resolvedAt}` : "null"}`);
    console.log(`    resolution events ${r.events.length}: ${r.events.map((e) => `${e.kind}@${e.timestamp}`).join(", ") || "none"}`);
  } catch (e) {
    console.log(`  indexer getMarketResolution failed: ${(e as Error).message.split("\n")[0]}`);
  }

  // 2c. on chain: the module's unidentified binding event (topic 0xa304…) for THIS market
  const head = await pc.getBlockNumber();
  const from = head - 60_000n;
  const topic1 = pad(marketId, { size: 32 });
  let bindX: bigint | null = null;
  for (let f = from; f <= head && bindX === null; f += 1000n) {
    const t = f + 999n < head ? f + 999n : head;
    const logs = (await pc.request({
      method: "eth_getLogs",
      params: [{ address: env.addresses.binaryModule, fromBlock: toHex(f), toBlock: toHex(t), topics: [UNRESOLVED_BIND_TOPIC, topic1] }],
    } as never)) as { topics: Hex[]; blockNumber: Hex }[];
    if (logs.length > 0) {
      bindX = BigInt(logs[0]!.topics[2]!);
      console.log(`  module log 0xa304… for this market: topic2 = ${bindX} (block ${Number(logs[0]!.blockNumber)})`);
    }
  }
  if (bindX === null) console.log(`  module log 0xa304… for this market: none in the last 60k blocks`);

  // 2d. the reference question's answer on chain = the OPENING price
  const openQid = refQid ?? bindX;
  if (openQid !== null) {
    const same = refQid !== null && bindX !== null ? (refQid === bindX ? "— matches the 0xa304 topic2 ✓" : `— DIFFERS from 0xa304 topic2 ${bindX}`) : "";
    console.log(`  opening question id ${openQid} ${same}`);
    const adapters = [...new Set([rec.oracleAdapter.toLowerCase(), env.addresses.oracleHub.toLowerCase()])] as Address[];
    for (const ad of adapters) await readAnswer(ad, openQid, `opening via ${ad}`);
  }

  // 2e. MarketResolved payload (module) for this market
  try {
    const logs = await scanLogs({ client: pc, address: env.addresses.binaryModule, events: [observedEventsAbi[1]] as const, fromBlock: from, toBlock: head, concurrency: 8 });
    const mine = logs.find((l) => String((l.args as { marketId?: string }).marketId ?? "").toLowerCase() === marketId!.toLowerCase());
    if (mine) {
      const a = mine.args as { oracleQuestionId: bigint; payoutDenominator: number; payoutNumerators: readonly bigint[]; voided: boolean };
      console.log(`  MarketResolved(module): oracleQuestionId=${a.oracleQuestionId} payout=[${a.payoutNumerators.join(",")}]/${a.payoutDenominator} voided=${a.voided} — carries NO price`);
    } else console.log(`  MarketResolved(module): not yet emitted for this market`);
  } catch (e) {
    console.log(`  MarketResolved scan failed: ${(e as Error).message.split("\n")[0]}`);
  }
  void binaryModuleEventsAbi;

  // 2f. price-feed history around the open
  if (asset && tradingStart) {
    try {
      const pts = (await ex.client.fetchPriceHistory(asset, { from: tradingStart - 30, to: tradingStart + 30, limit: 20 })) as unknown as Record<string, unknown>[];
      const tsOf = (p: Record<string, unknown>) => Number(p.blockTimestamp ?? p.timestamp ?? 0);
      const sorted = [...pts].sort((a, b) => tsOf(a) - tsOf(b));
      const first = sorted[0];
      console.log(`  price-feed ticks within ±30s of open (${sorted.length})${first ? ` — fields: ${Object.keys(first).join(",")}` : ""}:`);
      for (const q of sorted.slice(0, 8)) {
        const ts = tsOf(q);
        console.log(`    ${ts > 1e12 ? iso(Math.floor(ts / 1000)) : iso(ts)}  price ${String(q.price)}  ema ${String(q.ema)}`);
      }
    } catch (e) {
      console.log(`  price-feed history failed: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  await Promise.race([Promise.resolve(ex.close()), new Promise((r) => setTimeout(r, 1500))]).catch(() => undefined);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
