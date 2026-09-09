// The signed taker path: buy UP (YES) or DOWN (NO) on a market with an IOC order,
// tagged with the partner's builder code + Relay userData. Chain-only: market
// record from the module, book from the pool, status from the market clone.
//
// Encoding recap (PROTOCOL_NOTES §3, §6):
//   - every order is priced on the YES side. Buying DOWN = kind BUY_NO at YES
//     price y, paying (one − y) per NO; it crosses YES BIDS at ≥ y.
//   - quantity/price are collateral-decimal scaled; snap to the pool grid.
//   - expireTimestampNs is nanoseconds and must be ≤ marketExpiryNs().
//   - a buy escrows collateral straight from the wallet → the POOL needs an
//     ERC-20 allowance first (the SDK's own writer does the same approve).
//   - success=false does not revert: we simulate first and require OrderPlaced.

import { decodeFunctionData, parseEventLogs, type Abi, type Account, type Address, type Hex, type PublicClient, type TransactionReceipt, type WalletClient } from "viem";
import { allKnownEvents, binaryMarketReadAbi, binaryPoolReadAbi, binaryPoolWriteAbi, erc20Abi, eventNameForTopic } from "./abi/index.js";
import { decodeUserData, type DecodedUserData } from "./attribution.js";
import { readYesBooks } from "./book.js";
import { readMarketRecord } from "./discovery.js";
import { buildTakerOrder } from "./order.js";
import { binaryErrorsAbi, explainRevert } from "./errors.js";
import { MarketStatus, marketStatusLabel } from "./status.js";

/** SDK DEFAULT_FEES: Somnia accepts a 0 tip; 60 gwei ceiling. */
export const DEFAULT_TX_FEES = { maxFeePerGas: 60_000_000_000n, maxPriorityFeePerGas: 0n } as const;
/** Somnia gas is dear (the SDK notes an ERC-20 approve OOG'd under 1M); never send an order under this. */
export const MIN_ORDER_GAS = 2_000_000n;

export interface PartnerTag {
  /** Partner builder code (an address). Omit / zero = untagged on the fee channel. */
  builder?: Address;
  /** bps × 1000; must be ≤ pool cap and ≤ the user's approveBuilder cap. Default 0. */
  builderFeeBpsTimes1k?: bigint;
  /** Relay attribution tag — see attribution.ts encodeUserData. */
  userData: bigint;
}

export interface PlaceTakerBuyArgs {
  publicClient: PublicClient;
  walletClient: WalletClient;
  account: Account;
  binaryModule: Address;
  marketId: Hex;
  outcome: "UP" | "DOWN";
  /** Raw collateral to spend (used to size the order unless `quantity` is given). */
  budgetCollateral: bigint;
  /** Max price to pay, raw, in the OUTCOME's own terms (UP: YES price; DOWN: NO price). */
  maxPrice: bigint;
  partner: PartnerTag;
  /** Order lifetime; capped at the market's own expiry. Default 45 s. */
  expireInSec?: number;
  /** Explicit quantity (raw outcome tokens) — overrides the budget sizing. */
  quantity?: bigint;
  /** Approve the pool for collateral if the allowance is short (sends a tx). Default true. */
  autoApprove?: boolean;
  /** Extra error ABI (e.g. the SDK's contractErrorsAbi) for revert decoding. */
  extraErrorsAbi?: Abi;
  fees?: { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint };
  gasLimit?: bigint;
  /** Simulate everything but send nothing. */
  dryRun?: boolean;
  /**
   * Ticks to price THROUGH the touch (kit gotcha #9: the touch moves between the
   * read and the send; the taker still pays the maker's resting price). Default 5.
   */
  crossTicks?: bigint;
  /** Retries on ImmediateOrCancelNoFill with a fresh book read. Default 2. */
  retries?: number;
  log?: (s: string) => void;
}

