// Browser-side chain work: read the pool grid, build the order with the SAME
// pure builder the Node signer uses, simulate, send, decode the receipt, claim.
//
// Reads and sends go through `Rpc` (fetch + JSON-RPC); ABI encoding and the
// signature come from viem. Receipt logs are matched on the topic0 constants
// that `@relay/core` derives from its pinned event ABIs, so the widget and the
// indexer agree on what an event is.

import { decodeAbiParameters, encodeFunctionData, type Abi, type Address, type Hex } from "viem";
import {
  TOPICS,
  binaryMarketReadAbi,
  binaryPoolReadAbi,
  binaryPoolWriteAbi,
  buildApproveCall,
  buildFaucetCall,
  buildRedeemCall,
  buildRedeemManyCall,
  buildSetOperatorCall,
  buildTakerOrder,
  decodeUserData,
  erc20Abi,
  outcomeToken6909Abi,
  type ContractCall,
  type GridParams,
  type PlaceBinaryOrderArgs,
  type TakerOrderQuote,
} from "@relay/core/browser";
import { Rpc, revertNameOf, type Receipt } from "./rpc.js";
import { FEES, type RelayWallet } from "./wallet.js";
import type { Book, ClaimRow, Market, Outcome } from "./types.js";

// Gas on Somnia, measured on Shannon rather than assumed:
//   placeBinaryOrder that fills  434 k – 850 k      tUSDC faucet     253 k (estimate says 1.38 M)
//   module redeem                273 k              ERC-20 approve  ~100 k
// A node reserves `gas × maxFeePerGas` from the balance BEFORE execution, so an
// over-generous limit makes a small burner look broke ("insufficient balance")
// even though the transaction would only spend a fraction of it. Hence a modest
// 1.5× multiplier over the estimate, a hard ceiling, and floors sized to the
// measurements above.
const GAS_FLOOR = { order: 1_500_000n, approve: 500_000n, faucet: 800_000n, operator: 400_000n, redeem: 900_000n } as const;
const GAS_CEILING = 3_000_000n;

export class TradeError extends Error {
  constructor(
    message: string,
    readonly revertName: string | null = null,
  ) {
    super(message);
    this.name = "TradeError";
  }
}

export interface MarketContext {
  pool: Address;
  marketAddress: Address;
  collateral: Address;
  outcomeToken: Address;
  decimals: number;
  one: bigint;
  grid: GridParams;
  marketExpiryNs: bigint;
  settlementFeeBpsTimes1k: bigint;
  /** On-chain status right now — the authority, never the indexed one. */
  status: number;
}

interface PoolParams {
  collateralToken: Address;
  market: Address;
  outcomeToken: Address;
  oneCollateral: bigint;
  settlementFeeBpsTimes1k: bigint;
}

export async function readMarketContext(rpc: Rpc, market: Pick<Market, "pool" | "marketAddress">): Promise<MarketContext> {
  const [params, grid, expiryNs, status] = await Promise.all([
    rpc.read<PoolParams>({ address: market.pool, abi: binaryPoolReadAbi, functionName: "getBinaryPoolParams" }),
    rpc.read<GridParams>({ address: market.pool, abi: binaryPoolReadAbi, functionName: "getOrderBookParameters" }),
    rpc.read<bigint>({ address: market.pool, abi: binaryPoolReadAbi, functionName: "marketExpiryNs" }),
    rpc.read<number>({ address: market.marketAddress, abi: binaryMarketReadAbi, functionName: "status" }),
  ]);
  const decimals = await rpc.read<number>({ address: params.collateralToken, abi: erc20Abi, functionName: "decimals" });
  return {
    pool: market.pool,
    marketAddress: market.marketAddress,
    collateral: params.collateralToken,
    outcomeToken: params.outcomeToken,
    decimals: Number(decimals),
    one: params.oneCollateral,
    grid: { tickSize: grid.tickSize, minQuantity: grid.minQuantity, lotSize: grid.lotSize },
    marketExpiryNs: expiryNs,
    settlementFeeBpsTimes1k: params.settlementFeeBpsTimes1k,
    status: Number(status),
  };
}

