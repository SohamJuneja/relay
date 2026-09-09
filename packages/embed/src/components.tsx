import type { ComponentChildren } from "preact";
import { cents, countdown, intervalLabel, localTime, money, oraclePrice, pct, shortHash, signedPct, usd, utcTime } from "./format.js";
import type { Market, OnboardStep, Outcome, Position, StepState } from "./types.js";

export function Header(props: {
  asset: string;
  assets: string[];
  intervalSec: number;
  intervals: number[];
  statusName: string;
  secondsLeft: number;
  live: boolean;
  onAsset: (a: string) => void;
  onInterval: (i: number) => void;
}) {
  const urgent = props.secondsLeft > 0 && props.secondsLeft <= 30;
  const tone = props.statusName === "Trading" ? "live" : props.statusName === "Resolved" || props.statusName === "Voided" ? "off" : "warn";
  return (
    <div class="hd">
      <div class="seg" role="group" aria-label="Asset">
        {props.assets.map((a) => (
          <button key={a} type="button" aria-pressed={a === props.asset} onClick={() => props.onAsset(a)}>
            {a}
          </button>
        ))}
      </div>
      <div class="seg" role="group" aria-label="Window length">
        {props.intervals.map((i) => (
          <button key={i} type="button" aria-pressed={i === props.intervalSec} onClick={() => props.onInterval(i)}>
            {intervalLabel(i)}
          </button>
        ))}
      </div>
      <span class="grow" />
      <span class="pill" data-tone={tone}>
        {props.statusName}
      </span>
      {/* The countdown itself is the live region: one polite update a second, so a
          screen reader hears the time remaining instead of re-reading the status. */}
      <span class="clock" data-urgent={urgent} aria-live="polite" aria-atomic="true" title="Time until this window closes">
        {props.secondsLeft > 0 ? `${countdown(props.secondsLeft)} left` : "closed"}
      </span>
    </div>
  );
}

/**
 * The one line that says what the reader is actually betting on. Everything else on
 * the card is a number; without this the card assumes you already know the rules.
 *
 * Reference markets settle against the price when the window OPENED, so the question
 * can only name a threshold once that opening price exists — until then it says so in
 * words rather than showing a blank. A fixed-strike market (strikeRaw != 0) names the
 * strike instead. Past tense once the window has closed.
 *
 * The time is the reader's own, with the zone named; the title carries UTC, because a
 * bare "23:30" on a market that settles globally is ambiguous.
 */
export function QuestionLine(props: { asset: string; market: Market | null }) {
  const m = props.market;
  if (!m) return null;
  const strike = m.strikeRaw && m.strikeRaw !== "0" ? m.strikeRaw : null;
  const level = strike ?? m.openingPriceRaw;
  const closed = m.status >= 2; // Locked, Settling, Resolved, Voided
  const when = localTime(m.expiry);
  const verb = closed ? "Did" : "Will";
  const tail = closed ? "close" : "be";
  const text = level
    ? `${verb} ${props.asset} ${tail} above $${oraclePrice(level)} at ${when}?`
    : `${verb} ${props.asset} close above its opening price at ${when}?`;
  return (
    <p class="q" title={`Settles ${utcTime(m.expiry)}`}>
      {text}
    </p>
  );
}

export function Sparkline(props: { points: number[]; dir: "up" | "down" | "flat" }) {
  const pts = props.points;
  if (pts.length < 3) return <svg class="spark" viewBox="0 0 100 24" aria-hidden="true" />;
  const min = Math.min(...pts);
  const max = Math.max(...pts);
  const span = max - min || 1;
  const d = pts
    .map((v, i) => `${((i / (pts.length - 1)) * 100).toFixed(2)},${(22 - ((v - min) / span) * 20).toFixed(2)}`)
    .join(" L ");
  const stroke = props.dir === "up" ? "var(--up)" : props.dir === "down" ? "var(--down)" : "var(--ink-3)";
  return (
    <svg class="spark" viewBox="0 0 100 24" preserveAspectRatio="none" aria-hidden="true">
      <path d={`M ${d}`} fill="none" stroke={stroke} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
    </svg>
  );
}

