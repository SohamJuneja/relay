// Proof of control is the only thing standing between an open registration form and
// someone claiming a builder address they do not hold, so its edges are worth pinning:
// the exact message string, the replay window, and every way a signature can be wrong.

import { describe, expect, it } from "vitest";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { acceptableMinutes, isoMinute, proofMessage, verifyProof } from "./proof.js";

const account = privateKeyToAccount(generatePrivateKey());
const other = privateKeyToAccount(generatePrivateKey());
const NONCE = "7f3a1c9b";

const sign = (message: string, who = account) => who.signMessage({ message });

describe("the message being signed", () => {
  it("is exactly four labelled lines", () => {
    const m = proofMessage({ builderAddress: account.address, nonce: NONCE, issued: "2026-09-09T16:45Z" });
    expect(m).toBe(`Relay partner registration\nbuilder: ${account.address}\nnonce: ${NONCE}\nissued: 2026-09-09T16:45Z`);
  });

  it("always names the address in checksum form, whatever case was passed", () => {
    const lower = proofMessage({ builderAddress: account.address.toLowerCase(), nonce: NONCE, issued: "2026-09-09T16:45Z" });
    expect(lower).toContain(account.address);
  });

  it("truncates the timestamp to the minute", () => {
    const t = isoMinute(new Date("2026-09-09T16:45:37.123Z"));
    expect(t).toBe("2026-09-09T16:45Z");
  });
});

describe("verifyProof", () => {
  it("accepts a signature from the builder address", async () => {
    const issued = isoMinute();
    const signature = await sign(proofMessage({ builderAddress: account.address, nonce: NONCE, issued }));
    const r = await verifyProof({ builderAddress: account.address, nonce: NONCE, signature, issued });
    expect(r).toEqual({ ok: true, issued });
  });

  it("finds the right minute when the client does not say which it used", async () => {
    // Signed five minutes ago and posted now: still inside the window, and the server
    // has to work out which minute string it was without being told.
    const then = new Date(Date.now() - 5 * 60_000);
    const issued = isoMinute(then);
    const signature = await sign(proofMessage({ builderAddress: account.address, nonce: NONCE, issued }));
    const r = await verifyProof({ builderAddress: account.address, nonce: NONCE, signature });
    expect(r.ok).toBe(true);
  });

  it("refuses a signature from a different key", async () => {
    const issued = isoMinute();
    const signature = await sign(proofMessage({ builderAddress: account.address, nonce: NONCE, issued }), other);
    const r = await verifyProof({ builderAddress: account.address, nonce: NONCE, signature, issued });
    expect(r).toMatchObject({ ok: false });
  });

  it("refuses when the nonce is not the one that was signed", async () => {
    const issued = isoMinute();
    const signature = await sign(proofMessage({ builderAddress: account.address, nonce: NONCE, issued }));
    const r = await verifyProof({ builderAddress: account.address, nonce: "a-different-nonce", signature, issued });
    expect(r).toMatchObject({ ok: false });
  });

  it("expires: a signature from outside the window is refused even though it is valid", async () => {
    // This is the whole point of `issued`. Without it a captured signature would let
    // anyone re-claim the address forever.
    const old = new Date(Date.now() - 60 * 60_000);
    const issued = isoMinute(old);
    const signature = await sign(proofMessage({ builderAddress: account.address, nonce: NONCE, issued }));
    const stated = await verifyProof({ builderAddress: account.address, nonce: NONCE, signature, issued });
    expect(stated).toMatchObject({ ok: false });
    const searched = await verifyProof({ builderAddress: account.address, nonce: NONCE, signature });
    expect(searched).toMatchObject({ ok: false });
  });

  it("rejects malformed input before it reaches the verifier", async () => {
    expect(await verifyProof({ builderAddress: account.address, nonce: NONCE, signature: "not-hex" })).toMatchObject({ ok: false });
    expect(await verifyProof({ builderAddress: "0xnope", nonce: NONCE, signature: "0xab" })).toMatchObject({ ok: false });
    expect(await verifyProof({ builderAddress: account.address, nonce: "", signature: "0xab" })).toMatchObject({ ok: false });
  });

  it("offers one candidate minute per minute of the window, newest first", () => {
    const now = new Date("2026-09-09T16:45:30Z");
    const mins = acceptableMinutes(now, 3);
    expect(mins).toEqual(["2026-09-09T16:45Z", "2026-09-09T16:44Z", "2026-09-09T16:43Z", "2026-09-09T16:42Z"]);
  });
});