export interface TakerFill {
  takerOrderId: bigint;
  makerOrderId: bigint;
  quantityFilled: bigint;
  /** YES-terms fill price (raw). */
  fillPrice: bigint;
}

export interface ProtocolFeeLog {
  orderId: bigint;
  payer: Address;
  token: Address;
  amount: bigint;
  isTakerSide: boolean;
}

export interface DecodedReceiptLog {
  address: Address;
  eventName: string | null;
  topic0: Hex;
  args: Record<string, unknown> | null;
}

export interface PlaceTakerBuyResult {
  hash: Hex;
  status: "success" | "reverted";
  gasUsed: bigint;
  blockNumber: bigint;
  pool: Address;
  market: Address;
  outcome: "UP" | "DOWN";
  kind: number;
  /** Price sent to the pool (YES terms) and the same in the outcome's own terms. */
  priceYes: bigint;
  priceOwn: bigint;
  qty: bigint;
  expireTimestampNs: bigint;
  /** From the simulation (eth_call) — the receipt has no return data. */
  simulated: { success: boolean; orderId: bigint };
  /** From the OrderPlaced log. */
  orderId: bigint | null;
  ownerOnChain: Address | null;
  userDataOnChain: bigint | null;
  tag: DecodedUserData;
  kindOnChain: number | null;
  fills: TakerFill[];
  filled: bigint;
  /** Volume-weighted average fill price, in the outcome's own terms; null if nothing filled. */
  fillPriceOwn: bigint | null;
  /** Collateral actually spent = Σ priceOwn(fill) × qty / one. */
  spentCollateral: bigint;
  protocolFees: ProtocolFeeLog[];
  /** topic0s in the receipt not covered by any ABI we know. */
  unknownTopics: Hex[];
  logs: DecodedReceiptLog[];
  approvalHash: Hex | null;
  receipt: TransactionReceipt;
}

/** IOC orders are instantaneous; refuse only a window about to close. */
export function takerHeadroomSec(windowSec: number): number {
  return Math.max(15, Math.min(60, Math.round(windowSec * 0.2)));
}