export interface Balances {
  gas: bigint;
  collateral: bigint;
  allowance: bigint;
}

export async function readBalances(rpc: Rpc, ctx: MarketContext, owner: Address): Promise<Balances> {
  const [gas, collateral, allowance] = await Promise.all([
    rpc.getBalance(owner),
    rpc.read<bigint>({ address: ctx.collateral, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    rpc.read<bigint>({ address: ctx.collateral, abi: erc20Abi, functionName: "allowance", args: [owner, ctx.pool] }),
  ]);
  return { gas, collateral, allowance };
}

export const collateralBalance = (rpc: Rpc, token: Address, owner: Address): Promise<bigint> =>
  rpc.read<bigint>({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [owner] });

export interface RawBook {
  yesBids: { price: bigint; quantity: bigint }[];
  yesAsks: { price: bigint; quantity: bigint }[];
}

/**
 * Read the pool's book straight from the contract.
 *
 * The streamed book is a second or two old, and on this venue the maker requotes
 * constantly — an IOC priced off a stale touch reverts `ImmediateOrCancelNoFill`.
 * So the confirm step re-reads here and rebuilds the order against what is on
 * chain right now, exactly as the Node signer does.
 */
export async function readYesBook(rpc: Rpc, pool: Address, depth = 10): Promise<RawBook> {
  const [bids, asks] = await Promise.all([
    rpc.read<readonly { price: bigint; quantity: bigint }[]>({ address: pool, abi: binaryPoolReadAbi, functionName: "getBookLevels", args: [true, BigInt(depth)] }),
    rpc.read<readonly { price: bigint; quantity: bigint }[]>({ address: pool, abi: binaryPoolReadAbi, functionName: "getBookLevels", args: [false, BigInt(depth)] }),
  ]);
  return {
    yesBids: bids.map((l) => ({ price: l.price, quantity: l.quantity })),
    yesAsks: asks.map((l) => ({ price: l.price, quantity: l.quantity })),
  };
}

/** API book (human numbers, raw strings alongside) → raw levels for the order builder. */
function rawLevels(book: Book | null | undefined): { yesBids: { price: bigint; quantity: bigint }[]; yesAsks: { price: bigint; quantity: bigint }[] } {
  const conv = (ls: Book["yesBids"] | undefined) => (ls ?? []).map((l) => ({ price: BigInt(l.priceRaw), quantity: BigInt(l.quantityRaw) }));
  return { yesBids: conv(book?.yesBids), yesAsks: conv(book?.yesAsks) };
}

export interface QuoteArgs {
  book: Book | null;
  /** Fresh on-chain levels; when given they win over `book`. */
  raw?: RawBook | undefined;
  ctx: MarketContext;
  outcome: Outcome;
  budget: bigint;
  partner: { builder?: Address | undefined; userData: bigint };
  nowSec: number;
}

export function quote(a: QuoteArgs): TakerOrderQuote {
  const { yesBids, yesAsks } = a.raw ?? rawLevels(a.book);
  return buildTakerOrder({
    outcome: a.outcome,
    yesBids,
    yesAsks,
    one: a.ctx.one,
    grid: a.ctx.grid,
    budget: a.budget,
    partner: { builder: a.partner.builder, builderFeeBpsTimes1k: 0n, userData: a.partner.userData },
    nowSec: a.nowSec,
    expireInSec: 45,
    marketExpiryNs: a.ctx.marketExpiryNs,
    settlementFeeBpsTimes1k: a.ctx.settlementFeeBpsTimes1k,
  });
}

// ───────────────────────────── sending ─────────────────────────────

async function gasFor(rpc: Rpc, wallet: RelayWallet, call: ContractCall, floor: bigint): Promise<bigint> {
  const data = encode(call);
  const est = await rpc.estimateGas({ to: call.address, data, from: wallet.address }).catch(() => 0n);
  const padded = (est * 3n) / 2n;
  const gas = padded > floor ? padded : floor;
  return gas > GAS_CEILING ? GAS_CEILING : gas;
}

/** The `buildXCall` helpers carry their own ABI, so this is the one encode path. */
function encode(call: ContractCall): Hex {
  return encodeFunctionData({ abi: call.abi as Abi, functionName: call.functionName, args: call.args as readonly unknown[] });
}

/**
 * Refuse before signing when the node would refuse anyway, and say why in terms
 * the user can act on — the raw error is a bare "insufficient balance" that gives
 * no hint that the *reserve*, not the fee, is what does not fit.
 */
async function assertAffordable(rpc: Rpc, wallet: RelayWallet, gas: bigint, label: string): Promise<void> {
  if (wallet.kind !== "instant") return; // an injected wallet prices its own transactions
  const balance = await rpc.getBalance(wallet.address).catch(() => null);
  if (balance === null) return;
  const reserve = gas * FEES.maxFeePerGas;
  if (balance >= reserve) return;
  throw new TradeError(
    `not enough STT for ${label}: the network holds ${fmtStt(reserve)} aside for gas (${gas} × ${FEES.maxFeePerGas / 1_000_000_000n} gwei) and this wallet has ${fmtStt(balance)}`,
  );
}

const fmtStt = (wei: bigint): string => `${(Number(wei) / 1e18).toFixed(4)} STT`;

async function sendCall(rpc: Rpc, wallet: RelayWallet, call: ContractCall, floor: bigint, label: string): Promise<Hex> {
  const gas = await gasFor(rpc, wallet, call, floor);
  await assertAffordable(rpc, wallet, gas, label);
  const hash = await wallet.send({ to: call.address, data: encode(call), gas });
  const r = await rpc.waitForReceipt(hash);
  if (r.status !== "success") throw new TradeError(`${label} reverted on chain`, null);
  return hash;
}

/** Approve the pool for collateral when the allowance is short. */
export async function ensureAllowance(rpc: Rpc, wallet: RelayWallet, ctx: MarketContext, need: bigint): Promise<Hex | null> {
  const allowance = await rpc.read<bigint>({ address: ctx.collateral, abi: erc20Abi, functionName: "allowance", args: [wallet.address, ctx.pool] });
  if (allowance >= need) return null;
  const amount = need * 100n > 1_000n * ctx.one ? need * 100n : 1_000n * ctx.one;
  return sendCall(rpc, wallet, buildApproveCall(ctx.collateral, ctx.pool, amount), GAS_FLOOR.approve, "approve");
}

export function faucet(rpc: Rpc, wallet: RelayWallet, testUsdc: Address, amount: bigint): Promise<Hex> {
  return sendCall(rpc, wallet, buildFaucetCall(testUsdc, amount), GAS_FLOOR.faucet, "tUSDC faucet");
}

export interface TradeResult {
  hash: Hex;
  status: "success" | "reverted";
  gasUsed: bigint;
  orderId: bigint | null;
  userData: bigint | null;
  tagged: boolean;
  builderSeen: Address | null;
  filledRaw: bigint;
  /** VWAP in the outcome's own terms, raw. */
  fillPriceOwnRaw: bigint | null;
  spentRaw: bigint;
  approvalHash: Hex | null;
}

export interface PlaceArgs {
  rpc: Rpc;
  wallet: RelayWallet;
  ctx: MarketContext;
  args: PlaceBinaryOrderArgs;
  escrow: bigint;
  outcome: Outcome;
  onStage?: (s: "approving" | "signing" | "pending") => void;
}

/**
 * Simulate → send → decode.
 *
 * The simulation is not optional: `placeBinaryOrder` returns `(success, orderId)`
 * and a `false` there does NOT revert, so an unsimulated order can mine as a
 * silent no-op. We also require an `OrderPlaced` log in the receipt.
 */
export async function placeOrder(a: PlaceArgs): Promise<TradeResult> {
  const { rpc, wallet, ctx } = a;
  a.onStage?.("approving");
  const approvalHash = await ensureAllowance(rpc, wallet, ctx, a.escrow);

  const call: ContractCall = { address: ctx.pool, abi: binaryPoolWriteAbi, functionName: "placeBinaryOrder", args: a.args };
  const data = encode(call);
  try {
    const out = await rpc.call({ to: ctx.pool, data, from: wallet.address });
    const [ok] = decodeAbiParameters([{ type: "bool" }, { type: "uint128" }], out) as unknown as [boolean, bigint];
    if (!ok) throw new TradeError("the pool would reject this order (simulation returned success = false)");
  } catch (e) {
    if (e instanceof TradeError) throw e;
    const name = revertNameOf(e);
    throw new TradeError(revertMessage(name), name);
  }

  a.onStage?.("signing");
  const gas = await gasFor(rpc, wallet, call, GAS_FLOOR.order);
  await assertAffordable(rpc, wallet, gas, "this order");
  const hash = await wallet.send({ to: ctx.pool, data, gas });
  a.onStage?.("pending");
  const receipt = await rpc.waitForReceipt(hash);
  if (receipt.status !== "success") throw new TradeError(`the transaction reverted on chain (${hash.slice(0, 12)}…)`);

  const decoded = decodeOrderReceipt(receipt, ctx);
  if (decoded.orderId === null) throw new TradeError("the order mined but emitted no OrderPlaced — the pool rejected it silently");

  let filledRaw = 0n;
  let spentRaw = 0n;
  for (const f of decoded.fills) {
    const own = a.outcome === "UP" ? f.fillPrice : ctx.one - f.fillPrice;
    filledRaw += f.quantityFilled;
    spentRaw += (own * f.quantityFilled + ctx.one - 1n) / ctx.one;
  }
  return {
    hash,
    status: receipt.status,
    gasUsed: receipt.gasUsed,
    orderId: decoded.orderId,
    userData: decoded.userData,
    tagged: decoded.userData === null ? false : decodeUserData(decoded.userData).tagged,
    builderSeen: decoded.builder,
    filledRaw,
    fillPriceOwnRaw: filledRaw > 0n ? (spentRaw * ctx.one) / filledRaw : null,
    spentRaw,
    approvalHash,
  };
}

const PLACED_ORDER_TUPLE = [
  {
    type: "tuple",
    components: [
      { name: "orderId", type: "uint128" },
      { name: "isBid", type: "bool" },
      { name: "owner", type: "address" },
      { name: "userData", type: "uint64" },
      { name: "price", type: "uint256" },
      { name: "fullQuantity", type: "uint256" },
      { name: "quantityRemaining", type: "uint256" },
      { name: "expireTimestampNs", type: "uint64" },
    ],
  },
] as const;

const FILL_DATA = [{ type: "uint256" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }] as const;

/** Pull the three events we care about out of a receipt by pinned topic0. */
export function decodeOrderReceipt(receipt: Receipt, ctx: MarketContext) {
  const pool = ctx.pool.toLowerCase();
  let orderId: bigint | null = null;
  let userData: bigint | null = null;
  let builder: Address | null = null;
  const fills: { quantityFilled: bigint; fillPrice: bigint }[] = [];
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== pool) continue;
    const t0 = (log.topics[0] ?? "").toLowerCase();
    if (t0 === TOPICS.OrderPlaced.toLowerCase()) {
      const [placed] = decodeAbiParameters(PLACED_ORDER_TUPLE, log.data) as unknown as [{ orderId: bigint; userData: bigint }];
      orderId = placed.orderId;
      userData = placed.userData;
    } else if (t0 === TOPICS.OrderFilled.toLowerCase()) {
      const [quantityFilled, , , fillPrice] = decodeAbiParameters(FILL_DATA, log.data) as unknown as [bigint, bigint, bigint, bigint];
      fills.push({ quantityFilled, fillPrice });
    } else if (t0 === TOPICS.BuilderFeeCharged.toLowerCase()) {
      const t2 = log.topics[2];
      if (t2) builder = (`0x${t2.slice(-40)}` as Address).toLowerCase() as Address;
    }
  }
  return { orderId, userData, builder, fills };
}

