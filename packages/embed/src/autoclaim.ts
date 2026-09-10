// Who may redeem without being asked.
//
// The instant wallet's key lives in this browser and the widget already signs with it
// on every trade, so a redemption needs no more consent than the trade did — and a won
// position that sits unclaimed because nobody tapped a button is money the reader
// thinks they have and does not.
//
// An injected wallet is the opposite: every signature is a prompt the person answers,
// and a page that fires wallet prompts on its own is a page nobody should trust. Those
// keep the button.

import type { WalletKind } from "./wallet.js";

export type ClaimMode = "auto" | "manual" | "none";

export interface ClaimDecision {
  /** Is there anything to redeem at all? */
  kind: WalletKind | null;
  /** Total redeemable, in collateral units. */
  total: number;
  /** The `data-auto-claim` opt-out. */
  enabled: boolean;
}

/**
 * `auto`   — redeem now, no interaction (instant wallet, auto-claim on, something to claim)
 * `manual` — show the Claim button (injected wallet, or auto-claim turned off)
 * `none`   — nothing redeemable; show nothing
 */
export function claimMode(d: ClaimDecision): ClaimMode {
  if (!d.kind || d.total <= 0) return "none";
  if (d.kind !== "instant") return "manual";
  return d.enabled ? "auto" : "manual";
}
