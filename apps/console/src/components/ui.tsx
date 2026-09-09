// The small pieces every page uses: theme, loading and error states, KPI tiles,
// copy-to-clipboard, and links out to the explorer. Nothing here knows about the
// API — they take values and render them.

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { EXPLORER } from "../config";
import { shortHash, utcTime } from "../format";

// ── theme ─────────────────────────────────────────────────────────────────
//
// Three states, not two: an explicit choice stamps `data-theme` on the root, and
// "system" stamps nothing so prefers-color-scheme decides. Storing the choice in
// localStorage is fine — it is a preference, not a credential.

export type Theme = "system" | "light" | "dark";
const THEME_KEY = "relay.console.theme";

export function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      const v = localStorage.getItem(THEME_KEY);
      return v === "light" || v === "dark" ? v : "system";
    } catch {
      return "system";
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", theme);
    try {
      if (theme === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);
  return [theme, setTheme];
}

export function ThemeToggle(props: { theme: Theme; onChange: (t: Theme) => void }) {
  return (
    <div className="seg" role="group" aria-label="Colour theme">
      {(["system", "light", "dark"] as const).map((t) => (
        <button key={t} type="button" aria-pressed={props.theme === t} onClick={() => props.onChange(t)}>
          {t === "system" ? "auto" : t}
        </button>
      ))}
    </div>
  );
}

// ── loading and failure ───────────────────────────────────────────────────

export function Skeleton(props: { height?: number; width?: string; count?: number }) {
  const n = props.count ?? 1;
  return (
    <div style={{ display: "grid", gap: 6 }} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="skel" style={{ height: props.height ?? 14, width: props.width ?? "100%" }} />
      ))}
    </div>
  );
}

export function KpiSkeleton(props: { count?: number }) {
  return (
    <div className="kpis" aria-hidden="true">
      {Array.from({ length: props.count ?? 5 }, (_, i) => (
        <div key={i} className="kpi">
          <div className="skel" style={{ height: 11, width: "60%" }} />
          <div className="skel" style={{ height: 24, width: "80%", marginTop: 8 }} />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton(props: { rows?: number; cols?: number }) {
  return (
    <div className="tablewrap" aria-hidden="true">
      <div style={{ padding: 12, display: "grid", gap: 10 }}>
        {Array.from({ length: props.rows ?? 6 }, (_, r) => (
          <div key={r} style={{ display: "grid", gridTemplateColumns: `repeat(${props.cols ?? 6}, 1fr)`, gap: 12 }}>
            {Array.from({ length: props.cols ?? 6 }, (_, c) => (
              <div key={c} className="skel" style={{ height: 12 }} />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A failure the reader can act on: what broke, and a way to try again. Never a
 * spinner that never resolves, and never a bare "something went wrong".
 */
export function ErrorState(props: { error: unknown; retry?: () => void; what?: string }) {
  const msg = props.error instanceof Error ? props.error.message : String(props.error);
  return (
    <div className="note warn" role="alert">
      <div style={{ fontWeight: 700, marginBottom: 4 }}>Could not load {props.what ?? "this"}.</div>
      <div className="mono" style={{ fontSize: 11.5, wordBreak: "break-word" }}>
        {msg}
      </div>
      {props.retry ? (
        <button type="button" className="btn ghost sm" style={{ marginTop: 8 }} onClick={props.retry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

export function Empty(props: { children: ReactNode }) {
  return (
    <div className="note" style={{ textAlign: "center" }}>
      {props.children}
    </div>
  );
}

// ── data display ──────────────────────────────────────────────────────────

export function Kpi(props: { label: string; value: ReactNode; sub?: ReactNode; title?: string }) {
  return (
    <div className="kpi" title={props.title}>
      <dt>{props.label}</dt>
      <dd>{props.value}</dd>
      {props.sub ? <div className="sub">{props.sub}</div> : null}
    </div>
  );
}

export function Kpis(props: { children: ReactNode }) {
  return <dl className="kpis">{props.children}</dl>;
}

/** A timestamp in the reader's zone, with the UTC instant on hover. */
export function Time(props: { unixSec: number; render?: (s: number) => string }) {
  const shown = props.render ? props.render(props.unixSec) : new Date(props.unixSec * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
  return <time title={utcTime(props.unixSec)}>{shown}</time>;
}

export function TxLink(props: { hash: string; label?: string }) {
  return (
    <a className="mono plain" href={`${EXPLORER}/tx/${props.hash}`} target="_blank" rel="noreferrer noopener" title={props.hash} style={{ borderBottom: "1px solid var(--line-strong)" }}>
      {props.label ?? shortHash(props.hash)}
    </a>
  );
}

export function AddrLink(props: { address: string; label?: string }) {
  return (
    <a className="mono plain" href={`${EXPLORER}/address/${props.address}`} target="_blank" rel="noreferrer noopener" title={props.address} style={{ borderBottom: "1px solid var(--line-strong)" }}>
      {props.label ?? props.address}
    </a>
  );
}

/**
 * Copy, with the confirmation the reader needs to believe it worked. Falls back to
 * selecting the text when the clipboard API is unavailable (http origins, older
 * browsers) rather than silently doing nothing.
 */
export function CopyButton(props: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  const copy = useCallback(() => {
    const ok = () => {
      setDone(true);
      setTimeout(() => setDone(false), 1600);
    };
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(props.text).then(ok).catch(() => undefined);
      return;
    }
    const ta = document.createElement("textarea");
    ta.value = props.text;
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand("copy");
      ok();
    } finally {
      ta.remove();
    }
  }, [props.text]);
  return (
    <button type="button" className={props.className ?? "btn ghost sm"} onClick={copy}>
      {done ? "copied" : (props.label ?? "Copy")}
    </button>
  );
}

/** A definition the reader can hover, for the terms this venue invented. */
export function Term(props: { title: string; children: ReactNode }) {
  return (
    <abbr title={props.title} style={{ textDecoration: "none", borderBottom: "1px dotted var(--line-strong)", cursor: "help" }}>
      {props.children}
    </abbr>
  );
}
