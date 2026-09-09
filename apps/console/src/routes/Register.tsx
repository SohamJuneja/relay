// Registration, and the one moment the API key exists in a readable form.
//
// Two states: the form, and the result. The result is deliberately noisy about the
// key — it is shown once and hashed on the server, so a reader who skims past it has
// lost it. The snippet and a live preview of their own widget sit underneath, so the
// first thing a new partner sees is their product working.

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { getAddress, isAddress } from "viem";
import { api, type RegisterResult } from "../api";
import { saveSession } from "../session";
import { embedSnippet } from "../config";
import { CopyButton } from "../components/ui";
import { isoMinute, proofMessage, randomNonce } from "../proof";
import { WidgetPreview } from "../components/WidgetPreview";

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}
const injected = (): Eip1193 | null => (globalThis as unknown as { ethereum?: Eip1193 }).ethereum ?? null;

export function Register() {
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [homepage, setHomepage] = useState("");
  const [builder, setBuilder] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RegisterResult | null>(null);
  // Set when the address came from a wallet this page can talk to. Only then can we
  // sign for it — a pasted address usually belongs to a key that is somewhere else.
  const [signer, setSigner] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  // Checksum, not just shape: a lowercase address is accepted and normalised, but a
  // MIXED-case one with a bad checksum is a typo, and paying fees to a typo is
  // unrecoverable. viem's getAddress throws on exactly that case.
  const builderProblem = (() => {
    const v = builder.trim();
    if (!v) return null;
    if (!/^0x[0-9a-fA-F]{40}$/.test(v)) return "An address is 0x followed by 40 hex characters.";
    if (!isAddress(v)) return "That address does not pass its own checksum — check for a mistyped character.";
    return null;
  })();

  async function useConnectedWallet() {
    setError(null);
    const provider = injected();
    if (!provider) {
      setError("No browser wallet found. Paste the address instead.");
      return;
    }
    try {
      const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
      const a = accounts[0];
      if (!a) throw new Error("the wallet returned no account");
      setBuilder(getAddress(a));
      setSigner(getAddress(a));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!name.trim()) return setError("A name is required.");
    if (builderProblem || !builder.trim()) return setError(builderProblem ?? "A builder address is required.");
    setBusy(true);
    try {
      const address = getAddress(builder.trim());
      // When the address came from the connected wallet, prove control on the way in:
      // the reader is already in a wallet, and one signature turns an open claim into
      // a verified one. A refusal is not fatal — registration proceeds unverified.
      let proof: { signature: string; nonce: string; issued: string } | null = null;
      const provider = injected();
      if (provider && signer && signer.toLowerCase() === address.toLowerCase()) {
        try {
          const nonce = randomNonce();
          const issued = isoMinute();
          const message = proofMessage({ builderAddress: address, nonce, issued });
          const signature = (await provider.request({ method: "personal_sign", params: [message, address] })) as string;
          proof = { signature, nonce, issued };
        } catch {
          /* declined or unsupported — carry on unverified */
        }
      }
      const res = await api.register({
        name: name.trim(),
        builderAddress: address,
        ...(homepage.trim() ? { homepage: homepage.trim() } : {}),
        ...(proof ?? {}),
      });
      setResult(res);
      // The dashboard needs the key for this tab only.
      saveSession({ partnerId: res.partnerId, apiKey: res.apiKey });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    return (
      <main>
        <div className="stack">
          <div>
            <h1>{result.name} is registered.</h1>
            <p className="lede" style={{ marginTop: 10 }}>
              You are partner <b>{result.partnerId}</b>. Every order the widget sends will carry that id and your
              builder code.
            </p>
            <p style={{ marginTop: 8, fontSize: 13 }} data-testid="verified-state">
              {result.verified ? (
                <span className="up" style={{ fontWeight: 700 }}>Verified — you signed for this builder address.</span>
              ) : (
                <span className="muted">
                  Unverified. Anyone can type an address into this form, so the badge only appears once you sign for it —
                  connect the builder wallet and verify from your dashboard.
                  {result.verificationError ? ` (${result.verificationError})` : ""}
                </span>
              )}
            </p>
          </div>

          <div className="card" style={{ borderColor: "color-mix(in srgb, var(--down) 40%, var(--line))" }}>
            <header>
              <h2>Your API key</h2>
              <CopyButton text={result.apiKey} label="Copy key" className="btn sm" />
            </header>
            <pre className="snippet" data-testid="api-key" style={{ userSelect: "all" }}>
              {result.apiKey}
            </pre>
            <div className="note warn" style={{ marginTop: 10 }} role="alert">
              <b>This is the only time this key is shown.</b> It is stored hashed on the server and cannot be
              recovered — copy it into your password manager now. It is kept in this browser tab for your dashboard
              session and discarded when the tab closes.
            </div>
            <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, fontSize: 13 }}>
              <input type="checkbox" checked={acknowledged} onChange={(e) => setAcknowledged(e.currentTarget.checked)} />
              I have saved this key somewhere safe.
            </label>
          </div>

          <div className="card">
            <header>
              <h2>Your snippet</h2>
              <CopyButton text={result.snippet} label="Copy snippet" />
            </header>
            {/* The API returns a snippet built from ITS idea of where the bundle is
                served. This console knows its own CDN, and that is the URL a partner
                should paste, so the page prefers it and falls back to the API's. */}
            <pre className="snippet" data-testid="snippet">
              {embedSnippet(result.partnerId, result.builderAddress) || result.snippet}
            </pre>
            <p className="hint" style={{ marginTop: 10 }}>
              Paste it anywhere on your page. Add <code className="inline">data-asset</code>,{" "}
              <code className="inline">data-interval</code> or <code className="inline">data-surface</code> to change
              which market it shows and how the flow is labelled.
            </p>
          </div>

          {/* The caption sits directly above the card rather than in a column beside
              it: a two-column split here left most of the page empty next to a 380 px
              widget, which reads as a layout bug rather than a deliberate space. */}
          <div className="stack tight" style={{ maxWidth: 420 }}>
            <h3>What your readers will see</h3>
            <p className="hint">Mounted with partner {result.partnerId} and your builder address, against the live venue.</p>
            <WidgetPreview partner={result.partnerId} builder={result.builderAddress} asset="BTC" intervalSec={900} surface="web" />
          </div>

          <div className="row-between">
            <button type="button" className="btn" disabled={!acknowledged} onClick={() => navigate("/dashboard")}>
              {acknowledged ? "Open my dashboard" : "Save the key to continue"}
            </button>
            <span className="muted" style={{ fontSize: 12.5 }}>
              Builder code <span className="mono">{result.builderAddress}</span>
            </span>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main>
      <div className="stack" style={{ maxWidth: 560 }}>
        <div>
          <h1>Register as a partner</h1>
          <p className="lede" style={{ marginTop: 10 }}>
            Two fields. You get a partner id, an API key, and a snippet with both filled in.
          </p>
        </div>

        <form className="card stack tight" onSubmit={submit}>
          <label className="field">
            Name
            <input type="text" value={name} onChange={(e) => setName(e.currentTarget.value)} placeholder="Demo News" required maxLength={80} autoComplete="organization" />
            <span className="hint">Shown on your public partner card and on the widget's receipt.</span>
          </label>

          <label className="field">
            Homepage <span className="muted">(optional)</span>
            <input type="url" value={homepage} onChange={(e) => setHomepage(e.currentTarget.value)} placeholder="https://example.com" autoComplete="url" />
          </label>

          <label className="field">
            Builder address
            <input
              type="text"
              value={builder}
              onChange={(e) => {
                setBuilder(e.currentTarget.value);
                setSigner(null);
              }}
              placeholder="0x…"
              className="mono"
              spellCheck={false}
              aria-invalid={builderProblem !== null}
              aria-describedby="builder-hint"
            />
            <span id="builder-hint" className="hint">
              {builderProblem ? (
                <span className="down">{builderProblem}</span>
              ) : (
                "The address that receives your builder fee on mainnet. It rides on every order."
              )}
            </span>
          </label>

          {injected() ? (
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button type="button" className="btn ghost sm" onClick={() => void useConnectedWallet()}>
                Use connected wallet
              </button>
              <span className="hint">
                {signer ? "You will be asked to sign one message, which verifies you control this address." : "Using the connected wallet lets you verify the address in one signature."}
              </span>
            </div>
          ) : null}

          {error ? (
            <div className="note warn" role="alert">
              {error}
            </div>
          ) : null}

          <button type="submit" className="btn" disabled={busy || !name.trim() || !builder.trim() || builderProblem !== null}>
            {busy ? "Registering…" : "Register"}
          </button>
        </form>
      </div>
    </main>
  );
}