/**
 * Turn a decoded revert into something a person can act on.
 *
 * Each of these is displayed as a standalone sentence in a notice, so each starts
 * with a capital and ends with a full stop — they were written as clause fragments
 * for a sentence that no longer wraps them.
 */
export function revertMessage(name: string | null): string {
  switch (name) {
    case "ImmediateOrCancelNoFill":
      return "The price moved before the order landed — there was nothing left to buy at that level. The numbers below are refreshed; try again.";
    case "PostOnlyWouldCross":
      return "That order would have crossed the book.";
    case "ERC20InsufficientBalance":
      return "Not enough tUSDC for this trade.";
    case "ERC20InsufficientAllowance":
      return "The pool is not approved to spend tUSDC yet.";
    case "BuilderFeeExceedsCap":
      return "Builder fees are not enabled on this network.";
    case "CloseNotCaptured":
      return "This window has closed and is settling.";
    case "OrderExpiryBeyondMarket":
      return "The order would outlive the market.";
    case "PriceOutOfBounds":
    case "InvalidPrice":
      return "That price is outside the market's range.";
    case "InvalidQuantity":
      return "That size is off the market's lot grid.";
    case null:
      return "The pool rejected the order.";
    default:
      return `The pool rejected the order (${name}).`;
  }
}

// ───────────────────────────── claiming ─────────────────────────────

