import pkg from "../package.json" with { type: "json" };
// Relay — the embeddable widget.
//
//   <script src="relay.iife.js"></script>
//   <div data-relay-market data-partner="1" data-builder="0x…" data-asset="BTC"
//        data-interval="900" data-api="https://api.relay.example"></div>
//
// The IIFE auto-mounts every `[data-relay-market]` it finds and exposes the same
// thing programmatically as `Relay.mount(el, opts)`. Each instance renders into
// its own shadow root, so the host page's CSS cannot reach in and ours cannot
// leak out.

import { render } from "preact";
import { h } from "preact";
import { CSS } from "./styles.js";
import { Widget } from "./Widget.jsx";
import type { RelayOptions, Theme } from "./types.js";

export type { RelayOptions, Theme } from "./types.js";

const MOUNTED = new WeakMap<HTMLElement, { root: HTMLElement; media?: MediaQueryList; onChange?: () => void }>();
const ATTR = "data-relay-market";

function num(v: string | null | undefined): number | undefined {
  if (!v) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Read `data-*` attributes into options; explicit `opts` always wins. */
export function optionsFromElement(el: HTMLElement, override: RelayOptions = {}): RelayOptions {
  const d = el.dataset;
  const amounts = d.amounts
    ?.split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const out: RelayOptions = {
    ...(num(d.partner) !== undefined ? { partner: num(d.partner) } : {}),
    ...(d.builder ? { builder: d.builder as `0x${string}` } : {}),
    ...(d.asset ? { asset: d.asset.toUpperCase() } : {}),
    ...(num(d.interval) !== undefined ? { intervalSec: num(d.interval) } : {}),
    ...(d.surface ? { surface: d.surface } : {}),
    ...(d.theme ? { theme: d.theme as Theme } : {}),
    ...(d.api ? { api: d.api } : {}),
    ...(d.venue ? { venue: d.venue as `0x${string}` } : {}),
    ...(amounts && amounts.length ? { amounts } : {}),
    ...(d.brand === "false" ? { brand: false } : {}),
    ...(d.question === "false" ? { question: false } : {}),
    ...(d.autoClaim === "false" ? { autoClaim: false } : {}),
    ...override,
  };
  return out;
}

/** Mount a widget into `el`. Idempotent: mounting twice replaces the first. */
export function mount(el: HTMLElement, opts: RelayOptions = {}): void {
  if (MOUNTED.has(el)) unmount(el);
  const merged = optionsFromElement(el, opts);
  if (merged.partner === undefined || merged.builder === undefined) {
    // Not fatal: the widget trades fine untagged, but nobody gets credited.
    console.warn(
      `[relay] mounted without ${merged.partner === undefined ? "data-partner" : ""}${merged.partner === undefined && merged.builder === undefined ? " and " : ""}${merged.builder === undefined ? "data-builder" : ""} — orders will be UNTAGGED and earn no attribution. See packages/embed/README.md`,
    );
  }

  const root = document.createElement("div");
  root.className = "relay-widget-root";
  root.setAttribute("data-theme", merged.theme ?? "auto");
  el.appendChild(root);
  const shadow = root.attachShadow({ mode: "open" });
  const style = document.createElement("style");
  style.textContent = CSS;
  shadow.appendChild(style);
  const app = document.createElement("div");
  shadow.appendChild(app);

  // `auto` follows the host's colour scheme; the CSS handles it, but we mirror
  // the resolved value onto the host so a partner can style around the widget.
  let media: MediaQueryList | undefined;
  let onChange: (() => void) | undefined;
  if ((merged.theme ?? "auto") === "auto" && typeof matchMedia === "function") {
    media = matchMedia("(prefers-color-scheme: dark)");
    onChange = () => root.setAttribute("data-resolved-theme", media && media.matches ? "dark" : "light");
    onChange();
    media.addEventListener("change", onChange);
  }

  render(h(Widget, { opts: merged, host: el }), app);
  MOUNTED.set(el, { root, ...(media && onChange ? { media, onChange } : {}) });
}

export function unmount(el: HTMLElement): void {
  const rec = MOUNTED.get(el);
  if (!rec) return;
  if (rec.media && rec.onChange) rec.media.removeEventListener("change", rec.onChange);
  if (rec.root.shadowRoot) {
    const app = rec.root.shadowRoot.lastElementChild;
    if (app) render(null, app as Element);
  }
  rec.root.remove();
  MOUNTED.delete(el);
}

/** Mount every `[data-relay-market]` that is not mounted yet. Returns the count. */
export function autoMount(scope: ParentNode = document): number {
  let n = 0;
  scope.querySelectorAll<HTMLElement>(`[${ATTR}]`).forEach((el) => {
    if (MOUNTED.has(el)) return;
    mount(el);
    n++;
  });
  return n;
}

/**
 * The widget's semantic version, read from package.json.
 *
 * Not a hand-maintained literal, which drifts the moment anyone bumps the package —
 * and not a build-time `define` either: the console and the demo site bundle this
 * module from source with their own Vite config, where that global does not exist and
 * the import would throw at load. A JSON import works in every consumer.
 */
export const version: string = pkg.version;

const Relay = { mount, unmount, autoMount, optionsFromElement, version };
export default Relay;

// Script-tag ergonomics: mount whatever is already on the page, and pick up
// anything added later (SPAs, lazy sections) without the host wiring anything.
if (typeof document !== "undefined" && (globalThis as { RELAY_DISABLE_AUTOMOUNT?: boolean }).RELAY_DISABLE_AUTOMOUNT !== true) {
  const boot = () => {
    autoMount();
    if (typeof MutationObserver === "function") {
      new MutationObserver((records) => {
        for (const r of records) {
          for (const node of Array.from(r.addedNodes)) {
            if (!(node instanceof HTMLElement)) continue;
            if (node.hasAttribute(ATTR)) mount(node);
            else autoMount(node);
          }
        }
      }).observe(document.documentElement, { childList: true, subtree: true });
    }
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once: true });
  else boot();
}