export interface TxFees {
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

/**
 * Send a contract write with explicit gas + fees. Spreading `simulateContract`'s
 * request and adding fee fields trips viem's transaction-type union, so writes
 * are re-specified here from the same (address, abi, functionName, args).
 */
export async function sendContractWrite(
  wc: WalletClient,
  p: { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; account: Account; gas: bigint; fees?: TxFees; value?: bigint },
): Promise<Hex> {
  const fees = p.fees ?? DEFAULT_TX_FEES;
  const params = {
    address: p.address,
    abi: p.abi,
    functionName: p.functionName,
    args: p.args,
    account: p.account,
    chain: wc.chain,
    gas: p.gas,
    maxFeePerGas: fees.maxFeePerGas,
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    ...(p.value !== undefined ? { value: p.value } : {}),
  };
  return wc.writeContract(params as unknown as Parameters<WalletClient["writeContract"]>[0]);
}

/**
 * Gas limit for a write: 2 × eth_estimateGas, never below `floor`. Somnia's
 * schedule is dear (an ERC-20 faucet call burned a 300k limit; the SDK pins
 * 10M), and eth_call simulations do not catch out-of-gas.
 */
export async function estimateGasWithFloor(
  pc: PublicClient,
  p: { address: Address; abi: Abi; functionName: string; args: readonly unknown[]; account: Account },
  floor: bigint,
): Promise<bigint> {
  const est = await pc.estimateContractGas(p as unknown as Parameters<PublicClient["estimateContractGas"]>[0]).catch(() => 0n);
  const doubled = est * 2n;
  return doubled > floor ? doubled : floor;
}

export class TradeRejected extends Error {
  constructor(
    message: string,
    public readonly revert?: ReturnType<typeof explainRevert>,
  ) {
    super(message);
    this.name = "TradeRejected";
  }
}

export async function placeTakerBuy(a: PlaceTakerBuyArgs): Promise<PlaceTakerBuyResult> {
  const retries = a.retries ?? 2;
  for (let attempt = 0; ; attempt++) {
    try {
      return await placeTakerBuyOnce(a);
    } catch (e) {
      if (e instanceof TradeRejected && e.revert?.name === "ImmediateOrCancelNoFill" && attempt < retries) {
        a.log?.(`IOC found nothing to cross (touch moved) — re-reading the book, retry ${attempt + 1}/${retries}`);
        await new Promise((r) => setTimeout(r, 400));
        continue;
      }
      throw e;
    }
  }
}

async function placeTakerBuyOnce(a: PlaceTakerBuyArgs): Promise<PlaceTakerBuyResult> {
  const { publicClient: pc, walletClient: wc, account } = a;
  const log = a.log ?? (() => undefined);
  const fees = a.fees ?? DEFAULT_TX_FEES;
  const errAbi: Abi = [...binaryPoolWriteAbi, ...binaryErrorsAbi, ...(a.extraErrorsAbi ?? [])];

  // 1. Market wiring from the module (works with the indexer down).
  const rec = await readMarketRecord(pc, a.binaryModule, a.marketId);
  if (!rec) throw new TradeRejected(`unknown marketId ${a.marketId} on module ${a.binaryModule}`);
  const { pool, market } = rec;

  // 2. Authoritative status + time left.
  const [status, marketExpiryNs, bookParams, decimals] = await Promise.all([
    pc.readContract({ address: market, abi: binaryMarketReadAbi, functionName: "status" }),
    pc.readContract({ address: pool, abi: binaryPoolReadAbi, functionName: "marketExpiryNs" }),
    pc.readContract({ address: pool, abi: binaryPoolReadAbi, functionName: "getOrderBookParameters" }),
    pc.readContract({ address: rec.collateral, abi: erc20Abi, functionName: "decimals" }),
  ]);
  if (Number(status) !== MarketStatus.Trading) {
    throw new TradeRejected(`market ${a.marketId} is ${marketStatusLabel(status)}, not Trading`);
  }
  const one = 10n ** BigInt(decimals);
  const nowSec = Math.floor(Date.now() / 1000);
  const windowSec = rec.expiry - rec.tradingStart;
  const left = rec.expiry - nowSec;
  const headroom = takerHeadroomSec(windowSec);
  if (left < headroom) throw new TradeRejected(`only ${left}s left in a ${windowSec}s window (need ≥ ${headroom}s)`);

  // 3 + 4. Book → the order, via the SAME pure builder the browser widget uses,
  // so a widget preview and a Node send produce byte-identical args.
  const [book] = await readYesBooks(pc, [pool], 10);
  if (!book || "error" in book) throw new TradeRejected(`getBookLevels failed: ${book && "error" in book ? book.error : "no result"}`);
  const quote = buildTakerOrder({
    outcome: a.outcome,
    yesBids: book.yesBids,
    yesAsks: book.yesAsks,
    one,
    grid: bookParams,
    budget: a.budgetCollateral,
    quantity: a.quantity,
    crossTicks: a.crossTicks,
    maxPrice: a.maxPrice,
    partner: a.partner,
    nowSec,
    expireInSec: a.expireInSec,
    marketExpiryNs,
  });
  if (!quote.ok) throw new TradeRejected(quote.reason ?? "order could not be built");
  const kind = quote.kind;
  const priceYes = quote.limitYes;
  const limitOwn = quote.limitOwn;
  const touchOwn = quote.touchOwn ?? limitOwn;
  const qty = quote.qty;
  const need = quote.escrow; // the pool escrows at the limit and refunds the difference

  // 5. Local funds check (kit sharp edge #7): gas + collateral before signing.
  const [gasBal, collBal, allowance] = await Promise.all([
    pc.getBalance({ address: account.address }),
    pc.readContract({ address: rec.collateral, abi: erc20Abi, functionName: "balanceOf", args: [account.address] }),
    pc.readContract({ address: rec.collateral, abi: erc20Abi, functionName: "allowance", args: [account.address, pool] }),
  ]);
  if (gasBal === 0n) throw new TradeRejected(`out of gas: ${account.address} holds 0 native token`);
  if (collBal < need) throw new TradeRejected(`not enough collateral: have ${collBal}, need ${need} (raw)`);

  // 6. Allowance to the POOL.
  let approvalHash: Hex | null = null;
  if (allowance < need) {
    if (a.autoApprove === false) throw new TradeRejected(`pool allowance ${allowance} < ${need}; autoApprove is off`);
    const approveAmount = need * 100n > 1_000n * one ? need * 100n : 1_000n * one; // bounded, testnet-sized
    log(`approving pool ${pool} for ${approveAmount} raw collateral (allowance ${allowance} < ${need})`);
    if (!a.dryRun) {
      const approveAbi: Abi = [...erc20Abi, ...binaryErrorsAbi];
      await pc.simulateContract({ address: rec.collateral, abi: approveAbi, functionName: "approve", args: [pool, approveAmount], account });
      const approveCall = { address: rec.collateral, abi: approveAbi, functionName: "approve", args: [pool, approveAmount] as const, account };
      approvalHash = await sendContractWrite(wc, { ...approveCall, gas: await estimateGasWithFloor(pc, approveCall, 1_000_000n), fees });
      const r = await pc.waitForTransactionReceipt({ hash: approvalHash });
      if (r.status !== "success") throw new TradeRejected(`approve reverted (tx ${approvalHash})`);
      log(`approved · tx ${approvalHash}`);
    }
  }

  // 7. Expiry + the wire args come from the quote (min(now + lifetime, marketExpiryNs)).
  const expireTimestampNs = quote.expireTimestampNs;
  const args = quote.args;
  const tag = decodeUserData(a.partner.userData);
  log(`placeBinaryOrder kind=${kind} priceYes=${priceYes} (limit own ${limitOwn}, touch own ${touchOwn}) qty=${qty} expireNs=${expireTimestampNs} builder=${args[6]} fee=${args[7]} userData=${args[8]}`);

  // 8. Simulate from OUR address: catches reverts and success=false before gas is spent.
  let simulated: { success: boolean; orderId: bigint };
  try {
    const sim = await pc.simulateContract({ address: pool, abi: errAbi, functionName: "placeBinaryOrder", args, account });
    const [success, orderId] = sim.result as unknown as readonly [boolean, bigint];
    simulated = { success, orderId };
  } catch (e) {
    const r = explainRevert(e);
    throw new TradeRejected(`simulation reverted: ${r.name ?? r.selector ?? r.message}`, r);
  }
  if (!simulated.success) throw new TradeRejected("simulation returned success=false (order would be silently rejected)");

  if (a.dryRun) {
    throw new TradeRejected("dryRun: simulation ok, not sending");
  }

  // 9. Send with a generous gas limit (Somnia's schedule is dear; the SDK uses a fixed 10M).
  const gas = a.gasLimit ?? (await estimateGasWithFloor(pc, { address: pool, abi: errAbi, functionName: "placeBinaryOrder", args, account }, MIN_ORDER_GAS));
  const hash = await sendContractWrite(wc, { address: pool, abi: errAbi, functionName: "placeBinaryOrder", args, account, gas, fees });
  log(`sent ${hash}`);
  const receipt = await pc.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    throw new TradeRejected(`tx ${hash} REVERTED on chain (gasUsed ${receipt.gasUsed})`);
  }

