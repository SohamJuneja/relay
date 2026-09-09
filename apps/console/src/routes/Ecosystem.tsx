// The DreamDEX venue's public data page.
//
// No key, no account: this is the argument that Relay's indexer is a product in its
// own right. Everything on it is derived from Somnia logs by our own ingest, and the
// numbers that matter most — how many windows were quoted and never taken — are ones
// nobody else is publishing.

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, wsUrl, type Market } from "../api";
import { API_URL } from "../config";
import { count, countdown, intervalLabel, localTime, oraclePrice, pct, prob, shortAddr, tusdc, usd, utcTime } from "../format";
import { TimeBars } from "../components/Chart";
import { AddrLink, Empty, ErrorState, Kpi, KpiSkeleton, Kpis, Skeleton, TableSkeleton, Term } from "../components/ui";

const ZERO_FILL_DEF = "A completed window (its expiry has passed) with no OrderFilled event at all.";
const UNTAKEN_DEF =
  "A zero-fill window that had at least one resting bid AND one resting ask: liquidity was offered on both sides and nobody took it. This is the interesting half of zero-fill — the market was tradeable and went untraded.";

const SPANS = [
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "2d", hours: 48 },
] as const;

export function Ecosystem() {
  const [span, setSpan] = useState<number>(24);
  const overview = useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: 15_000 });
  const venueId = overview.data?.venueId;

  const series = useQuery({
    queryKey: ["venueWindow", venueId, span],
    queryFn: () => api.venueWindow(venueId!, span),
    enabled: !!venueId,
  });
  const hourly = useQuery({
    queryKey: ["hourly", venueId],
    queryFn: () => api.hourly(venueId!, 24),
    enabled: !!venueId,
    refetchInterval: 60_000,
  });
  const builders = useQuery({ queryKey: ["builders"], queryFn: () => api.builders(24), refetchInterval: 60_000 });
  const recent = useQuery({ queryKey: ["recentMarkets"], queryFn: () => api.recentMarkets(8), refetchInterval: 30_000 });

  return (
    <main className="wide">
      <div className="stack">
        <div>
          <h1>DreamDEX Event Contracts — public venue data</h1>
          <p className="lede" style={{ marginTop: 10 }}>
            Every number below is read from Somnia by Relay's own indexer: market lifecycle, order books, fills and
            builder attribution, straight from the logs. No account, no key.
          </p>
        </div>

        {overview.isPending ? (
          <KpiSkeleton count={6} />
        ) : overview.error ? (
          <ErrorState error={overview.error} what="the venue overview" retry={() => void overview.refetch()} />
        ) : overview.data ? (
          <Kpis>
            <Kpi label="Markets (24h)" value={count(overview.data.markets24h)} />
            <Kpi label="Fills (24h)" value={count(overview.data.fills24h)} />
            <Kpi label="Notional (24h)" value={usd(overview.data.notional24h, 0)} sub="tUSDC" />
            <Kpi label="Unique takers (24h)" value={count(overview.data.uniqueTakers24h)} />
            <Kpi label="Zero-fill windows" value={pct(overview.data.zeroFillPct24h)} sub="of completed windows" title={ZERO_FILL_DEF} />
            <Kpi label="Quoted but untaken" value={pct(overview.data.quotedButUntakenPct24h)} sub="offered and refused" title={UNTAKEN_DEF} />
            <Kpi label="Live markets" value={count(overview.data.liveMarkets)} />
            <Kpi
              label="Indexer lag"
              value={overview.data.lagBlocks === null ? "—" : overview.data.lagBlocks === 0 ? "at head" : `${count(overview.data.lagBlocks)} blk`}
              sub={
                overview.data.lagBlocks === null
                  ? undefined
                  : overview.data.lagBlocks === 0
                    ? "caught up with the chain"
                    : `≈ ${(overview.data.lagBlocks * 0.1).toFixed(1)}s behind head`
              }
              title={`cursor ${overview.data.cursorBlock ?? "—"} · head ${overview.data.headBlock}`}
            />
          </Kpis>
        ) : null}

        <div className="card">
          <header>
            <h2>Hourly flow, and what went untaken</h2>
            <span className="muted" style={{ fontSize: 11.5 }}>last 24 hours</span>
          </header>
          {hourly.isPending || !venueId ? (
            <Skeleton height={190} />
          ) : hourly.error ? (
            <ErrorState error={hourly.error} what="hourly stats" retry={() => void hourly.refetch()} />
          ) : (
            <>
              {/* Two measures on one time axis, stacked rather than overlaid: money and
                  a window count share no unit, and a second y-axis invites the reader to
                  compare two things that cannot be compared. They keep the same x range
                  so a spike in one lines up with the hour beneath it. */}
              <div className="legend" style={{ marginBottom: 8 }}>
                <span>
                  <span className="sw" style={{ background: "var(--up)" }} />
                  Routed notional, tUSDC
                </span>
                <span>
                  <span className="sw" style={{ background: "var(--down)" }} />
                  Quoted-but-untaken windows
                </span>
              </div>
              <TimeBars
                xs={hourly.data!.rows.map((r) => r.hourTs)}
                series={[{ label: "Routed notional, tUSDC", values: hourly.data!.rows.map((r) => r.notional), colorVar: "--up", fallback: "#067a55" }]}
                fmt={(n) => tusdc(n, n >= 100 ? 0 : 1)}
                yLabel="tUSDC"
                ariaLabel="Routed notional per hour over the last 24 hours, in tUSDC"
              />
              <div style={{ marginTop: 10 }}>
                <TimeBars
                  xs={hourly.data!.rows.map((r) => r.hourTs)}
                  series={[{ label: "Quoted-but-untaken windows", values: hourly.data!.rows.map((r) => r.quotedButUntakenWindows), colorVar: "--down", fallback: "#c8291f" }]}
                  height={120}
                  fmt={(n) => String(Math.round(n))}
                  yLabel="windows"
                  ariaLabel="Quoted but untaken windows per hour over the last 24 hours"
                />
              </div>
            </>
          )}
        </div>

        <div className="card">
          <header>
            <h2>Liquidity by series</h2>
            <div className="seg" role="group" aria-label="Window">
              {SPANS.map((s) => (
                <button key={s.label} type="button" aria-pressed={span === s.hours} onClick={() => setSpan(s.hours)}>
                  {s.label}
                </button>
              ))}
            </div>
          </header>
          <p className="hint" style={{ marginBottom: 10 }}>
            <Term title={ZERO_FILL_DEF}>Zero-fill</Term> is a completed window with no trade.{" "}
            <Term title={UNTAKEN_DEF}>Quoted but untaken</Term> is the subset that had resting liquidity on both sides.
          </p>
          {series.isPending || !venueId ? (
            <TableSkeleton rows={5} cols={7} />
          ) : series.error ? (
            <ErrorState error={series.error} what="the liquidity table" retry={() => void series.refetch()} />
          ) : series.data!.rows.length === 0 ? (
            <Empty>No completed windows in this span.</Empty>
          ) : (
            <div className="tablewrap">
              <table>
                <caption className="sr">Zero-fill and quoted-but-untaken windows by series</caption>
                <thead>
                  <tr>
                    <th scope="col">Series</th>
                    <th scope="col" className="num">Windows</th>
                    <th scope="col" className="num">Fills</th>
                    <th scope="col" className="num">Notional</th>
                    <th scope="col" className="num">Takers</th>
                    <th scope="col" className="num" title={ZERO_FILL_DEF}>Zero-fill</th>
                    <th scope="col" className="num" title={UNTAKEN_DEF}>Quoted, untaken</th>
                  </tr>
                </thead>
                <tbody>
                  {series.data!.rows.map((r) => (
                    <tr key={`${r.asset}-${r.intervalSec}`} tabIndex={0}>
                      <td>
                        <b>{r.asset}</b> {intervalLabel(r.intervalSec)}
                      </td>
                      <td className="num">{count(r.windows)}</td>
                      <td className="num">{count(r.fills)}</td>
                      <td className="num">{usd(r.notional, 2)}</td>
                      <td className="num">{count(r.uniqueTakers)}</td>
                      <td className="num">{pct(r.zeroFillPct)}</td>
                      <td className="num down">{pct(r.quotedButUntakenPct)}</td>
                    </tr>
                  ))}
                  {series.data!.total ? (
                    <tr style={{ fontWeight: 700 }}>
                      <td>All</td>
                      <td className="num">{count(series.data!.total.windows)}</td>
                      <td className="num">{count(series.data!.total.fills)}</td>
                      <td className="num">{usd(series.data!.total.notional, 2)}</td>
                      <td className="num">—</td>
                      <td className="num">{pct(series.data!.total.zeroFillPct)}</td>
                      <td className="num down">{pct(series.data!.total.quotedButUntakenPct)}</td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <LiveMarkets />

        <div className="card">
          <header>
            <h2>Recently settled</h2>
          </header>
          {recent.isPending ? (
            <Skeleton height={40} />
          ) : recent.data && recent.data.length > 0 ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {recent.data.map((m) => (
                <div
                  key={m.marketId}
                  className="card"
                  style={{ padding: "8px 12px", minWidth: 118, borderColor: m.winner === "UP" ? "color-mix(in srgb, var(--up) 30%, var(--line))" : "color-mix(in srgb, var(--down) 30%, var(--line))" }}
                  title={`${m.asset} ${intervalLabel(m.intervalSec)} · settled ${utcTime(m.expiry)}`}
                >
                  <div style={{ fontSize: 11, color: "var(--ink-3)" }}>
                    {m.asset} {intervalLabel(m.intervalSec)}
                  </div>
                  <div className={m.winner === "UP" ? "up" : "down"} style={{ fontWeight: 700, fontSize: 13 }}>
                    {m.voided ? "VOID" : (m.winner ?? "—")}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--ink-3)" }}>{oraclePrice(m.closingPriceRaw)}</div>
                </div>
              ))}
            </div>
          ) : (
            <Empty>Nothing settled recently.</Empty>
          )}
        </div>

        <div className="card">
          <header>
            <h2>Builder leaderboard</h2>
            <span className="muted" style={{ fontSize: 11.5 }}>last 24 hours</span>
          </header>
          <p className="hint" style={{ marginBottom: 10 }}>
            Every builder code seen on a fill, registered with Relay or not. The builder code is how a venue pays whoever
            brought the order.
          </p>
          {builders.isPending ? (
            <TableSkeleton rows={3} cols={6} />
          ) : builders.error ? (
            <ErrorState error={builders.error} what="the leaderboard" retry={() => void builders.refetch()} />
          ) : builders.data!.builders.length === 0 ? (
            <Empty>No builder-tagged fills in the last 24 hours.</Empty>
          ) : (
            <div className="tablewrap">
              <table data-testid="builder-leaderboard">
                <caption className="sr">Builder addresses seen on fills in the last 24 hours</caption>
                <thead>
                  <tr>
                    <th scope="col">Builder</th>
                    <th scope="col">Partner</th>
                    <th scope="col" className="num">Fills</th>
                    <th scope="col" className="num">Notional</th>
                    <th scope="col" className="num">Wallets</th>
                    <th scope="col">Last seen</th>
                  </tr>
                </thead>
                <tbody>
                  {builders.data!.builders.map((b) => (
                    <tr key={b.builder} tabIndex={0}>
                      <td>
                        <AddrLink address={b.builder} label={shortAddr(b.builder, 6)} />
                      </td>
                      <td>
                        {b.partnerName ? (
                          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
                            {b.partnerName}
                            {b.verified ? (
                              <span className="up" style={{ fontSize: 10.5, fontWeight: 700 }} title="Signed for this builder address">
                                verified
                              </span>
                            ) : null}
                          </span>
                        ) : (
                          <span className="muted">unregistered</span>
                        )}
                      </td>
                      <td className="num">{count(b.fills)}</td>
                      <td className="num">{usd(b.notional, 3)}</td>
                      <td className="num">{count(b.wallets)}</td>
                      <td title={utcTime(b.lastSeen)}>{localTime(b.lastSeen)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <DataAndApi venueId={venueId} />
      </div>
    </main>
  );
}

/** Live markets, refreshed from the socket's lifecycle events plus a slow poll. */
function LiveMarkets() {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const live = useQuery({ queryKey: ["liveMarkets"], queryFn: () => api.liveMarkets(12), refetchInterval: 10_000 });
  const refetch = useRef(live.refetch);
  refetch.current = live.refetch;

  useEffect(() => {
    const t = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(t);
  }, []);

  // The socket tells us when a window opens or closes; the book itself is polled,
  // because a table of twelve books does not need to redraw on every tick.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    try {
      ws = new WebSocket(wsUrl());
    } catch {
      return;
    }
    ws.onopen = () => ws?.send(JSON.stringify({ subscribe: { all: true } }));
    ws.onmessage = (ev) => {
      try {
        const m = JSON.parse(String(ev.data)) as { type: string };
        if (m.type === "market_created" || m.type === "market_locked" || m.type === "market_resolved") void refetch.current();
      } catch {
        /* ignore */
      }
    };
    return () => {
      closed = true;
      void closed;
      ws?.close();
    };
  }, []);

  const rows: Market[] = live.data ?? [];
  const depth = (m: Market) => {
    const b = (m.book?.yesBids ?? []).reduce((s, l) => s + l.quantity, 0);
    const a = (m.book?.yesAsks ?? []).reduce((s, l) => s + l.quantity, 0);
    return b + a;
  };

  return (
    <div className="card">
      <header>
        <h2>Live markets</h2>
        <span className="muted" style={{ fontSize: 11.5 }}>updates as windows open and close</span>
      </header>
      {live.isPending ? (
        <TableSkeleton rows={6} cols={7} />
      ) : live.error ? (
        <ErrorState error={live.error} what="live markets" retry={() => void live.refetch()} />
      ) : rows.length === 0 ? (
        <Empty>No markets are trading right now.</Empty>
      ) : (
        <div className="tablewrap">
          <table>
            <caption className="sr">Markets currently trading, with best bid and ask</caption>
            <thead>
              <tr>
                <th scope="col">Asset</th>
                <th scope="col">Window</th>
                <th scope="col" className="num">Expires in</th>
                <th scope="col" className="num">Best bid</th>
                <th scope="col" className="num">Best ask</th>
                <th scope="col" className="num">Spread</th>
                <th scope="col" className="num">Depth</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr key={m.marketId} tabIndex={0}>
                  <td>
                    <b>{m.asset}</b>
                  </td>
                  <td>{intervalLabel(m.intervalSec)}</td>
                  <td className="num" title={utcTime(m.expiry)}>
                    {countdown(m.expiry - now)}
                  </td>
                  <td className="num up">{prob(m.book?.bestBid ?? null)}</td>
                  <td className="num down">{prob(m.book?.bestAsk ?? null)}</td>
                  <td className="num">{m.book?.spread === null || m.book?.spread === undefined ? "—" : prob(m.book.spread)}</td>
                  <td className="num">{tusdc(depth(m), 1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function DataAndApi(props: { venueId: string | undefined }) {
  const v = props.venueId ?? "0x…";
  const examples = [
    `curl ${API_URL}/v1/stats/overview`,
    `curl "${API_URL}/v1/markets/live?book=true&limit=5"`,
    `curl "${API_URL}/v1/stats/venue/${v}/hourly?hours=24"`,
  ];
  return (
    <div className="card">
      <header>
        <h2>Data &amp; API</h2>
        <a href={`${API_URL}/docs`} target="_blank" rel="noreferrer noopener">
          OpenAPI reference
        </a>
      </header>
      <p style={{ fontSize: 13, color: "var(--ink-2)" }}>
        Everything on this page is a public REST call, and there is a WebSocket at{" "}
        <code className="inline">/v1/stream</code> for books, fills and market lifecycle. The indexer reads Somnia
        directly — it does not depend on DreamDEX's own indexer.
      </p>
      <pre className="snippet" style={{ marginTop: 10 }}>
        {examples.join("\n")}
      </pre>
    </div>
  );
}
