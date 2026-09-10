// What one partner routed.
//
// Everything on this page is scoped by the API key: the server decides what the key
// can see, so a partner cannot read another's flow by changing a number in the URL.
// A 401 anywhere sends the reader back to the key prompt rather than showing an
// empty dashboard that looks like "you have no fills".

import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Unauthorized, api, wsUrl, type Fill } from "../api";
import { embedSnippet } from "../config";
import { clearSession, loadSession, saveSession, type Session } from "../session";
import { count, intervalLabel, localTime, prob, pct, shortAddr, tusdc, usd, utcTime } from "../format";
import { CategoryBars, TimeBars } from "../components/Chart";
import { VerifiedBadge } from "../components/VerifiedBadge";
import { CopyButton, Empty, ErrorState, Kpi, KpiSkeleton, Kpis, Skeleton, TableSkeleton, TxLink } from "../components/ui";

const RANGES = [
  { label: "6h", hours: 6 },
  { label: "24h", hours: 24 },
  { label: "7d", hours: 168 },
  { label: "all", hours: 24 * 90 },
] as const;

export function Dashboard() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  if (!session) return <KeyPrompt onReady={setSession} />;
  return <PartnerView session={session} onSignOut={() => { clearSession(); setSession(null); }} />;
}

// ── the key prompt ────────────────────────────────────────────────────────

