// Phase 1 · Step 4 — real IOC trade(s), verified from the chain.
//   A: builder = address(0), Relay userData          (always)
//   B: builder = PARTNER,    Relay userData, fee 0   (only if the matrix said accepted)
// One contract each. Prints hash, explorer URL, receipt, every decoded log, the
// decoded calldata (builder round-trip), and reconciles tUSDC + ERC-6909 balances.
//
//   pnpm trade

import { formatUnits, type Address, type Hex } from "viem";
import { contractErrorsAbi } from "@somnia-chain/markets-sdk";
import {
  SURFACE,
  ZERO_ADDRESS,
  decodePlaceBinaryOrderCalldata,
  encodeUserData,
  erc20Abi,
  formatUserData,
  outcomeToken6909Abi,
  placeTakerBuy,
  readMarketRecord,
  TradeRejected,
  type PlaceTakerBuyResult,
} from "@relay/core";
import { iso, loadPhase1Env, nowSec, txUrl } from "./_env.js";
import { loadState, pickTradingMarket, saveState, stateFromPick } from "./_pick.js";

const RELAY_PARTNER_ID = 1;

function printResult(env: ReturnType<typeof loadPhase1Env>, label: string, r: PlaceTakerBuyResult): void {
  const d = env.decimals;
  console.log(`\n[${label}] tx ${r.hash}`);
  console.log(`  ${txUrl(env.explorer, r.hash)}`);
  console.log(`  receipt.status ${r.status} · gasUsed ${r.gasUsed} · block ${r.blockNumber}`);
  console.log(`  sent: kind ${r.kind} (${r.outcome}) priceYes ${formatUnits(r.priceYes, d)} priceOwn ${formatUnits(r.priceOwn, d)} qty ${formatUnits(r.qty, d)} expireNs ${r.expireTimestampNs}`);
  console.log(`  simulation said success=${r.simulated.success} orderId=${r.simulated.orderId}`);
  console.log(`  logs (${r.logs.length}):`);
  for (const l of r.logs) {
    const args = l.args ? JSON.stringify(l.args, (_, v) => (typeof v === "bigint" ? v.toString() : v)) : "";
    console.log(`    ${(l.eventName ?? "UNKNOWN").padEnd(20)} @${l.address}  ${args.slice(0, 220)}${l.eventName ? "" : `  topic0=${l.topic0}`}`);
  }
  console.log(`  OrderPlaced: orderId=${r.orderId} owner=${r.ownerOnChain} userData=${r.userDataOnChain} → ${r.userDataOnChain !== null ? formatUserData(r.userDataOnChain) : "n/a"}`);
  console.log(`  BinaryOrderPlaced.kind=${r.kindOnChain}`);
  for (const f of r.fills) {
    console.log(`  OrderFilled: taker ${f.takerOrderId} × maker ${f.makerOrderId}  qty ${formatUnits(f.quantityFilled, d)}  fillPrice(YES) ${formatUnits(f.fillPrice, d)}`);
  }
  for (const p of r.protocolFees) {
    console.log(`  ProtocolFeeCharged: orderId ${p.orderId} payer ${p.payer} token ${p.token} amount ${p.amount} isTakerSide ${p.isTakerSide}`);
  }
  console.log(`  filled ${formatUnits(r.filled, d)} @ avg own-price ${r.fillPriceOwn !== null ? formatUnits(r.fillPriceOwn, d) : "—"} → spent ${formatUnits(r.spentCollateral, d)} tUSDC`);
  console.log(`  BuilderFeeCharged seen? ${r.logs.some((l) => l.eventName === "BuilderFeeCharged") ? "YES" : "no"} · unknown topic0s: ${r.unknownTopics.length ? r.unknownTopics.join(", ") : "none"}`);
}

