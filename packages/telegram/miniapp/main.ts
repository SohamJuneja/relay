// The Telegram mini-app.
//
// It does four things: adopt Telegram's theme, mount the widget tagged as telegram
// flow, keep the app from closing mid-trade, and buzz on a fill. Everything else is
// the widget, unchanged — the point of a surface is that it is a surface.
//
// It also has to work in a plain browser, because that is where it gets tested and
// where a curious reader will open the link.

import "./style.css";
import { applyTelegramTheme, expandAndLock, hasWebApp, haptic, isRealTelegram, tg } from "./telegram";

const API = (import.meta.env.VITE_RELAY_API ?? "http://localhost:8787").replace(/\/$/, "");
const PARTNER = import.meta.env.VITE_RELAY_PARTNER ?? "";
const BUILDER = import.meta.env.VITE_RELAY_BUILDER ?? "";

declare global {
  interface Window {
    Relay?: { mount: (el: HTMLElement, opts?: Record<string, unknown>) => void };
  }
}

const mount = document.getElementById("mount");
const bar = document.getElementById("browser-bar");
const who = document.getElementById("who");

// ── Telegram, if we are inside it ──────────────────────────────────────────
const inTelegram = isRealTelegram();
if (bar) bar.hidden = inTelegram;

applyTelegramTheme(document.documentElement);
expandAndLock();

if (inTelegram && who) {
  const user = tg()?.initDataUnsafe?.user;
  // initData is displayed, never trusted: anything security-relevant would have to be
  // verified server-side against the bot token. Nothing here is security-relevant —
  // the wallet is local and the order is signed on this device.
  if (user?.first_name) who.textContent = `${user.first_name} · testnet`;
}

// ── the widget ─────────────────────────────────────────────────────────────
if (mount) {
  if (PARTNER) mount.setAttribute("data-partner", PARTNER);
  if (BUILDER) mount.setAttribute("data-builder", BUILDER);
  mount.setAttribute("data-api", API);
  // Telegram tells us which way its theme is pointing; the widget takes a plain
  // light/dark rather than guessing from prefers-color-scheme inside a webview.
  // Two different questions, and conflating them was a bug: "should the 'open in
  // Telegram' bar show?" is about being in a REAL client, but "which way is the theme
  // pointing?" is about whether a WebApp object exists to ask. Under the harness the
  // second is true and the first is not, and the widget was falling back to `auto`.
  const scheme = hasWebApp() ? (tg()?.colorScheme === "dark" ? "dark" : "light") : "auto";
  mount.setAttribute("data-theme", scheme);

  if (window.Relay && !mount.querySelector(".relay-widget-root")) window.Relay.mount(mount);
}

// ── feedback ───────────────────────────────────────────────────────────────
//
// The widget dispatches these on its host element. A phone in a hand should confirm
// with a buzz rather than only a colour change.
document.addEventListener("relay:trade", () => {
  haptic("impact");
  lockClose(true);
});
document.addEventListener("relay:fill", () => {
  haptic("success");
  lockClose(false);
});
document.addEventListener("relay:claim", () => haptic("success"));

/**
 * Telegram closes a mini-app on a downward swipe. That gesture during a pending
 * signature would abandon a transaction that is already on its way to the chain, so
 * it is disabled while a trade is in flight and restored afterwards.
 */
function lockClose(locked: boolean): void {
  const w = tg();
  if (!w) return;
  try {
    if (locked) {
      w.disableVerticalSwipes?.();
      w.enableClosingConfirmation?.();
    } else {
      w.enableVerticalSwipes?.();
      w.disableClosingConfirmation?.();
    }
  } catch {
    /* older Telegram clients do not have these; the trade still completes */
  }
}
