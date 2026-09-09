// Number and time formatting for the console. Same rules as the widget: fixed
// decimals, tabular figures in CSS, the reader's own timezone with UTC on hover.

/** tUSDC amounts carry 3 decimals here — enough to see a $0.99 fill, few enough to scan. */
export const tusdc = (n: number | null | undefined, dp = 3): string =>
  n === null || n === undefined ? "—" : n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

export const usd = (n: number | null | undefined, dp = 3): string => (n === null || n === undefined ? "—" : `$${tusdc(n, dp)}`);

export const count = (n: number | null | undefined): string => (n === null || n === undefined ? "—" : n.toLocaleString("en-US"));

/**
 * Percentages. Null means "no answer", never "zero".
 *
 * Small shares get more precision, because a partner routing $3 of a $121,000 venue
 * has a real 0.0022% share and rounding it to "0.0%" tells them they brought nothing.
 * Below a hundredth of a per cent the honest rendering is a bound, not a number.
 */
export function pct(n: number | null | undefined, dp = 1): string {
  if (n === null || n === undefined) return "—";
  if (n === 0) return "0%";
  const abs = Math.abs(n);
  // Below one per cent, two significant figures rather than a fixed decimal place:
  // 0.0426% and 0.0022% are both real answers, and a fixed 2 dp flattens the second
  // one to zero and the first one to "0.04%".
  if (abs < 1) return `${Number(n.toPrecision(2))}%`;
  return `${n.toFixed(dp)}%`;
}

/** A probability in [0,1] as a percentage: 0.578 → "57.8%" */
export const prob = (p: number | null | undefined, dp = 1): string => (p === null || p === undefined ? "—" : `${(p * 100).toFixed(dp)}%`);

export const shortAddr = (a: string | null | undefined, n = 4): string => (a ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : "—");
export const shortHash = (h: string | null | undefined): string => (h ? `${h.slice(0, 8)}…${h.slice(-6)}` : "—");

/** "15m", "1h" — the same labels the widget's tabs use. */
export function intervalLabel(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return "—";
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** Local clock time, for the visible cell. */
export const localTime = (unixSec: number): string =>
  new Date(unixSec * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });

export const localDateTime = (unixSec: number): string => {
  const d = new Date(unixSec * 1000);
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${localTime(unixSec)}`;
};

/**
 * The same instant in UTC, for the title attribute. A fixed month table rather
 * than Intl, whose short forms differ between engines ("Sep" vs "Sept").
 */
export function utcTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  const ss = String(d.getUTCSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss} UTC · ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "3:07" / "1:02:05" — time remaining, for the live markets table. */
export function countdown(secondsLeft: number): string {
  if (secondsLeft <= 0) return "0:00";
  const s = Math.floor(secondsLeft);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

/** Oracle answers are 2-dp integers: "7845603" → "78,456.03" */
export const oraclePrice = (raw: string | null | undefined): string =>
  raw === null || raw === undefined ? "—" : (Number(raw) / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