async function main(): Promise<void> {
  const env = loadPhase1Env();
  const { publicClient: pc, walletClient: wc, account, addresses, one, decimals } = env;
  console.log(`address ${account.address} · venue ${env.venueId}`);

  // Same market as the matrix if it still has time; else re-pick.
  const st = loadState();
  let market = st.market;
  if (!market || market.expiry - nowSec() < 60) {
    console.log(market ? `saved market has ${market.expiry - nowSec()}s left — re-picking` : "no saved market — picking");
    const pick = await pickTradingMarket(env, { minLeftSec: 60, preferIntervals: [300, 900] });
    market = stateFromPick(pick);
    st.market = market;
    saveState(st);
  }
  console.log(`market ${market.marketId} ${market.asset} ${market.intervalSec}s · pool ${market.pool} · expires ${iso(market.expiry)} (${market.expiry - nowSec()}s left)`);

  const rec = await readMarketRecord(pc, addresses.binaryModule, market.marketId);
  if (!rec) throw new Error("market vanished from the module?!");
  const outcomeToken = (await pc.readContract({ address: market.pool, abi: [{ type: "function", name: "outcomeToken", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const, functionName: "outcomeToken" })) as Address;
  const bal = () => pc.readContract({ address: addresses.collateral, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  const bal6909 = (id: bigint) => pc.readContract({ address: outcomeToken, abi: outcomeToken6909Abi, functionName: "balanceOf", args: [account.address, id] });

  const before = await bal();
  const [yesBefore, noBefore] = await Promise.all([bal6909(rec.yesId), bal6909(rec.noId)]);
  console.log(`\ntUSDC before ${formatUnits(before, decimals)} · YES ${formatUnits(yesBefore, decimals)} · NO ${formatUnits(noBefore, decimals)}`);

  const userData = encodeUserData({ partnerId: RELAY_PARTNER_ID, surfaceId: SURFACE.WEB });
  const common = {
    publicClient: pc,
    walletClient: wc,
    account,
    binaryModule: addresses.binaryModule,
    marketId: market.marketId,
    outcome: "UP" as const,
    budgetCollateral: 2n * one,
    maxPrice: one - 1n, // any price < 1.0; we buy at the best ask
    quantity: 1n * one, // one contract
    expireInSec: 45,
    extraErrorsAbi: contractErrorsAbi,
    log: (s: string) => console.log(`  · ${s}`),
  };

  const trades: NonNullable<typeof st.trades> = [];
  const results: { label: string; r: PlaceTakerBuyResult }[] = [];

  // TRADE_MODE=hedge → A buys UP and B buys DOWN (one contract each) so one side is
  // guaranteed to win and `pnpm settle` exercises the real redeem path.
  const hedge = (process.env.TRADE_MODE ?? "").toLowerCase() === "hedge";
  const bOutcome: "UP" | "DOWN" = hedge ? "DOWN" : "UP";

  console.log("\n── variant A: builder=address(0), Relay userData, UP ──");
  const rA = await placeTakerBuy({ ...common, partner: { userData } });
  printResult(env, "A", rA);
  results.push({ label: "A", r: rA });
  trades.push({ variant: "A", hash: rA.hash, outcome: "UP", qty: rA.qty.toString(), filled: rA.filled.toString(), fillPriceOwn: rA.fillPriceOwn?.toString() ?? null, userData: userData.toString(), builder: ZERO_ADDRESS });

  const bAccepted = (st.matrix?.B ?? "").startsWith("OK success=true") || (st.matrix?.C ?? "").startsWith("OK success=true");
  if (bAccepted && st.partner?.builder) {
    console.log(`\n── variant B: builder=PARTNER ${st.partner.builder}, fee 0, Relay userData, ${bOutcome} ──`);
    try {
      const rB = await placeTakerBuy({ ...common, outcome: bOutcome, partner: { builder: st.partner.builder, builderFeeBpsTimes1k: 0n, userData } });
      printResult(env, "B", rB);
      results.push({ label: "B", r: rB });
      trades.push({ variant: "B", hash: rB.hash, outcome: bOutcome, qty: rB.qty.toString(), filled: rB.filled.toString(), fillPriceOwn: rB.fillPriceOwn?.toString() ?? null, userData: userData.toString(), builder: st.partner.builder });
    } catch (e) {
      if (e instanceof TradeRejected) console.log(`  variant B rejected: ${e.message}`);
      else throw e;
    }
  } else {
    console.log(`\n── variant B skipped: matrix says B/C not accepted (${st.matrix?.B ?? "no matrix run"}) ──`);
  }

  // Calldata round-trip: fetch each tx and decode arg 7 (builder).
  console.log("\ncalldata round-trip (eth_getTransactionByHash → decodeFunctionData):");
  for (const { label, r } of results) {
    const tx = await pc.getTransaction({ hash: r.hash });
    const d = decodePlaceBinaryOrderCalldata(tx.input as Hex);
    console.log(`  [${label}] to=${tx.to} builder=${d?.builder} fee=${d?.builderFeeBpsTimes1k} userData=${d?.userData} kind=${d?.kind} price=${d?.price} qty=${d?.quantity} orderType=${d?.orderType} → ${d && d.userData === userData ? "userData matches" : "MISMATCH"}${d && label === "B" && st.partner && d.builder.toLowerCase() === st.partner.builder.toLowerCase() ? ", builder matches PARTNER" : ""}`);
  }

  // Reconciliation.
  const after = await bal();
  const [yesAfter, noAfter] = await Promise.all([bal6909(rec.yesId), bal6909(rec.noId)]);
  const spent = results.reduce((s, x) => s + x.r.spentCollateral, 0n);
  const filledUp = results.filter((x) => x.r.outcome === "UP").reduce((s, x) => s + x.r.filled, 0n);
  const filledDown = results.filter((x) => x.r.outcome === "DOWN").reduce((s, x) => s + x.r.filled, 0n);
  console.log(`\nreconciliation`);
  console.log(`  tUSDC before ${formatUnits(before, decimals)} → after ${formatUnits(after, decimals)} · Δ ${formatUnits(before - after, decimals)}`);
  console.log(`  Σ fillPrice×qty (own terms, ceil) = ${formatUnits(spent, decimals)} · fees charged: ${results.flatMap((x) => x.r.protocolFees).reduce((s, p) => s + p.amount, 0n)} raw`);
  console.log(`  YES 6909 ${formatUnits(yesBefore, decimals)} → ${formatUnits(yesAfter, decimals)} (Δ ${formatUnits(yesAfter - yesBefore, decimals)}) · NO ${formatUnits(noBefore, decimals)} → ${formatUnits(noAfter, decimals)} (Δ ${formatUnits(noAfter - noBefore, decimals)})`);
  const ok = before - after === spent && yesAfter - yesBefore === filledUp && noAfter - noBefore === filledDown;
  console.log(`  ${ok ? "RECONCILED to the unit ✓" : "MISMATCH ✗ — investigate escrow/refund (IOC remainder or fee)"}`);

  st.trades = trades;
  st.balances = { tusdcBefore: before.toString(), tusdcAfter: after.toString(), yesAfter: yesAfter.toString(), noAfter: noAfter.toString() };
  saveState(st);
  console.log("\nsaved artifacts/phase1.json — run `pnpm settle` after expiry.");
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
