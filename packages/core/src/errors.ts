// Revert decoding for binary-pool writes.
//
// viem decodes a revert only if the ABI it was given carries the error. The
// markets-sdk ships the full generated table (`contractErrorsAbi`, ~500
// entries); scripts pass it in as `extraAbi`. This file carries the subset that
// matters for the paths Relay exercises so core stays SDK-free.

import { BaseError, ContractFunctionRevertedError, parseAbi, type Abi, type Hex } from "viem";

/** Errors a BinaryPool / module / settlement / tUSDC call can raise on Relay's paths. */
export const binaryErrorsAbi = parseAbi([
  // order placement
  "error PostOnlyWouldCross()",
  "error PriceOutOfBounds()",
  "error InvalidPrice()",
  "error InvalidQuantity()",
  "error OrderAlreadyExpired()",
  "error OrderExpiryBeyondMarket()",
  // An IOC that crosses nothing REVERTS (it does not mine as a no-op). Seen live when
  // the touch moved between the book read and the send — price through it.
  "error ImmediateOrCancelNoFill()",
  "error FillOrKillNotFilled()",
  "error UseBinaryPlacement()",
  "error CloseNotCaptured()",
  "error SettlementWindowOpen()",
  "error IncorrectSender()",
  "error IncorrectOrder()",
  "error InsufficientBalance()",
  "error InsufficientPermission()",
  // builder codes
  "error BuilderFeeExceedsCap()",
  "error BuilderFeeExceedsApproval()",
  "error BuilderNotApproved()",
  "error BuilderCodesNotSupported()",
  "error BuilderAddressReserved()",
  "error InvalidBuilder()",
  // settlement / redeem
  "error MarketNotSettled()",
  "error MarketNotFinalizedYet()",
  "error NotExpired()",
  // tUSDC faucet
  "error FaucetCapExceeded()",
  // OpenZeppelin ERC-20 (collateral pulls)
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
]);

export interface RevertInfo {
  /** Decoded error name, or null when the selector is not in any ABI we were given. */
  name: string | null;
  /** 4-byte selector (0x-prefixed), when the revert carried data. */
  selector: Hex | null;
  args: readonly unknown[] | null;
  /** Full revert data, when present. */
  raw: Hex | null;
  /** viem's one-line message. */
  message: string;
}

/**
 * Explain any error thrown by simulateContract / writeContract / readContract.
 * Never throws. `name` is null for an undecodable selector — compare the
 * `selector` against the SDK table then.
 */
export function explainRevert(e: unknown): RevertInfo {
  const message = ((e as { shortMessage?: string; message?: string })?.shortMessage ??
    (e as { message?: string })?.message ??
    String(e))
    .split("\n")[0]!;
  if (e instanceof BaseError) {
    const rev = e.walk((x) => x instanceof ContractFunctionRevertedError) as ContractFunctionRevertedError | null;
    if (rev) {
      const raw = (rev.raw ?? null) as Hex | null;
      const selector = (rev.signature ?? (raw && raw.length >= 10 ? (raw.slice(0, 10) as Hex) : null)) as Hex | null;
      return {
        name: rev.data?.errorName ?? (rev.reason ? `Error(${rev.reason})` : null),
        selector,
        args: rev.data?.args ?? null,
        raw,
        message,
      };
    }
  }
  return { name: null, selector: null, args: null, raw: null, message };
}

/** Merge ABIs for a call so viem can decode both the function and any known error. */
export function withErrors<const T extends Abi>(abi: T, extra?: Abi): Abi {
  return [...abi, ...binaryErrorsAbi, ...(extra ?? [])] as Abi;
}