  // 10. Decode every log.
  const parsed = parseEventLogs({ abi: allKnownEvents as Abi, logs: receipt.logs, strict: false });
  const byIndex = new Map(parsed.map((p) => [p.logIndex, p] as const));
  const logs: DecodedReceiptLog[] = receipt.logs.map((l) => {
    const p = byIndex.get(l.logIndex);
    return {
      address: l.address,
      eventName: p?.eventName ?? eventNameForTopic(l.topics[0] ?? "0x"),
      topic0: (l.topics[0] ?? "0x") as Hex,
      args: (p?.args as Record<string, unknown> | undefined) ?? null,
    };
  });
  const unknownTopics = [...new Set(logs.filter((l) => !l.eventName).map((l) => l.topic0))];
  const poolLc = pool.toLowerCase();
  const placed = logs.find((l) => l.eventName === "OrderPlaced" && l.address.toLowerCase() === poolLc);
  const placedOrder = (placed?.args?.placedOrder ?? null) as { orderId: bigint; owner: Address; userData: bigint } | null;
  const kindLog = logs.find((l) => l.eventName === "BinaryOrderPlaced" && l.address.toLowerCase() === poolLc);
  const fills: TakerFill[] = logs
    .filter((l) => l.eventName === "OrderFilled" && l.address.toLowerCase() === poolLc)
    .map((l) => {
      const g = l.args as Record<string, bigint>;
      return { takerOrderId: g.takerOrderId!, makerOrderId: g.makerOrderId!, quantityFilled: g.quantityFilled!, fillPrice: g.fillPrice! };
    });
  const protocolFees: ProtocolFeeLog[] = logs
    .filter((l) => l.eventName === "ProtocolFeeCharged")
    .map((l) => {
      const g = l.args as Record<string, unknown>;
      return { orderId: g.orderId as bigint, payer: g.payer as Address, token: g.token as Address, amount: g.amount as bigint, isTakerSide: Boolean(g.isTakerSide) };
    });
  if (!placed) {
    throw new TradeRejected(`tx ${hash} mined with status=success but emitted no OrderPlaced — the pool rejected the order silently`);
  }
  const filled = fills.reduce((s, f) => s + f.quantityFilled, 0n);
  let spent = 0n;
  for (const f of fills) {
    const own = a.outcome === "UP" ? f.fillPrice : one - f.fillPrice;
    spent += (own * f.quantityFilled + one - 1n) / one;
  }
  const fillPriceOwn = filled > 0n ? (spent * one) / filled : null;

