// "Try your snippet" — the widget, with your own partner id and builder address, on a
// page you did not have to build.
//
// Before this existed, checking that your attribution actually worked meant creating a
// local HTML file, discovering that `file://` cannot fetch the API, working out that
// you need a static server, and only then seeing the card. Three steps of yak-shaving
// between registering and believing it.

import { useState } from "react";
import { Link } from "react-router-dom";
import { CDN_URL, DEMO_BUILDER, DEMO_PARTNER_ID, embedSnippet } from "../config";
import { CopyButton } from "../components/ui";
import { WidgetPreview } from "../components/WidgetPreview";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

export function Try() {
  const [partner, setPartner] = useState(String(DEMO_PARTNER_ID));
  const [builder, setBuilder] = useState(DEMO_BUILDER);
  const [asset, setAsset] = useState("BTC");
  const [intervalSec, setIntervalSec] = useState(900);

  const partnerId = Number(partner);
  const partnerOk = Number.isInteger(partnerId) && partnerId > 0;
  const builderOk = ADDRESS.test(builder.trim());
  const ready = partnerOk && builderOk;
  const snippet = ready ? embedSnippet(partnerId, builder.trim()) : "";

  return (
    <main>
      <div className="stack">
        <div>
          <h1>Try your snippet.</h1>
          <p className="lede" style={{ marginTop: 10 }}>
            Put your partner id and builder address in, and the real widget mounts below with them. Every trade you make
            here settles on Shannon testnet and is attributed to that partner — so you can watch it appear on your
            dashboard before you paste anything into your own site.
          </p>
        </div>

        <div className="card">
          <header>
            <h2>Your details</h2>
            <span className="muted" style={{ fontSize: 11.5 }}>from the register page</span>
          </header>

          <div className="split fields">
            <label className="field">
              <span>Partner id</span>
              <input value={partner} onChange={(e) => setPartner(e.target.value)} inputMode="numeric" placeholder="8" />
              {partner && !partnerOk ? <span className="hint" data-tone="warn">A partner id is a positive whole number.</span> : null}
            </label>
            <label className="field">
              <span>Builder address</span>
              <input value={builder} onChange={(e) => setBuilder(e.target.value)} spellCheck={false} placeholder="0x…" />
              {builder && !builderOk ? <span className="hint" data-tone="warn">That is not a 20-byte address.</span> : null}
            </label>
          </div>

          <div className="row" style={{ gap: "var(--s2)", marginTop: "var(--s3)" }}>
            {(["BTC", "ETH"] as const).map((a) => (
              <button key={a} type="button" className="btn sm" data-variant={asset === a ? undefined : "ghost"} onClick={() => setAsset(a)}>
                {a}
              </button>
            ))}
            {([300, 900, 3600] as const).map((s) => (
              <button key={s} type="button" className="btn sm" data-variant={intervalSec === s ? undefined : "ghost"} onClick={() => setIntervalSec(s)}>
                {s === 300 ? "5m" : s === 900 ? "15m" : "1h"}
              </button>
            ))}
          </div>
        </div>

        {ready ? (
          <div className="split snippet">
            <div className="card">
              <header>
                <h2>Your snippet</h2>
                <CopyButton text={snippet} label="Copy snippet" />
              </header>
              <pre className="snippet" data-testid="try-snippet">
                {snippet}
              </pre>
              <p className="note" style={{ marginTop: "var(--s3)" }}>
                <strong>Serve it over http, not <code>file://</code>.</strong> A page opened straight from disk has a
                null origin, so the browser blocks its requests to the Relay API and the card never loads — which looks
                exactly like a broken snippet and is not one. Any static server will do:{" "}
                <code>npx serve .</code> or <code>python -m http.server</code>, then open the <code>http://localhost:…</code>{" "}
                URL it prints.
              </p>
            </div>

            <div className="stack tight">
              <h3>What your readers will see</h3>
              <p className="hint">
                Mounted with partner {partnerId}, against the live venue. The script above loads the same bundle from{" "}
                <code>{CDN_URL}</code>.
              </p>
              <WidgetPreview partner={partnerId} builder={builder.trim()} asset={asset} intervalSec={intervalSec} surface="web" />
              <p className="hint">
                Trades here are real on testnet. After one fills, it shows on{" "}
                <Link to="/dashboard">your dashboard</Link> and on the{" "}
                <Link to="/ecosystem">ecosystem leaderboard</Link>.
              </p>
            </div>
          </div>
        ) : (
          <div className="card">
            <p className="hint">Fill in a partner id and a builder address to mount the widget.</p>
          </div>
        )}

        <p className="hint">
          No partner id yet? <Link to="/register">Register one</Link> — two fields, and you get an id, a key and a
          snippet with both filled in.
        </p>
      </div>
    </main>
  );
}
