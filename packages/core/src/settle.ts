// Settlement: wait for a market to resolve (polling the chain, never the
// indexer) and redeem the winning side through the BinaryMarketsModule.
//
//   - status(): Trading(1) → Locked(2) → Settling(3) → Resolved(4) | Voided(5)
//   - payoutNumerators(): index 0 = YES/UP; one-hot on resolve, equal on void
//   - redeem(operatorId, venueId, marketId, outcomeIdx, amount) on the MODULE,
//     which pulls the outcome tokens → needs outcomeToken.setOperator(module, true)
//     once (kit gotcha #19). The module finalizes on demand; if it insists on
//     an explicit finalizeMarket we send that first.

import type { Abi, Account, Address, Hex, PublicClient, WalletClient } from "viem";
import { binaryMarketReadAbi, binaryModuleWriteAbi, erc20Abi, outcomeToken6909Abi } from "./abi/index.js";
import { readMarketRecord } from "./discovery.js";
import { binaryErrorsAbi, explainRevert } from "./errors.js";
import { MarketStatus, marketStatusName } from "./status.js";
import { DEFAULT_TX_FEES, estimateGasWithFloor, sendContractWrite } from "./trade.js";

export interface StatusTransition {
  status: number;
  name: string;
  atSec: number;
  blockNumber: bigint;
}

export interface WaitForResolutionArgs {
  publicClient: PublicClient;
  binaryModule: Address;
  marketId: Hex;
  pollMs?: number;
  timeoutMs?: number;
  onTransition?: (t: StatusTransition) => void;
}

export interface ResolutionResult {
  marketAddress: Address;
  pool: Address;
  expiry: number;
  finalStatus: number;
  transitions: StatusTransition[];
  payoutNumerators: bigint[];
  isResolved: boolean;
  isVoided: boolean;
  /** argmax of payoutNumerators when resolved; null when voided/unresolved. */
  winningOutcome: 0 | 1 | null;
  timedOut: boolean;
}

