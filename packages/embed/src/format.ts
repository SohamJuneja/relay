// Every number the widget shows goes through here: fixed decimals, tabular
// figures in CSS, explicit signs, never a raw float.

export const money = (n: number, dp = 2): string =>
  n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** Probability → percent with one decimal: 0.6325 → "63.3%" */
export const pct = (p: number | null | undefined, dp = 1): string => (p === null || p === undefined ? "—" : `${(p * 100).toFixed(dp)}%`);

/** Signed percentage move, always with its sign: +0.42% */
export const signedPct = (p: number, dp = 2): string => `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(dp)}%`;

export const usd = (n: number, dp = 2): string => `$${money(n, dp)}`;

/** Oracle answers are 2-dp integers: 7845603 → "78,456.03" */
export const oraclePrice = (raw: string | null | undefined): string => {
  if (raw === null || raw === undefined) return "—";
  return money(Number(raw) / 100, 2);
};

export function countdown(secondsLeft: number): string {
  if (secondsLeft <= 0) return "0:00";
  const s = Math.floor(secondsLeft);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/** "15m", "1h", "4h" for the interval tabs. */
export function intervalLabel(sec: number): string {
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

export const shortAddr = (a: string | null | undefined, n = 4): string => (a ? `${a.slice(0, 2 + n)}…${a.slice(-n)}` : "—");
export const shortHash = (h: string | null | undefined): string => (h ? `${h.slice(0, 10)}…${h.slice(-6)}` : "—");

/** Raw collateral integer → human number. */
export const fromRaw = (raw: string | bigint, decimals: number): number => Number(BigInt(raw)) / 10 ** decimals;
export const toRaw = (human: number, decimals: number): bigint => {
  const [i, f = ""] = human.toFixed(decimals).split(".");
  return BigInt(`${i}${f.padEnd(decimals, "0")}`);
};

/** Ask price → the cents a $1 share costs: 0.2304 → "23.0¢" */
export const cents = (p: number | null | undefined, dp = 1): string => (p === null || p === undefined ? "—" : `${(p * 100).toFixed(dp)}¢`);

/**
 * Window close, in the reader's own zone, with the zone named so "23:30" is not
 * ambiguous. The UTC form goes in a title attribute — see `utcTime`.
 */
export function localTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const hhmm = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  let zone = "";
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(d);
    const v = parts.find((p) => p.type === "timeZoneName")?.value ?? "";
    // A NAME earns its place: "IST", "UTC", "EST" tells the reader something. An
    // offset — "GMT+5:30" — is nine characters that say what the clock already said,
    // and on a 300 px card it pushes the question onto another line. The title
    // attribute carries UTC either way, so nothing is lost by dropping it.
    if (/^[A-Za-z]{2,5}$/.test(v)) zone = v;
  } catch {
    /* Intl without timeZoneName support — the title still carries UTC */
  }
  return zone ? `${hhmm} ${zone}` : hhmm;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/**
 * The same instant in UTC, for the title attribute: "23:30 UTC · 9 Sep 2026".
 *
 * The month name is a fixed table rather than `toLocaleDateString`, whose short
 * forms move between ICU versions — Node renders September as "Sept" where browsers
 * render "Sep". This string is a precise timestamp shown on hover next to a local
 * time, so it should read identically everywhere rather than track the reader's
 * locale twice.
 */
export function utcTime(unixSec: number): string {
  const d = new Date(unixSec * 1000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm} UTC · ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
