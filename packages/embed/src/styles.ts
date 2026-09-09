// The widget's whole stylesheet, injected once into the shadow root. Host page
// CSS cannot reach in and these rules cannot leak out.
//
// The TOKENS — palette, spacing scale, radii, typeface pairing — come from
// @relay/ui-tokens, the same module the partner console imports, so the two
// products cannot drift apart. Only the layout below is the widget's own.
//
// Design rules, deliberately narrow:
//   · one accent per side — UP teal-green, DOWN warm red — on a neutral ground.
//     Nothing else is coloured, so the two buttons are the only things competing
//     for attention, which is what the product is for.
//   · a typeface PAIRING, not a font: a rounded display face for the big numbers
//     and a neutral sans for text, both system-resident with a var override, and
//     a mono for hashes/addresses. Numerals are tabular everywhere so digits do
//     not jitter as the countdown and prices tick.
//   · 4-pt spacing scale; radii 8/12/16; one shadow depth.
//   · motion only where it carries meaning: the countdown ring and state changes,
//     ≤200 ms, and nothing animates when the user asked for reduced motion.
//   · light and dark are the same tokens with different values; `auto` follows
//     the host's prefers-color-scheme.

import { colorVars, staticVars } from "@relay/ui-tokens";

export const CSS = /* css */ `
:host {
${staticVars()}
${colorVars("light")}
  display: block;
  contain: content;
  color-scheme: light;
  font-family: var(--relay-font-ui);
  font-variant-numeric: tabular-nums;
  -webkit-font-smoothing: antialiased;
  color: var(--ink);
}
:host([data-theme="dark"]) { color-scheme: dark; }
:host([data-theme="dark"]), :host-context([data-theme="dark"]) {
${colorVars("dark")}
}
@media (prefers-color-scheme: dark) {
  :host([data-theme="auto"]) {
    color-scheme: dark;
${colorVars("dark", "    ")}
  }
}

*, *::before, *::after { box-sizing: border-box; }
button { font: inherit; color: inherit; }

.card {
  /* The narrow rules below are CONTAINER queries, not media queries, because this
     card is a column inside someone else's layout: a 300 px card on a 1280 px page
     is the normal case, and a viewport query would never fire for it. Browsers
     without container query support simply keep the wide layout, which is what they
     did before. */
  container-type: inline-size;
  container-name: relay;
  width: 100%;
  max-width: 380px;
  min-width: 280px;
  background: var(--bg);
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  box-shadow: var(--shadow);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

/* ── header ───────────────────────────────────────────────── */
.hd { display: flex; align-items: center; gap: var(--s2); padding: var(--s3) var(--s4); border-bottom: 1px solid var(--line); }
.seg { display: inline-flex; background: var(--bg-sunken); border-radius: var(--r-sm); padding: 2px; gap: 2px; }
.seg button {
  border: 0; background: transparent; color: var(--ink-3);
  padding: 5px 9px; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600;
  transition: color .15s, background .15s;
}
.seg button[aria-pressed="true"] { background: var(--bg-raised); color: var(--ink); box-shadow: 0 1px 2px rgba(11,13,16,.10); }
.seg button:hover:not([aria-pressed="true"]) { color: var(--ink-2); }
.hd .grow { flex: 1; }
.pill {
  font-size: 11px; font-weight: 600; letter-spacing: .02em;
  padding: 3px 8px; border-radius: 999px; border: 1px solid var(--line-strong); color: var(--ink-2);
  white-space: nowrap;
  /* The pill is the part of the header that gives way. It can shrink and clip its
     own label; the clock cannot, because a countdown broken across two lines reads
     as two numbers. */
  min-width: 0; overflow: hidden; text-overflow: clip; flex: 0 1 auto;
}
.pill[data-tone="live"] { color: var(--up); border-color: color-mix(in srgb, var(--up) 40%, var(--line)); }
.pill[data-tone="warn"] { color: var(--ink-2); }
.pill[data-tone="off"] { color: var(--ink-3); }
/* "14:05 left" is one token. It never wraps and never shrinks — everything else in
   the header yields to it first. */
.clock {
  font-family: var(--relay-font-display); font-weight: 700; font-size: 15px; letter-spacing: -.01em;
  min-width: 52px; text-align: right; white-space: nowrap; flex: 0 0 auto;
}
.clock[data-urgent="true"] { color: var(--down); }

/* ── question ─────────────────────────────────────────────── */
.q {
  margin: 0; padding: var(--s3) var(--s4) 0; font-size: 12.5px; line-height: 1.4;
  color: var(--ink-2); font-weight: 500;
}

/* Between about 300 and 380 px the two segmented controls, the status pill and the
   clock cannot share a row. Rather than let the clock wrap, the pill collapses to a
   dot carrying the same colour, with its wording still in the title attribute. */
@container relay (max-width: 380px) {
  .pill { font-size: 0; padding: 0; width: 9px; height: 9px; border-radius: 50%; border-width: 0; background: var(--ink-3); }
  .pill[data-tone="live"] { background: var(--up); }
  .pill[data-tone="warn"] { background: var(--amber); }
  .pill[data-tone="off"] { background: var(--ink-3); }
}

/* ── price strip ──────────────────────────────────────────── */
.strip { padding: var(--s3) var(--s4); display: flex; align-items: flex-end; gap: var(--s3); border-bottom: 1px solid var(--line); }
.px { font-family: var(--relay-font-display); font-size: 26px; font-weight: 700; letter-spacing: -.02em; line-height: 1.1; }
.px small { font-size: 13px; font-weight: 600; color: var(--ink-3); margin-right: 2px; }
.move { font-size: 13px; font-weight: 700; display: flex; align-items: center; gap: 3px; padding-bottom: 3px; }
.move[data-dir="up"] { color: var(--up); }
.move[data-dir="down"] { color: var(--down); }
.move[data-dir="flat"] { color: var(--ink-3); }
.open { margin-left: auto; text-align: right; font-size: 11px; color: var(--ink-3); line-height: 1.35; padding-bottom: 3px; }
.open b { display: block; font-size: 12px; color: var(--ink-2); font-weight: 600; }
.open[data-pending="true"] { font-style: italic; max-width: 40%; }
.spark { display: block; width: 100%; height: 28px; padding: 0 var(--s4) var(--s2); }

/* ── sides ────────────────────────────────────────────────── */
.sides { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s2); padding: var(--s3) var(--s4) 0; }
.side {
  position: relative; border: 1.5px solid var(--line); background: var(--bg-raised);
  border-radius: var(--r-md); padding: var(--s3) var(--s2); cursor: pointer; text-align: center;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  transition: border-color .15s, background .15s, transform .12s;
}
.side:hover:not(:disabled) { transform: translateY(-1px); }
.side:disabled { cursor: not-allowed; opacity: .55; }
.side .lbl { font-size: 12px; font-weight: 700; letter-spacing: .04em; }
.side .prob { font-family: var(--relay-font-display); font-size: 22px; font-weight: 800; letter-spacing: -.02em; }
.side .sub { font-size: 10px; color: var(--ink-3); }
.side[data-side="UP"] .lbl, .side[data-side="UP"] .prob { color: var(--up); }
.side[data-side="DOWN"] .lbl, .side[data-side="DOWN"] .prob { color: var(--down); }
.side[data-side="UP"][aria-pressed="true"] { border-color: var(--up); background: var(--up-bg); }
.side[data-side="DOWN"][aria-pressed="true"] { border-color: var(--down); background: var(--down-bg); }

/* ── amounts ──────────────────────────────────────────────── */
.amts { display: flex; gap: var(--s2); padding: var(--s3) var(--s4) 0; align-items: center; }
.chip {
  flex: 1; border: 1px solid var(--line); background: var(--bg-raised); border-radius: var(--r-sm);
  padding: 7px 0; font-size: 13px; font-weight: 600; cursor: pointer; color: var(--ink-2);
  transition: border-color .15s, color .15s, background .15s;
}
.chip[aria-pressed="true"] { border-color: var(--ink); color: var(--ink); background: var(--bg-sunken); }
.chip:hover:not([aria-pressed="true"]) { border-color: var(--line-strong); }
.chip.custom { flex: 1.2; padding: 0; display: flex; align-items: center; }
.chip.custom input {
  width: 100%; border: 0; background: transparent; color: inherit; font: inherit; font-weight: 600;
  padding: 7px 8px; text-align: center; outline: none; -moz-appearance: textfield;
}
.chip.custom input::-webkit-outer-spin-button, .chip.custom input::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }

/* ── quote rows ───────────────────────────────────────────── */
.rows { padding: var(--s3) var(--s4); display: grid; gap: 5px; font-size: 12px; }
.row { display: flex; justify-content: space-between; align-items: baseline; gap: var(--s2); }
.row dt { color: var(--ink-3); }
.row dd { margin: 0; font-weight: 600; color: var(--ink); }
.row dd.win { color: var(--up); }
.row dd.loss { color: var(--down); }

/* ── actions ──────────────────────────────────────────────── */
.act { padding: var(--s2) var(--s4) var(--s4); display: grid; gap: var(--s2); }
.btn {
  border: 0; border-radius: var(--r-md); padding: 12px 14px; font-size: 14px; font-weight: 700;
  cursor: pointer; background: var(--ink); color: var(--bg); transition: opacity .15s, transform .12s;
  display: flex; align-items: center; justify-content: center; gap: var(--s2); min-height: 44px;
}
.btn:hover:not(:disabled) { opacity: .9; }
.btn:active:not(:disabled) { transform: translateY(1px); }
.btn:disabled { cursor: not-allowed; }
.btn[data-variant="up"] { background: var(--up); color: #fff; }
.btn[data-variant="down"] { background: var(--down); color: #fff; }
/* A disabled action is NOT a faded version of the thing it would have done: a pale
   green button still reads as "buy UP" and invites the click it is refusing. Colour
   means "this will act, and in this direction"; off means neutral. */
.btn:disabled, .btn[data-variant="up"]:disabled, .btn[data-variant="down"]:disabled {
  background: var(--btn-off); color: var(--ink-3); opacity: 1;
}
.btn[data-variant="ghost"]:disabled { background: transparent; color: var(--ink-3); border-color: var(--line); }
.btn[data-variant="ghost"] { background: transparent; color: var(--ink-2); border: 1px solid var(--line); font-weight: 600; }
.btn[data-variant="ghost"]:hover:not(:disabled) { border-color: var(--line-strong); color: var(--ink); }
.btn.sm { padding: 8px 10px; font-size: 12px; min-height: 34px; border-radius: var(--r-sm); }

/* ── positions strip ──────────────────────────────────────── */
.pos {
  display: flex; align-items: center; justify-content: space-between; gap: var(--s2);
  width: 100%; text-align: left; margin-top: var(--s1);
  padding: var(--s2) var(--s3); border: 1px solid var(--line); border-radius: var(--r-sm);
  background: var(--bg-sunken); color: var(--ink-2); font-size: 12px; font: inherit;
  font-size: 12px;
}
.pos[data-tone="win"] { border-color: color-mix(in srgb, var(--up) 35%, var(--line)); background: var(--up-bg); color: var(--up-ink); }
.pos[data-tap="true"] { cursor: pointer; transition: border-color .15s; }
.pos[data-tap="true"]:hover { border-color: var(--line-strong); }
.pos-txt { display: block; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pos-txt b { font-weight: 700; color: var(--ink); }
.pos-txt b[data-side="UP"] { color: var(--up); }
.pos-txt b[data-side="DOWN"] { color: var(--down); }
.pos .btn.sm { flex: none; }

/* ── notices / states ─────────────────────────────────────── */
.note { margin: 0 var(--s4) var(--s3); padding: var(--s2) var(--s3); border-radius: var(--r-sm); font-size: 12px; line-height: 1.45; border: 1px solid var(--line); background: var(--bg-sunken); color: var(--ink-2); }
.note[data-tone="warn"] { border-color: color-mix(in srgb, var(--down) 35%, var(--line)); background: var(--down-bg); color: var(--down-ink); }
.note[data-tone="ok"] { border-color: color-mix(in srgb, var(--up) 35%, var(--line)); background: var(--up-bg); color: var(--up-ink); }
.note b { font-weight: 700; }
.note code { font-family: var(--relay-font-mono); font-size: 11px; }
/* A control that reads as prose, for offering a second path inside a sentence. */
.linkish {
  border: 0; background: none; padding: 0; margin: 0; cursor: pointer;
  font: inherit; color: var(--ink); font-weight: 600;
  text-decoration: underline; text-underline-offset: 2px; text-decoration-color: var(--line-strong);
}
.linkish:hover { text-decoration-color: var(--ink-2); }

.empty { padding: var(--s6) var(--s4); text-align: center; color: var(--ink-3); font-size: 13px; line-height: 1.5; }

/* ── steps (onboarding) ───────────────────────────────────── */
.steps { list-style: none; margin: 0; padding: var(--s2) 0 0; display: grid; gap: var(--s2); }
.steps li { display: flex; align-items: center; gap: var(--s2); font-size: 12px; color: var(--ink-3); }
.steps li[data-state="running"], .steps li[data-state="done"] { color: var(--ink); }
.steps li[data-state="error"] { color: var(--down); }
.dot { width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid var(--line-strong); flex: none; display: grid; place-items: center; font-size: 9px; font-weight: 700; }
li[data-state="done"] .dot { background: var(--up); border-color: var(--up); color: #fff; }
li[data-state="running"] .dot { border-color: var(--ink); animation: pulse 1s ease-in-out infinite; }
li[data-state="error"] .dot { background: var(--down); border-color: var(--down); color: #fff; }
@keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: .35 } }

/* ── position / result ────────────────────────────────────── */
.result { padding: var(--s4); display: grid; gap: var(--s3); text-align: center; }
.verdict { font-family: var(--relay-font-display); font-size: 30px; font-weight: 800; letter-spacing: -.02em; }
.verdict[data-r="won"] { color: var(--up); }
.verdict[data-r="lost"] { color: var(--ink-3); }
.verdict[data-r="void"] { color: var(--ink-2); }

/* ── recently settled ─────────────────────────────────────── */
.ft { border-top: 1px solid var(--line); padding: var(--s2) var(--s4) var(--s3); }
.ft h3 { margin: 0 0 var(--s2); font-size: 10px; font-weight: 700; letter-spacing: .07em; text-transform: uppercase; color: var(--ink-3); }
.recent { display: flex; gap: var(--s1); }
.recent .r { flex: 1; border-radius: 6px; padding: 5px 2px; text-align: center; font-size: 10px; font-weight: 700; border: 1px solid var(--line); background: var(--bg-sunken); }
.recent .r[data-w="UP"] { color: var(--up); border-color: color-mix(in srgb, var(--up) 30%, var(--line)); }
.recent .r[data-w="DOWN"] { color: var(--down); border-color: color-mix(in srgb, var(--down) 30%, var(--line)); }
.recent .r span { display: block; font-weight: 500; color: var(--ink-3); font-size: 9px; margin-top: 1px; }
.brand { display: flex; align-items: center; justify-content: space-between; margin-top: var(--s2); font-size: 10px; color: var(--ink-3); }
.brand a { color: var(--ink-3); text-decoration: none; border-bottom: 1px solid var(--line-strong); }
.brand a:hover { color: var(--ink-2); }
.conn { display: inline-flex; align-items: center; gap: 5px; }
.dot-sm { width: 6px; height: 6px; border-radius: 50%; background: var(--up); flex: none; }
.conn[data-state="poll"] { color: var(--amber); }
.conn[data-state="poll"] .dot-sm { background: var(--amber); }
.mono { font-family: var(--relay-font-mono); }

/* ── a11y ─────────────────────────────────────────────────── */
:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 4px; }
.sr { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
@media (prefers-reduced-motion: reduce) { * { animation: none !important; transition: none !important; } }

/* ── narrow ───────────────────────────────────────────────── */
/* Below 340px there is no room for one header row, and squeezing it clipped the
   countdown. Reflow instead: asset and interval on top, state and time under them;
   the opening price gets its own line; the wallet row splits address from actions. */
@container relay (max-width: 340px) {
  .hd { padding: var(--s2) var(--s3); gap: var(--s1); flex-wrap: wrap; row-gap: var(--s2); }
  /* Row 1 is the two segmented controls, row 2 the state and the clock. The zero-height
     spacer forces the break; the controls themselves must be allowed to shrink, or
     they hold row 1 at their natural 358 px and the card scrolls sideways. */
  .hd .grow { flex: 1 0 100%; height: 0; margin: 0; }
  .hd .pill { margin-right: auto; }
  .clock { min-width: 0; }
  .hd .seg { min-width: 0; flex: 0 1 auto; }
  .seg button { padding: 4px 5px; font-size: 11px; min-width: 0; }
  .q, .strip, .sides, .amts, .rows, .act, .ft { padding-left: var(--s3); padding-right: var(--s3); }
  .q { font-size: 12px; }
  .px { font-size: 22px; }
  .side .prob { font-size: 19px; }
  .side .sub { font-size: 9px; }
  .clock { font-size: 13px; min-width: 0; text-align: left; }

  .strip { flex-wrap: wrap; row-gap: var(--s1); }
  .open { margin-left: auto; flex: 1 0 100%; text-align: left; display: flex; gap: 5px; align-items: baseline; padding-bottom: 0; }
  .open b { display: inline; order: 2; }
  .open .open-lbl { order: 1; }
  .open .open-lbl::after { content: ""; }
  .open[data-pending="true"] { max-width: none; }

  .brand { flex-wrap: wrap; row-gap: 4px; }
  .brand > span:first-child, .brand .mono { flex: 1 0 100%; }
}
`;