export async function waitForResolution(a: WaitForResolutionArgs): Promise<ResolutionResult> {
  const pc = a.publicClient;
  const rec = await readMarketRecord(pc, a.binaryModule, a.marketId);
  if (!rec) throw new Error(`unknown marketId ${a.marketId}`);
  const m = { address: rec.market, abi: binaryMarketReadAbi } as const;
  const pollMs = a.pollMs ?? 5_000;
  const deadline = Date.now() + (a.timeoutMs ?? 30 * 60_000);
  const transitions: StatusTransition[] = [];
  let last: number | null = null;
  let timedOut = false;
  for (;;) {
    const [status, block] = await Promise.all([pc.readContract({ ...m, functionName: "status" }), pc.getBlockNumber()]);
    const s = Number(status);
    if (s !== last) {
      const t = { status: s, name: marketStatusName(s), atSec: Math.floor(Date.now() / 1000), blockNumber: block };
      transitions.push(t);
      a.onTransition?.(t);
      last = s;
    }
    if (s === MarketStatus.Resolved || s === MarketStatus.Voided) break;
    if (Date.now() > deadline) {
      timedOut = true;
      break;
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  const [payout, isResolved, isVoided] = await Promise.all([
    pc.readContract({ ...m, functionName: "payoutNumerators" }),
    pc.readContract({ ...m, functionName: "isResolved" }),
    pc.readContract({ ...m, functionName: "isVoided" }),
  ]);
  const vec = [...payout];
  let winningOutcome: 0 | 1 | null = null;
  if (isResolved && !isVoided && vec.length >= 2) winningOutcome = (vec[1]! > vec[0]! ? 1 : 0) as 0 | 1;
  return {
    marketAddress: rec.market,
    pool: rec.pool,
    expiry: rec.expiry,
    finalStatus: last ?? -1,
    transitions,
    payoutNumerators: vec,
    isResolved,
    isVoided,
    winningOutcome,
    timedOut,
  };
}

export interface RedeemIfWinnerArgs {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  binaryModule: Address;
  marketId: Hex;
  /** Attribution-only on the module; may be 0 / zero bytes32. Pass the market's own. */
  operatorId?: number;
  venueId?: Hex;
  extraErrorsAbi?: Abi;
  fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  log?: (s: string) => void;
}

export interface RedeemOutcome {
  action: "redeemed" | "held-losing-side" | "nothing-held" | "not-settled";
  winningOutcome: 0 | 1 | null;
  voided: boolean;
  payoutNumerators: bigint[];
  held: { yes: bigint; no: bigint };
  redeemed: { outcomeIdx: 0 | 1; amount: bigint; hash: Hex; gasUsed: bigint }[];
  operatorHash: Hex | null;
  finalizeHash: Hex | null;
  collateralBefore: bigint;
  collateralAfter: bigint;
}

export async function redeemIfWinner(a: RedeemIfWinnerArgs): Promise<RedeemOutcome> {
  const { publicClient: pc, walletClient: wc, account } = a;
  const log = a.log ?? (() => undefined);
  const fees = a.fees ?? DEFAULT_TX_FEES;
  const rec = await readMarketRecord(pc, a.binaryModule, a.marketId);
  if (!rec) throw new Error(`unknown marketId ${a.marketId}`);
  const m = { address: rec.market, abi: binaryMarketReadAbi } as const;
  const [outcomeToken, payout, isResolved, isVoided] = await Promise.all([
    pc.readContract({ ...m, functionName: "outcomeToken" }),
    pc.readContract({ ...m, functionName: "payoutNumerators" }),
    pc.readContract({ ...m, functionName: "isResolved" }),
    pc.readContract({ ...m, functionName: "isVoided" }),
  ]);
  const vec = [...payout];
  const balOf = (id: bigint) => pc.readContract({ address: outcomeToken, abi: outcomeToken6909Abi, functionName: "balanceOf", args: [account.address, id] });
  const collOf = () => pc.readContract({ address: rec.collateral, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  const [yes, no, collateralBefore] = await Promise.all([balOf(rec.yesId), balOf(rec.noId), collOf()]);
  const held = { yes, no };
  const base = { voided: isVoided, payoutNumerators: vec, held, redeemed: [] as RedeemOutcome["redeemed"], operatorHash: null as Hex | null, finalizeHash: null as Hex | null, collateralBefore };

  if (!isResolved && !isVoided) {
    return { ...base, action: "not-settled", winningOutcome: null, collateralAfter: collateralBefore };
  }
  const winningOutcome: 0 | 1 | null = isVoided ? null : ((vec[1] ?? 0n) > (vec[0] ?? 0n) ? 1 : 0);
  const claims: { outcomeIdx: 0 | 1; amount: bigint }[] = [];
  if (isVoided) {
    if (yes > 0n) claims.push({ outcomeIdx: 0, amount: yes });
    if (no > 0n) claims.push({ outcomeIdx: 1, amount: no });
  } else if (winningOutcome !== null) {
    const amt = winningOutcome === 0 ? yes : no;
    if (amt > 0n) claims.push({ outcomeIdx: winningOutcome, amount: amt });
  }
  if (claims.length === 0) {
    const action = yes + no > 0n ? "held-losing-side" : "nothing-held";
    return { ...base, action, winningOutcome, collateralAfter: collateralBefore };
  }

  // One-time ERC-6909 operator grant to the MODULE (it pulls the tokens).
  const isOp = await pc.readContract({ address: outcomeToken, abi: outcomeToken6909Abi, functionName: "isOperator", args: [account.address, a.binaryModule] });
  if (!isOp) {
    log(`granting ERC-6909 operator to module ${a.binaryModule} on ${outcomeToken}`);
    const opAbi: Abi = [...outcomeToken6909Abi, ...binaryErrorsAbi];
    await pc.simulateContract({ address: outcomeToken, abi: opAbi, functionName: "setOperator", args: [a.binaryModule, true], account });
    const opCall = { address: outcomeToken, abi: opAbi, functionName: "setOperator", args: [a.binaryModule, true] as const, account };
    base.operatorHash = await sendContractWrite(wc, { ...opCall, gas: await estimateGasWithFloor(pc, opCall, 1_000_000n), fees });
    const r = await pc.waitForTransactionReceipt({ hash: base.operatorHash });
    if (r.status !== "success") throw new Error(`setOperator reverted (tx ${base.operatorHash})`);
    log(`operator granted · tx ${base.operatorHash}`);
  }

  const errAbi: Abi = [...binaryModuleWriteAbi, ...binaryErrorsAbi, ...(a.extraErrorsAbi ?? [])];
  const operatorId = a.operatorId ?? rec.operatorId;
  const venueId = a.venueId ?? rec.venueId;
  for (const c of claims) {
    const args = [operatorId, venueId, a.marketId, c.outcomeIdx, c.amount] as const;
    try {
      await pc.simulateContract({ address: a.binaryModule, abi: errAbi, functionName: "redeem", args, account });
    } catch (e) {
      const r = explainRevert(e);
      if (r.name === "MarketNotFinalizedYet" || r.name === "MarketNotSettled") {
        log(`redeem needs finalizeMarket first (${r.name}); sending it`);
        await pc.simulateContract({ address: a.binaryModule, abi: errAbi, functionName: "finalizeMarket", args: [a.marketId], account });
        const finCall = { address: a.binaryModule, abi: errAbi, functionName: "finalizeMarket", args: [a.marketId] as const, account };
        base.finalizeHash = await sendContractWrite(wc, { ...finCall, gas: await estimateGasWithFloor(pc, finCall, 3_000_000n), fees });
        const fr = await pc.waitForTransactionReceipt({ hash: base.finalizeHash });
        if (fr.status !== "success") throw new Error(`finalizeMarket reverted (tx ${base.finalizeHash})`);
        await pc.simulateContract({ address: a.binaryModule, abi: errAbi, functionName: "redeem", args, account });
      } else {
        throw new Error(`redeem simulation reverted: ${r.name ?? r.selector ?? r.message}`);
      }
    }
    const gas = await estimateGasWithFloor(pc, { address: a.binaryModule, abi: errAbi, functionName: "redeem", args, account }, 3_000_000n);
    const hash = await sendContractWrite(wc, { address: a.binaryModule, abi: errAbi, functionName: "redeem", args, account, gas, fees });
    log(`redeem outcome ${c.outcomeIdx} amount ${c.amount} · sent ${hash}`);
    const r = await pc.waitForTransactionReceipt({ hash });
    if (r.status !== "success") throw new Error(`redeem reverted on chain (tx ${hash})`);
    base.redeemed.push({ outcomeIdx: c.outcomeIdx, amount: c.amount, hash, gasUsed: r.gasUsed });
  }
  const collateralAfter = await collOf();
  return { ...base, action: "redeemed", winningOutcome, collateralAfter };
}
