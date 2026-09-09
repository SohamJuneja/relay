// Whether a partner proved they hold the builder address, and a way to prove it.
//
// The badge is not decoration: on mainnet that address is where the builder fee is
// paid, and registration lets anyone type any address. "Unverified" is the honest
// default and the button next to it is the whole remedy — one signature from the
// wallet that owns the address.

import { useState } from "react";
import { api } from "../api";
import { isoMinute, proofMessage, randomNonce } from "../proof";

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}
const injected = (): Eip1193 | null => (globalThis as unknown as { ethereum?: Eip1193 }).ethereum ?? null;

export function VerifiedBadge(props: { partnerId: number; apiKey: string; builderAddress: string; verified: boolean; onVerified: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (props.verified) {
    return (
      <span
        className="up"
        data-testid="verified-badge"
        style={{ fontWeight: 700, fontSize: 11.5, border: "1px solid color-mix(in srgb, var(--up) 40%, var(--line))", borderRadius: 999, padding: "2px 8px" }}
        title="This partner signed a message with the builder address's key, so they demonstrably control where the fee is paid."
      >
        verified
      </span>
    );
  }

  async function verify() {
    setError(null);
    const provider = injected();
    if (!provider) {
      setError("Open this page in a browser with the builder wallet to sign.");
      return;
    }
    setBusy(true);
    try {
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const from = accounts[0];
      if (!from) throw new Error("the wallet returned no account");
      if (from.toLowerCase() !== props.builderAddress.toLowerCase()) {
        throw new Error(`connect ${props.builderAddress} — this wallet is a different address`);
      }
      const nonce = randomNonce();
      const issued = isoMinute();
      const message = proofMessage({ builderAddress: props.builderAddress, nonce, issued });
      const signature = (await provider.request({ method: "personal_sign", params: [message, from] })) as string;
      await api.verify(props.partnerId, props.apiKey, { signature, nonce, issued });
      props.onVerified();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <span style={{ display: "inline-flex", gap: 6, alignItems: "center", flexWrap: "wrap" }} data-testid="unverified-badge">
      <span
        style={{ fontWeight: 600, fontSize: 11.5, border: "1px solid var(--line-strong)", borderRadius: 999, padding: "2px 8px", color: "var(--ink-3)" }}
        title="Anyone can type an address into the registration form. Sign with that address to prove you control it."
      >
        unverified
      </span>
      <button type="button" className="btn ghost sm" onClick={() => void verify()} disabled={busy}>
        {busy ? "waiting for signature…" : "sign to verify"}
      </button>
      {error ? <span className="down" style={{ fontSize: 11.5 }}>{error}</span> : null}
    </span>
  );
}