export function PriceStrip(props: { asset: string; price: number | null; openingRaw: string | null; points: number[]; hasMarket?: boolean }) {
  const open = props.openingRaw ? Number(props.openingRaw) / 100 : null;
  const move = props.price !== null && open !== null && open > 0 ? ((props.price - open) / open) * 100 : null;
  const dir = move === null ? "flat" : move > 0.001 ? "up" : move < -0.001 ? "down" : "flat";
  // The oracle answers the opening price a second or two after the window opens.
  // Until it does there is no baseline, so a move chip and an "open" value would be
  // an em dash where a number belongs. Omit both, and keep the sparkline neutral
  // rather than implying a direction that cannot be known yet.
  const known = open !== null;
  // With no live window there is no opening price to wait FOR. "Waiting for the
  // opening price" beside a dash implies a window is starting; when the series has
  // none running, the honest strip is the price and nothing else.
  const between = props.hasMarket === false;
  return (
    <>
      <div class="strip" data-open={between ? "none" : known ? "known" : "pending"}>
        <div>
          <div class="px">
            <small>$</small>
            {props.price === null ? "—" : money(props.price, 2)}
          </div>
        </div>
        {known && !between ? (
          <div class="move" data-dir={dir} title="Move since this window opened">
            <span aria-hidden="true">{dir === "up" ? "▲" : dir === "down" ? "▼" : "•"}</span>
            {move === null ? "—" : signedPct(move, 2)}
          </div>
        ) : null}
        {between ? null : known ? (
          <div class="open">
            <b>{oraclePrice(props.openingRaw)}</b>
            <span class="open-lbl">window open</span>
          </div>
        ) : (
          <div class="open" data-pending="true">
            waiting for the opening price
          </div>
        )}
      </div>
      <Sparkline points={props.points} dir={known && !between ? dir : "flat"} />
    </>
  );
}

export function Sides(props: {
  upProb: number | null;
  downProb: number | null;
  selected: Outcome | null;
  upDisabled: boolean;
  downDisabled: boolean;
  onSelect: (o: Outcome) => void;
}) {
  const side = (o: Outcome, prob: number | null, disabled: boolean) => (
    <button
      type="button"
      class="side"
      data-side={o}
      aria-pressed={props.selected === o}
      disabled={disabled}
      onClick={() => props.onSelect(o)}
      title={disabled ? `No liquidity on ${o} right now` : `Buy ${o} at ${pct(prob)} — ${cents(prob)} per $1 share`}
    >
      <span class="lbl">{o}</span>
      <span class="prob">{prob === null ? "—" : pct(prob, 1)}</span>
      {/* The big number is the market's probability; the caption is what it COSTS.
          "implied chance" said the same thing twice and never gave the reader a price. */}
      <span class="sub">{disabled ? "no offers" : `pay ${cents(prob)} per $1 share`}</span>
    </button>
  );
  return (
    <div class="sides">
      {side("UP", props.upProb, props.upDisabled)}
      {side("DOWN", props.downProb, props.downDisabled)}
    </div>
  );
}

export function Amounts(props: { presets: number[]; value: number; onChange: (v: number) => void }) {
  return (
    <div class="amts" role="group" aria-label="Amount">
      {props.presets.map((p) => (
        <button key={p} type="button" class="chip" aria-pressed={props.value === p} onClick={() => props.onChange(p)}>
          {usd(p, 0)}
        </button>
      ))}
      <label class="chip custom" aria-label="Custom amount in tUSDC">
        <input
          type="number"
          min="0.1"
          step="0.5"
          inputMode="decimal"
          placeholder="Custom"
          value={props.presets.includes(props.value) ? "" : String(props.value)}
          onInput={(e) => {
            const v = Number((e.target as HTMLInputElement).value);
            if (Number.isFinite(v) && v > 0) props.onChange(v);
          }}
        />
      </label>
    </div>
  );
}

/**
 * What the reader already has riding on this asset, in one line under the button.
 *
 * This replaces the separate "ready to claim" banner. A banner that only appears
 * when something has settled hides the more common case — an open position the
 * reader wants to keep an eye on — and pushes the card around when it appears.
 * One row, always present when there is anything to show, is calmer and says more.
 */