export interface ClaimArgs {
  rpc: Rpc;
  wallet: RelayWallet;
  binaryModule: Address;
  outcomeToken: Address;
  claims: ClaimRow[];
  onProgress?: (done: number, total: number) => void;
}

export interface ClaimResult {
  hashes: Hex[];
  operatorHash: Hex | null;
  batched: boolean;
}

/**
 * Redeem winning positions. The module pulls the outcome tokens, so it needs a
 * one-time ERC-6909 operator grant. `redeemMany` is in the ABI but is not
 * guaranteed to be behind the proxy, so it is simulated before it is sent and
 * falls back to one transaction per claim.
 */
export async function claim(a: ClaimArgs): Promise<ClaimResult> {
  const { rpc, wallet } = a;
  if (a.claims.length === 0) return { hashes: [], operatorHash: null, batched: false };

  let operatorHash: Hex | null = null;
  const isOperator = await rpc.read<boolean>({ address: a.outcomeToken, abi: outcomeToken6909Abi, functionName: "isOperator", args: [wallet.address, a.binaryModule] });
  if (!isOperator) {
    operatorHash = await sendCall(rpc, wallet, buildSetOperatorCall(a.outcomeToken, a.binaryModule), GAS_FLOOR.operator, "granting the module permission");
  }

  const first = a.claims[0]!;
  const sameScope = a.claims.every((c) => c.operatorId === first.operatorId && c.venueId.toLowerCase() === first.venueId.toLowerCase());

  const hashes: Hex[] = [];
  if (a.claims.length > 1 && sameScope) {
    // Probe `redeemMany` by SIMULATING it, not by looking for its selector in the
    // module's bytecode. The module is a proxy — 130 bytes of delegating stub that
    // contains no selectors at all — so a bytecode probe answers "unsupported" for
    // every method it will ever be asked about, and the batch path was dead code.
    // An eth_call either returns or reverts, which is the actual question.
    const call = buildRedeemManyCall({
      binaryModule: a.binaryModule,
      operatorId: first.operatorId,
      venueId: first.venueId,
      claims: a.claims.map((c) => ({ marketId: c.marketId, outcomeIdx: c.outcomeIdx as 0 | 1, amount: BigInt(c.amountRaw) })),
    });
    const batchable = await rpc
      .call({ to: a.binaryModule, data: encode(call), from: wallet.address })
      .then(() => true)
      .catch(() => false);
    if (batchable) {
      hashes.push(await sendCall(rpc, wallet, call, GAS_FLOOR.redeem * BigInt(a.claims.length), "claim"));
      a.onProgress?.(a.claims.length, a.claims.length);
      return { hashes, operatorHash, batched: true };
    }
    // else: fall through and redeem one at a time — slower, but it always works.
  }

  for (const [i, c] of a.claims.entries()) {
    const call = buildRedeemCall({ binaryModule: a.binaryModule, operatorId: c.operatorId, venueId: c.venueId, marketId: c.marketId, outcomeIdx: c.outcomeIdx as 0 | 1, amount: BigInt(c.amountRaw) });
    hashes.push(await sendCall(rpc, wallet, call, GAS_FLOOR.redeem, `claim ${i + 1}`));
    a.onProgress?.(i + 1, a.claims.length);
  }
  return { hashes, operatorHash, batched: false };
}