  return {
    hash,
    status: receipt.status,
    gasUsed: receipt.gasUsed,
    blockNumber: receipt.blockNumber,
    pool,
    market,
    outcome: a.outcome,
    kind,
    priceYes,
    priceOwn: limitOwn,
    qty,
    expireTimestampNs,
    simulated,
    orderId: placedOrder?.orderId ?? null,
    ownerOnChain: placedOrder?.owner ?? null,
    userDataOnChain: placedOrder?.userData ?? null,
    tag,
    kindOnChain: kindLog ? Number((kindLog.args as Record<string, unknown>).kind) : null,
    fills,
    filled,
    fillPriceOwn,
    spentCollateral: spent,
    protocolFees,
    unknownTopics,
    logs,
    approvalHash,
    receipt,
  };
}

/** Decode `placeBinaryOrder` calldata (e.g. from eth_getTransactionByHash) to confirm the builder round-trips. */
export function decodePlaceBinaryOrderCalldata(data: Hex): {
  kind: number;
  price: bigint;
  quantity: bigint;
  expireTimestampNs: bigint;
  orderType: number;
  selfMatchingOption: number;
  builder: Address;
  builderFeeBpsTimes1k: bigint;
  userData: bigint;
} | null {
  try {
    const d = decodeFunctionData({ abi: binaryPoolWriteAbi, data });
    if (d.functionName !== "placeBinaryOrder") return null;
    const [kind, price, quantity, expireTimestampNs, orderType, selfMatchingOption, builder, builderFeeBpsTimes1k, userData] = d.args as unknown as readonly [number, bigint, bigint, bigint, number, number, Address, bigint, bigint];
    return { kind, price, quantity, expireTimestampNs, orderType, selfMatchingOption, builder, builderFeeBpsTimes1k, userData };
  } catch {
    return null;
  }
}