export function PositionsStrip(props: {
  open: { position: Position; outcome: Outcome; amount: number }[];
  claimTotal: number;
  claimCount: number;
  claiming: string | null;
  nowSec: number;
  onOpen: (marketId: string) => void;
  onClaim: () => void;
}) {
  const { open, claimCount, claimTotal } = props;
  if (open.length === 0 && claimCount === 0) return null;

  // Several things at once: summarise rather than listing them in a strip this size.
  if (open.length + claimCount > 1) {
    const total = open.length + claimCount;
    return (
      <div class="pos">
        <span class="pos-txt">
          {total} positions{claimCount > 0 ? ` · ${usd(claimTotal)} to claim` : ""}
        </span>
        {claimCount > 0 ? (
          <button type="button" class="btn sm" disabled={props.claiming !== null} onClick={props.onClaim}>
            {props.claiming ?? "Claim all"}
          </button>
        ) : null}
      </div>
    );
  }

  if (claimCount === 1 && open.length === 0) {
    return (
      <div class="pos" data-tone="win">
        <span class="pos-txt">Your position settled in your favour.</span>
        <button type="button" class="btn sm" disabled={props.claiming !== null} onClick={props.onClaim}>
          {props.claiming ?? `Claim ${usd(claimTotal)}`}
        </button>
      </div>
    );
  }

  const only = open[0]!;
  const left = Math.max(0, only.position.expiry - props.nowSec);
  return (
    <button type="button" class="pos" data-tap="true" onClick={() => props.onOpen(only.position.marketId)} title="Open this position">
      <span class="pos-txt">
        <b data-side={only.outcome}>
          {money(only.amount, 2)} {only.outcome}
        </b>
        {" · "}
        {only.position.asset} {intervalLabel(only.position.intervalSec)}
        {" · "}
        {left > 0 ? `settles in ${countdown(left)}` : "settling"}
      </span>
    </button>
  );
}

export function Row(props: { label: string; value: ComponentChildren; tone?: "win" | "loss" }) {
  return (
    <div class="row">
      <dt>{props.label}</dt>
      <dd class={props.tone ?? ""}>{props.value}</dd>
    </div>
  );
}

export function Notice(props: { tone?: "warn" | "ok"; children: ComponentChildren }) {
  return (
    <p class="note" data-tone={props.tone ?? "info"} role={props.tone === "warn" ? "alert" : undefined}>
      {props.children}
    </p>
  );
}

const STEP_LABEL: Record<OnboardStep, string> = {
  create: "Create a wallet in this browser",
  gas: "Get testnet gas",
  collateral: "Get 25 tUSDC from the faucet",
  ready: "Ready to trade",
};

export function Steps(props: { steps: { id: OnboardStep; state: StepState; note?: string }[] }) {
  return (
    <ol class="steps">
      {props.steps.map((s) => (
        <li key={s.id} data-state={s.state}>
          <span class="dot" aria-hidden="true">
            {s.state === "done" ? "✓" : s.state === "error" ? "!" : ""}
          </span>
          <span>
            {STEP_LABEL[s.id]}
            {s.note ? <span style="color:var(--ink-3)"> · {s.note}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}

export function RecentStrip(props: { markets: Market[] }) {
  if (props.markets.length === 0) return null;
  return (
    <div class="ft">
      <h3>Recently settled</h3>
      <div class="recent">
        {props.markets.slice(0, 5).map((m) => (
          <div key={m.marketId} class="r" data-w={m.winner ?? ""} title={`${m.asset} ${intervalLabel(m.intervalSec)} · closed ${m.closingPrice === null ? "—" : oraclePrice(m.closingPriceRaw)}`}>
            {m.voided ? "VOID" : (m.winner ?? "—")}
            <span>{m.closingPriceRaw ? oraclePrice(m.closingPriceRaw).split(".")[0] : "—"}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function Brand(props: { partner: number | undefined; api: string; tagged: boolean; wsDown: boolean }) {
  return (
    <div class="brand">
      <span class="conn" data-state={props.wsDown ? "poll" : "live"}>
        <span class="dot-sm" aria-hidden="true" />
        {props.wsDown ? "reconnecting · polling" : "live"}
        {props.tagged ? "" : " · untagged"}
      </span>
      {props.partner === undefined ? (
        <span>via Relay</span>
      ) : (
        <a href={`${props.api}/v1/partners/${props.partner}/public`} target="_blank" rel="noreferrer noopener">
          via Relay
        </a>
      )}
    </div>
  );
}

export function TxLink(props: { hash: string; explorer: string; label?: string }) {
  return (
    <a class="mono" href={`${props.explorer}/tx/${props.hash}`} target="_blank" rel="noreferrer noopener" style="color:inherit">
      {props.label ?? shortHash(props.hash)}
    </a>
  );
}