function KeyPrompt(props: { onReady: (s: Session) => void }) {
  const [partnerId, setPartnerId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const id = Number(partnerId);
    if (!Number.isInteger(id) || id <= 0) return setError("Partner id is the number you were given at registration.");
    setBusy(true);
    try {
      // Verify before storing: a key that does not work should fail here, at the
      // one place the reader can do something about it.
      await api.partnerStats(id, apiKey.trim(), 24);
      const s = { partnerId: id, apiKey: apiKey.trim() };
      saveSession(s);
      props.onReady(s);
    } catch (err) {
      setError(err instanceof Unauthorized ? "That key is not valid for that partner id." : (err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <div className="stack" style={{ maxWidth: 460 }}>
        <div>
          <h1>Your dashboard</h1>
          <p className="lede" style={{ marginTop: 10 }}>
            Paste the API key you were given at registration. It is kept for this browser tab only.
          </p>
        </div>
        <form className="card stack tight" onSubmit={submit}>
          <label className="field">
            Partner id
            <input type="text" inputMode="numeric" value={partnerId} onChange={(e) => setPartnerId(e.currentTarget.value)} placeholder="1" />
          </label>
          <label className="field">
            API key
            <input type="password" value={apiKey} onChange={(e) => setApiKey(e.currentTarget.value)} placeholder="rk_…" className="mono" autoComplete="off" spellCheck={false} />
          </label>
          {error ? (
            <div className="note warn" role="alert">
              {error}
            </div>
          ) : null}
          <button type="submit" className="btn" disabled={busy || !partnerId || !apiKey}>
            {busy ? "Checking…" : "Open dashboard"}
          </button>
          <p className="hint">
            No key yet? <Link to="/register">Register a partner</Link> — it takes two fields.
          </p>
        </form>
      </div>
    </main>
  );
}

// ── the dashboard ─────────────────────────────────────────────────────────

function PartnerView(props: { session: Session; onSignOut: () => void }) {
  const { partnerId, apiKey } = props.session;
  const qc = useQueryClient();
  const [hours, setHours] = useState<number>(24);
  const [liveFills, setLiveFills] = useState<Fill[]>([]);
  const freshIds = useRef<Set<number>>(new Set());

  const stats = useQuery({ queryKey: ["stats", partnerId, hours], queryFn: () => api.partnerStats(partnerId, apiKey, hours), refetchInterval: 20_000 });
  const breakdown = useQuery({ queryKey: ["breakdown", partnerId, hours], queryFn: () => api.breakdown(partnerId, apiKey, hours) });
  const share = useQuery({ queryKey: ["share", partnerId, hours], queryFn: () => api.share(partnerId, apiKey, hours), refetchInterval: 60_000 });
  const fills = useQuery({ queryKey: ["fills", partnerId], queryFn: () => api.partnerFills(partnerId, apiKey, 50), refetchInterval: 30_000 });

  const unauthorized = [stats, breakdown, share, fills].some((q) => q.error instanceof Unauthorized);
  useEffect(() => {
    if (unauthorized) props.onSignOut();
  }, [unauthorized, props]);

  // Live fills. The socket sends every fill on the venue; this page only cares about
  // the ones tagged for this partner, and the filter is here rather than in the
  // subscription because the stream is public and does not know who is watching.
  useEffect(() => {
    let ws: WebSocket | null = null;
    let closed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = () => {
      if (closed) return;
      try {
        ws = new WebSocket(wsUrl());
      } catch {
        retry();
        return;
      }
      ws.onopen = () => {
        attempt = 0;
        ws?.send(JSON.stringify({ subscribe: { all: true } }));
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data)) as { type: string; data: Fill };
          if (msg.type !== "fill" || msg.data.takerPartnerId !== partnerId) return;
          freshIds.current.add(msg.data.id);
          setLiveFills((prev) => (prev.some((f) => f.id === msg.data.id) ? prev : [msg.data, ...prev].slice(0, 50)));
          // A new fill changes every headline number, so pull them again.
          void qc.invalidateQueries({ queryKey: ["stats", partnerId] });
          void qc.invalidateQueries({ queryKey: ["share", partnerId] });
          void qc.invalidateQueries({ queryKey: ["breakdown", partnerId] });
        } catch {
          /* a malformed frame is not worth tearing the socket down */
        }
      };
      ws.onclose = () => {
        ws = null;
        retry();
      };
      ws.onerror = () => ws?.close();
    };
    const retry = () => {
      if (closed || timer) return;
      timer = setTimeout(() => {
        timer = null;
        connect();
      }, Math.min(15_000, 500 * 2 ** attempt++));
    };
    connect();
    return () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ws?.close();
    };
  }, [partnerId, qc]);

  // Live rows first, then the fetched page, de-duplicated by id.
  const rows = useMemo(() => {
    const seen = new Set<number>();
    const out: Fill[] = [];
    for (const f of [...liveFills, ...(fills.data ?? [])]) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(f);
    }
    return out.slice(0, 50);
  }, [liveFills, fills.data]);

  // The chart reads the breakdown's live hourly series, not the materialised stats
  // table: those refresh a minute apart, and a chart saying "no fills in this window"
  // beside a KPI saying "1 fill" is worse than a chart that is a second behind.
  const hourly = breakdown.data?.byHour ?? [];
  const hasData = (stats.data?.fills ?? 0) > 0;

  return (
    <main className="wide">
      <div className="stack">
        <div className="row-between">
          <div>
            <h1>{stats.data?.name ?? `Partner ${partnerId}`}</h1>
            <p className="muted" style={{ fontSize: 12.5, marginTop: 4, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <span>
                partner {partnerId} · builder <span className="mono">{stats.data?.builderAddress ?? "…"}</span>
              </span>
              {stats.data ? (
                <VerifiedBadge
                  partnerId={partnerId}
                  apiKey={apiKey}
                  builderAddress={stats.data.builderAddress}
                  verified={stats.data.verified}
                  onVerified={() => void stats.refetch()}
                />
              ) : null}
            </p>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <div className="seg" role="group" aria-label="Time range">
              {RANGES.map((r) => (
                <button key={r.label} type="button" aria-pressed={hours === r.hours} onClick={() => setHours(r.hours)}>
                  {r.label}
                </button>
              ))}
            </div>
            <button type="button" className="btn ghost sm" onClick={props.onSignOut}>
              Sign out
            </button>
          </div>
        </div>

        {stats.isPending ? (
          <KpiSkeleton count={6} />
        ) : stats.error ? (
          <ErrorState error={stats.error} what="your stats" retry={() => void stats.refetch()} />
        ) : stats.data ? (
          <Kpis>
            <Kpi label="Fills" value={count(stats.data.fills)} />
            <Kpi label="Notional routed" value={usd(stats.data.notional)} sub="tUSDC, taker side" />
            <Kpi label="Unique wallets" value={count(stats.data.uniqueWallets)} />
            <Kpi label="Markets touched" value={count(stats.data.marketsTouched)} />
            <Kpi
              label="Share of venue flow"
              value={share.data ? pct(share.data.sharePct) : <Skeleton width="60%" height={22} />}
              sub={share.data ? `${usd(share.data.partnerNotional, 2)} of ${usd(share.data.venueNotional, 0)}` : undefined}
              title="This partner's taker notional over the window, against every taker fill on the venue in the same window — tagged or not."
            />
            <Kpi
              label="Projected builder fee"
              value={usd(stats.data.projectedBuilderFee)}
              sub={`projection · taker-side × ${stats.data.projectedBuilderFeeBps} bps · testnet cap is 0`}
              title={stats.data.projectionNote}
            />
          </Kpis>
        ) : null}

        {!stats.isPending && !hasData ? <FirstFill partnerId={partnerId} builder={stats.data?.builderAddress ?? "0x…"} /> : null}

        <div className="split" style={{ gridTemplateColumns: "minmax(0, 1.4fr) minmax(280px, 1fr)" }}>
          <div className="card">
            <header>
              <h2>Routed notional per {(breakdown.data?.bucketSec ?? 3600) >= 86400 ? "day" : "hour"}</h2>
              <span className="muted" style={{ fontSize: 11.5 }}>tUSDC</span>
            </header>
            {breakdown.isPending ? (
              <Skeleton height={190} />
            ) : hourly.length === 0 ? (
              <Empty>No fills in this window yet.</Empty>
            ) : (
              <TimeBars
                xs={hourly.map((h) => h.hourTs)}
                bucketSec={breakdown.data?.bucketSec ?? 3600}
                series={[{ label: "notional", values: hourly.map((h) => h.notional), colorVar: "--up", fallback: "#067a55" }]}
                fmt={(n) => tusdc(n, n >= 100 ? 0 : 2)}
                ariaLabel="Routed notional per hour"
              />
            )}
          </div>

          <div className="stack tight">
            <div className="card">
              <header>
                <h2>By surface</h2>
              </header>
              {breakdown.isPending ? (
                <Skeleton count={2} height={12} />
              ) : breakdown.data && breakdown.data.bySurface.length > 0 ? (
                <CategoryBars
                  rows={breakdown.data.bySurface.map((s) => ({ label: s.name, value: s.notional, sub: `${s.fills} fills` }))}
                  fmt={(n) => usd(n, 2)}
                  ariaLabel="Notional by surface"
                />
              ) : (
                <Empty>Nothing yet.</Empty>
              )}
            </div>
            <div className="card">
              <header>
                <h2>By series</h2>
              </header>
              {breakdown.isPending ? (
                <Skeleton count={3} height={12} />
              ) : breakdown.data && breakdown.data.bySeries.length > 0 ? (
                <CategoryBars
                  rows={breakdown.data.bySeries.map((s) => ({ label: `${s.asset} ${intervalLabel(s.intervalSec)}`, value: s.notional, sub: `${s.fills} fills` }))}
                  fmt={(n) => usd(n, 2)}
                  ariaLabel="Notional by series"
                />
              ) : (
                <Empty>Nothing yet.</Empty>
              )}
            </div>
          </div>
        </div>

        <div className="card">
          <header>
            <h2>Recent fills</h2>
            <span className="muted" style={{ fontSize: 11.5 }}>
              live · newest first
            </span>
          </header>
          {fills.isPending ? (
            <TableSkeleton rows={6} cols={8} />
          ) : fills.error ? (
            <ErrorState error={fills.error} what="your fills" retry={() => void fills.refetch()} />
          ) : rows.length === 0 ? (
            <Empty>
              No fills yet. The first one will appear here the moment it lands on chain.{" "}
              <Link to="/try">Try your snippet</Link> to place one without building a page for it.
            </Empty>
          ) : (
            <div className="tablewrap">
              <table>
                <caption className="sr">Fills attributed to this partner, newest first</caption>
                <thead>
                  <tr>
                    <th scope="col">Time</th>
                    <th scope="col">Market</th>
                    <th scope="col">Side</th>
                    <th scope="col" className="num">Price</th>
                    <th scope="col" className="num">Size</th>
                    <th scope="col" className="num">Notional</th>
                    <th scope="col">Surface</th>
                    <th scope="col">Wallet</th>
                    <th scope="col">Tx</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((f) => (
                    <tr key={f.id} className={freshIds.current.has(f.id) ? "fresh" : undefined} tabIndex={0}>
                      <td title={utcTime(f.blockTs)}>{localTime(f.blockTs)}</td>
                      <td>{f.asset ? `${f.asset} ${intervalLabel(f.intervalSec ?? null)}` : <span className="mono muted">{shortAddr(f.marketId, 4)}</span>}</td>
                      <td className={f.takerSide?.includes("YES") ? "up" : "down"}>{f.takerSide ?? "—"}</td>
                      <td className="num">{prob(f.price)}</td>
                      <td className="num">{tusdc(f.quantity)}</td>
                      <td className="num">{usd(f.notional)}</td>
                      <td className="muted">{f.takerSurfaceId === 1 ? "web" : (f.takerSurfaceId ?? "—")}</td>
                      <td className="mono muted">{shortAddr(f.takerOwner)}</td>
                      <td>
                        <TxLink hash={f.txHash} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}

/** The empty state that tells a new partner what to do, rather than showing zeroes. */
function FirstFill(props: { partnerId: number; builder: string }) {
  const snippet = embedSnippet(props.partnerId, props.builder);
  return (
    <div className="card">
      <header>
        <h2>No fills yet</h2>
        <CopyButton text={snippet} label="Copy snippet" />
      </header>
      <p style={{ fontSize: 13, color: "var(--ink-2)" }}>
        Nothing has been routed under partner {props.partnerId} so far. Paste this on a page, open it, and take a
        position — the fill shows up here within a few seconds of landing on chain.
      </p>
      <pre className="snippet" style={{ marginTop: 10 }}>
        {snippet}
      </pre>
    </div>
  );
}
