// React wrapper. Written with `createElement` rather than JSX so this file can
// live in a Preact-JSX package without fighting the compiler, and so React stays
// an external peer that the host app provides.
//
//   import { RelayMarket } from "@relay/embed/react";
//   <RelayMarket partner={1} builder="0x…" asset="BTC" intervalSec={900} api="…" />

import { createElement, useEffect, useRef, type CSSProperties, type ReactElement } from "react";
import { mount, unmount } from "./index.js";
import type { RelayOptions } from "./types.js";

export interface RelayMarketProps extends RelayOptions {
  className?: string;
  style?: CSSProperties;
  /** Fired when the user submits a trade (before signing). */
  onTrade?: (detail: unknown) => void;
  /** Fired when a trade produces fills, and for fills streamed on this market. */
  onFill?: (detail: unknown) => void;
  /** Fired after a successful claim. */
  onClaim?: (detail: unknown) => void;
}

export function RelayMarket(props: RelayMarketProps): ReactElement {
  const ref = useRef<HTMLDivElement | null>(null);
  const { className, style, onTrade, onFill, onClaim, ...opts } = props;

  // Re-mount when the market identity or partner changes; not on every render.
  const key = JSON.stringify({
    partner: opts.partner,
    builder: opts.builder,
    asset: opts.asset,
    intervalSec: opts.intervalSec,
    surface: opts.surface,
    theme: opts.theme,
    api: opts.api,
    venue: opts.venue,
    amounts: opts.amounts,
    brand: opts.brand,
  });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    mount(el, JSON.parse(key) as RelayOptions);
    return () => unmount(el);
  }, [key]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const wrap = (fn?: (d: unknown) => void) => (e: Event) => fn?.((e as CustomEvent).detail);
    const onT = wrap(onTrade);
    const onF = wrap(onFill);
    const onC = wrap(onClaim);
    el.addEventListener("relay:trade", onT);
    el.addEventListener("relay:fill", onF);
    el.addEventListener("relay:claim", onC);
    return () => {
      el.removeEventListener("relay:trade", onT);
      el.removeEventListener("relay:fill", onF);
      el.removeEventListener("relay:claim", onC);
    };
  }, [onTrade, onFill, onClaim]);

  return createElement("div", { ref, className, style });
}

export default RelayMarket;
