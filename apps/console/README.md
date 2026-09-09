# @relay/console — the partner console and the venue's public data page

A static React SPA. Five routes, one API, no server of its own.

| Route | Who it is for | Auth |
| --- | --- | --- |
| `/` | A partner deciding whether to embed Relay. The snippet sits next to a live, working widget. | none |
| `/register` | Getting a partner id, an API key and a filled-in snippet. | none |
| `/dashboard` | What one partner routed: fills, notional, wallets, share of venue flow, projected fees. | `x-api-key` |
| `/ecosystem` | The DreamDEX venue's public data — liquidity, untaken windows, live books, builder leaderboard. | none |
| `/docs/embed` | The widget's README, rendered from the file in `packages/embed`. | none |

```bash
pnpm --filter @relay/console dev        # http://127.0.0.1:5179
pnpm --filter @relay/console build      # dist/, and prints the bundle size
pnpm --filter @relay/console typecheck
node e2e/run.mjs                        # register → trade → dashboard → isolation
```

`VITE_API_URL` points the build at an API (default `http://localhost:8787`);
`VITE_EXPLORER_URL` changes where transaction links go. Both are read at build time,
so a static host needs nothing but the `dist/` directory.

## One family, one token file

Colours, spacing, radii and the typeface pairing all come from `@relay/ui-tokens` —
the same module `packages/embed` imports for its shadow-root stylesheet. The console
loads them as a stylesheet (`@relay/ui-tokens/tokens.css`, generated from the
TypeScript tables by `pnpm --filter @relay/ui-tokens build:css`); the widget
interpolates the same tables into the CSS it injects. A colour can only be changed in
one place, and a test fails if the generated stylesheet drifts from the source.

## The API key

It lives in `sessionStorage`, never `localStorage`, and the register page shows it
exactly once. It is a bearer credential that reads a partner's revenue: closing the
tab should end the session that holds it, and anything longer-lived belongs in the
partner's own password manager. A `401` from any partner-scoped call drops the
session and returns to the key prompt rather than rendering an empty dashboard, which
would read as "you have no fills".

## Numbers

tUSDC to 3 decimals, probabilities to 1, times in the reader's zone with the UTC
instant on hover. Percentages below 1% get two significant figures rather than a
fixed decimal place: a partner routing $0.98 into a $121,000 venue has a real
0.0008% share, and a fixed 1 dp would tell them they brought nothing. `—` means "no
answer", never zero.

## Charts

uPlot, not a charting framework: ~15 KB, canvas, and no opinions about how a
dashboard should look. Colours are read from the live CSS variables when the chart
draws, so a theme toggle repaints rather than leaving the old palette behind.
Category comparisons with a handful of rows are plain DOM bars — a canvas chart for
six rows is harder to read, not easier.

## The live widget

`/` and `/register` mount the real widget from `packages/embed` source, not a
screenshot. A landing page showing a picture of the product is asking to be believed;
one that runs it is not. Trades placed there are real, on Somnia Shannon testnet.
