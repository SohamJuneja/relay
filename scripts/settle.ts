// Phase 1 · Step 5 — wait for the traded market to resolve, then redeem.
//
//   pnpm settle

import { formatUnits } from "viem";
import { contractErrorsAbi } from "@somnia-chain/markets-sdk";
import { marketStatusLabel, redeemIfWinner, waitForResolution } from "@relay/core";
import { iso, loadPhase1Env, nowSec, txUrl } from "./_env.js";
import { loadState, saveState } from "./_pick.js";

async function main(): Promise<void> {
  const env = loadPhase1Env();
  const { publicClient: pc, walletClient: wc, account, addresses, decimals } = env;
  const st = loadState();
  if (!st.market) throw new Error("no market in artifacts/phase1.json — run `pnpm trade` first");
  const m = st.market;
  console.log(`address ${account.address}`);
  console.log(`market ${m.marketId} ${m.asset} ${m.intervalSec}s · expiry ${iso(m.expiry)} (${m.expiry - nowSec()}s) · operator ${m.operatorId} venue ${m.venueId}`);
  console.log(`polling status() every 5s …`);

  const res = await waitForResolution({
    publicClient: pc,
    binaryModule: addresses.binaryModule,
    marketId: m.marketId,
    pollMs: 5_000,
    timeoutMs: 40 * 60_000,
    onTransition: (t) => console.log(`  ${iso(t.atSec)}  block ${t.blockNumber}  → ${marketStatusLabel(t.status)}`),
  });
  console.log(`final status ${marketStatusLabel(res.finalStatus)} · isResolved ${res.isResolved} · isVoided ${res.isVoided}${res.timedOut ? " · TIMED OUT" : ""}`);
  console.log(`payoutNumerators [${res.payoutNumerators.join(", ")}] → winning outcome ${res.winningOutcome === null ? "none (void/unresolved)" : res.winningOutcome === 0 ? "0 = YES/UP" : "1 = NO/DOWN"}`);
  if (res.timedOut) process.exit(2);

  const out = await redeemIfWinner({
    publicClient: pc,
    walletClient: wc,
    account,
    binaryModule: addresses.binaryModule,
    marketId: m.marketId,
    operatorId: m.operatorId,
    venueId: m.venueId,
    extraErrorsAbi: contractErrorsAbi,
    log: (s) => console.log(`  · ${s}`),
  });
  console.log(`held: YES ${formatUnits(out.held.yes, decimals)} · NO ${formatUnits(out.held.no, decimals)}`);
  switch (out.action) {
    case "redeemed":
      for (const r of out.redeemed) {
        console.log(`redeemed outcome ${r.outcomeIdx} amount ${formatUnits(r.amount, decimals)} · tx ${r.hash} · gasUsed ${r.gasUsed}\n  ${txUrl(env.explorer, r.hash)}`);
      }
      if (out.operatorHash) console.log(`(setOperator(module) tx ${out.operatorHash})`);
      if (out.finalizeHash) console.log(`(finalizeMarket tx ${out.finalizeHash})`);
      console.log(`tUSDC ${formatUnits(out.collateralBefore, decimals)} → ${formatUnits(out.collateralAfter, decimals)} (+${formatUnits(out.collateralAfter - out.collateralBefore, decimals)})`);
      break;
    case "held-losing-side":
      console.log(`held the LOSING side — position is worth 0. tUSDC unchanged at ${formatUnits(out.collateralAfter, decimals)}. (Lifecycle complete: trade → expiry → resolution → no claim.)`);
      break;
    case "nothing-held":
      console.log("nothing held on this market — nothing to redeem.");
      break;
    case "not-settled":
      console.log("market not settled yet — re-run later.");
      break;
  }
  st.settlement = {
    finalStatus: res.finalStatus,
    transitions: res.transitions.map((t) => ({ status: t.status, name: t.name, at: iso(t.atSec), block: t.blockNumber.toString() })),
    payoutNumerators: res.payoutNumerators.map(String),
    winningOutcome: res.winningOutcome,
    action: out.action,
    redeemTxs: out.redeemed.map((r) => r.hash),
    collateralBefore: out.collateralBefore.toString(),
    collateralAfter: out.collateralAfter.toString(),
  };
  saveState(st);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
