// The page a prospective partner lands on.
//
// It opens on the finding rather than on a product claim. "Put a market on your page"
// is a thing we want; "a fifth of these markets go untraded while fully quoted" is a
// thing that is true about their market, and it is the reason the product exists. The
// number is live, so the argument is never older than fifteen seconds.
//
// Everything below that is the proof: the two lines that fix it, the working widget
// beside them, and three facts.

import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "../api";
import { API_URL, embedSnippet, DEMO_BUILDER, DEMO_PARTNER_ID } from "../config";
import { count, pct, usd } from "../format";
import { CopyButton, Skeleton } from "../components/ui";
import { WidgetPreview } from "../components/WidgetPreview";

const SNIPPET = embedSnippet(1, "0xYourBuilderAddress");

export function Landing() {
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: 15_000 });
  const untaken = overview.data?.quotedButUntakenPct24h;

  return (
    <main>
      <div className="stack">
        <div className="split">
          <div className="stack">
            <div className="stack tight">
              <span className="eyebrow">Live from Somnia · last 24 hours</span>

              {/* The headline is the measurement. It re-reads itself every fifteen
                  seconds, so it cannot drift away from the table it is drawn from. */}
              <p className="figure">
                {overview.isPending ? <Skeleton width="4ch" height={64} /> : untaken === undefined ? "—" : pct(untaken)}
              </p>
              <h1 style={{ maxWidth: "18ch" }}>of this venue's markets go untraded.</h1>

              <p className="lede" style={{ marginTop: 4 }}>
                Not because nobody could trade them. Market makers quoted <strong>both sides</strong> of every one of
                those windows, the whole time, and nobody showed up. That is not a liquidity problem — it is a
                distribution problem.
              </p>
              <p className="lede">
                Relay is two lines of HTML that put a live, tradeable market inside somebody else's page, and credit
                whoever sent the order on chain, inside the order itself.
              </p>
            </div>

            <div className="card raised">
              <header>
                <h2>The whole integration</h2>
                <CopyButton text={SNIPPET} label="Copy snippet" />
              </header>
              <pre className="snippet">{SNIPPET}</pre>
              <p className="hint" style={{ marginTop: 12 }}>
                The card renders into its own shadow root, so your CSS cannot reach in and its cannot leak out. Swap in
                your partner id and builder address after you register.
              </p>
            </div>

            <div className="three">
              <div className="card">
                <h3>Attribution on chain</h3>
                <p style={{ marginTop: 10, fontSize: 13, color: "var(--ink-2)" }}>
                  Every order carries a 64-bit tag with your partner id and surface, readable straight off the
                  <code className="inline" style={{ margin: "0 4px" }}>
                    OrderPlaced
                  </code>
                  log, plus your builder address on the fill. Nobody has to trust our database.
                </p>
              </div>
              <div className="card">
                <h3>Your fees at the mainnet cap</h3>
                <p style={{ marginTop: 10, fontSize: 13, color: "var(--ink-2)" }}>
                  Mainnet pools cap the builder fee at 1%. The dashboard projects what your flow would have earned at
                  that cap, labelled as a projection — on this testnet the cap is 0, so tagged orders cost your readers
                  nothing today.
                </p>
              </div>
              <div className="card">
                <h3>A public API</h3>
                <p style={{ marginTop: 10, fontSize: 13, color: "var(--ink-2)" }}>
                  Markets, books, fills and venue liquidity stats, from an indexer that reads Somnia directly.{" "}
                  <Link to="/ecosystem">See the data</Link> or <a href={`${API_URL}/docs`}>read the reference</a>.
                </p>
              </div>
            </div>

            <div className="row-between">
              <Link to="/register" className="btn plain" style={{ textDecoration: "none" }}>
                Get your snippet
              </Link>
              <span className="muted mono" style={{ fontSize: 11.5, letterSpacing: "0.04em" }}>
                {overview.isPending ? (
                  <Skeleton width="240px" height={12} />
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
