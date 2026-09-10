// The page a prospective partner lands on.
//
// The argument is made by putting the working product next to the two lines that
// produce it. Everything else is one sentence of context and three facts.

import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { API_URL, embedSnippet, DEMO_BUILDER, DEMO_PARTNER_ID } from "../config";
import { count, usd } from "../format";
import { CopyButton, Skeleton } from "../components/ui";
import { WidgetPreview } from "../components/WidgetPreview";


const SNIPPET = embedSnippet(1, "0xYourBuilderAddress");

export function Landing() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: 15_000 });

  return (
    <main>
      <div className="stack">
        <div className="split">
          <div className="stack">
            <div>
              <h1>Put a prediction market on your page in two lines.</h1>
              <p className="lede" style={{ marginTop: 12 }}>
                Relay routes order flow into DreamDEX Event Contracts on Somnia and tags every order with your builder
                code, on chain. Your readers trade "will BTC be up at the close of this window" without leaving your
                site; you get credited for the flow you sent.
              </p>
            </div>

            <div className="card">
              <header>
                <h2>The whole integration</h2>
                <CopyButton text={SNIPPET} label="Copy snippet" />
              </header>
              <pre className="snippet">{SNIPPET}</pre>
              <p className="hint" style={{ marginTop: 10 }}>
                The card renders into its own shadow root, so your CSS cannot reach in and its cannot leak out. Swap in
                your partner id and builder address after you register.
              </p>
            </div>

            <div className="three">
              <div className="card">
                <h3>Attribution on chain</h3>
                <p style={{ marginTop: 8, fontSize: 13, color: "var(--ink-2)" }}>
                  Every order carries a 64-bit tag with your partner id and surface, readable straight off the
                  <code className="inline" style={{ margin: "0 4px" }}>
                    OrderPlaced
                  </code>
                  log, plus your builder address on the fill. Nobody has to trust our database.
                </p>
              </div>
              <div className="card">
                <h3>Your fees at the mainnet cap</h3>
                <p style={{ marginTop: 8, fontSize: 13, color: "var(--ink-2)" }}>
                  Mainnet pools cap the builder fee at 1%. The dashboard projects what your flow would have earned at
                  that cap, labelled as a projection — on this testnet the cap is 0, so tagged orders cost your readers
                  nothing today.
                </p>
              </div>
              <div className="card">
                <h3>A public API</h3>
                <p style={{ marginTop: 8, fontSize: 13, color: "var(--ink-2)" }}>
                  Markets, books, fills and venue liquidity stats, from an indexer that reads Somnia directly.{" "}
                  <Link to="/ecosystem">See the data</Link> or <a href={`${API_URL}/docs`}>read the reference</a>.
                </p>
              </div>
            </div>

            <div className="row-between">
              <Link to="/register" className="btn plain" style={{ textDecoration: "none" }}>
                Get your snippet
              </Link>
              <span className="muted" style={{ fontSize: 12.5 }}>
                {overview.isPending ? (
                  <Skeleton width="220px" height={12} />
                ) : overview.data ? (
                  <>
                    {count(overview.data.fills24h)} fills · {usd(overview.data.notional24h, 0)} routed on this venue in
                    the last 24 hours
                  </>
                ) : null}
              </span>
            </div>
          </div>

          <div className="stack tight">
            <h3>Live, on this page</h3>
            <WidgetPreview partner={DEMO_PARTNER_ID} builder={DEMO_BUILDER} asset="BTC" intervalSec={900} surface="web" />
            <p className="hint">
              This is the real widget, mounted with partner {DEMO_PARTNER_ID}. Trades placed here settle on Shannon
              testnet.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}
