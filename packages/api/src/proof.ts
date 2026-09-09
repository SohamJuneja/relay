// Proof that a partner controls the builder address they registered.
//
// Registration is open: anyone can type anyone's address into the form, and on
// mainnet that address is where a builder fee is paid. A signature over a fixed
// message is the cheapest possible proof that the person registering holds the key.
//
// The message is deliberately human-readable, because the reader is being asked to
// sign it in a wallet popup and should be able to tell what they are agreeing to:
//
//   Relay partner registration
//   builder: 0xAbC…123
//   nonce: 7f3a…
//   issued: 2026-09-09T16:45Z
//
// `issued` is truncated to the minute so the client and the server can agree on the
// string without passing a timestamp back and forth to the second, and it bounds how
// long a captured signature stays useful.

import { getAddress, verifyMessage, type Address } from "viem";

/** How far back an `issued` minute may be and still verify. */
export const PROOF_WINDOW_MINUTES = 15;

/** An ISO instant truncated to the minute: "2026-09-09T16:45Z". */
export const isoMinute = (d: Date = new Date()): string => `${d.toISOString().slice(0, 16)}Z`;

export interface ProofInput {
  builderAddress: string;
  nonce: string;
  issued: string;
}

/** The exact string the wallet signs. Any drift here fails every verification. */
export function proofMessage(input: ProofInput): string {
  return ["Relay partner registration", `builder: ${getAddress(input.builderAddress)}`, `nonce: ${input.nonce}`, `issued: ${input.issued}`].join("\n");
}

/** Every `issued` minute that is still acceptable, newest first. */
export function acceptableMinutes(now: Date = new Date(), windowMinutes = PROOF_WINDOW_MINUTES): string[] {
  const out: string[] = [];
  for (let i = 0; i <= windowMinutes; i++) out.push(isoMinute(new Date(now.getTime() - i * 60_000)));
  return out;
}

export type ProofResult = { ok: true; issued: string } | { ok: false; reason: string };

/**
 * Check a signature over the registration message.
 *
 * When the caller says which minute it signed, only that minute is tried — and it
 * must be recent. When it does not, every minute inside the window is tried, so a
 * client that simply signs and posts still works. Either way a signature older than
 * the window is refused: an open-ended proof is a credential someone can keep.
 */
export async function verifyProof(args: {
  builderAddress: string;
  nonce: string;
  signature: string;
  issued?: string | undefined;
  now?: Date;
  windowMinutes?: number;
}): Promise<ProofResult> {
  const now = args.now ?? new Date();
  const windowMinutes = args.windowMinutes ?? PROOF_WINDOW_MINUTES;
  if (!/^0x[0-9a-fA-F]+$/.test(args.signature)) return { ok: false, reason: "signature is not hex" };
  if (!args.nonce || args.nonce.length > 128) return { ok: false, reason: "nonce must be 1–128 characters" };

  let address: Address;
  try {
    address = getAddress(args.builderAddress);
  } catch {
    return { ok: false, reason: "builder address is not a valid address" };
  }

  const candidates = args.issued ? [args.issued] : acceptableMinutes(now, windowMinutes);
  if (args.issued && !acceptableMinutes(now, windowMinutes).includes(args.issued)) {
    return { ok: false, reason: `issued must be within the last ${windowMinutes} minutes` };
  }

  for (const issued of candidates) {
    const message = proofMessage({ builderAddress: address, nonce: args.nonce, issued });
    const ok = await verifyMessage({ address, message, signature: args.signature as `0x${string}` }).catch(() => false);
    if (ok) return { ok: true, issued };
  }
  return { ok: false, reason: "the signature does not match this builder address" };
}
