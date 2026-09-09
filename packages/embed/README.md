# @relay/embed — the DreamDEX Event Contracts widget

One script tag on any page and a reader can take a position on "will BTC be up at
the close of this 15-minute window?" — without leaving the page, installing a
wallet, or knowing what a pool is. Every order carries the partner's builder code
and a Relay attribution tag, so the partner gets credit for the flow.

```html
<script src="https://cdn.example.com/relay.iife.js"></script>
<div data-relay-market data-partner="1" data-builder="0xYourBuilderAddress"></div>
```

That is the whole integration. The widget renders into its own Shadow DOM, so the
host page's CSS cannot reach in and the widget's cannot leak out.

## Attributes

| Attribute | Default | What it does |
| --- | --- | --- |
| `data-relay-market` | — | Marks the mount point. Required for auto-mount. |
| `data-partner` | — | Relay partner id from `POST /v1/partners`. **Without it orders are untagged and earn nothing** (the widget still works and warns in the console). |
| `data-builder` | — | Your builder code (an address). Rides on `placeBinaryOrder`; on mainnet this is what pays you. |
| `data-asset` | `BTC` | `BTC` or `ETH`. |
| `data-interval` | `900` | Window length in seconds: `300`, `900`, `3600`. |
| `data-surface` | `web` | Where the flow came from: `web`, `telegram`, `farcaster`, `discord`, `mobile`, `api`. Encoded into the tag. |
| `data-theme` | `auto` | `auto` (follows `prefers-color-scheme`), `light`, `dark`. |
| `data-api` | `http://localhost:8787` | Your Relay API base URL. |
| `data-venue` | API default | Venue override (bytes32). Normally leave it alone. |
| `data-amounts` | `1,5,10` | Comma-separated amount chips, in collateral units. |
| `data-brand` | `true` | `false` hides the "via Relay" mark. |
| `data-question` | `true` | `false` hides the plain-language question line ("Will BTC be above $79,525.10 at 23:30?"). Set it when the surrounding page already states the question, so the card does not say it twice. |

## JavaScript API

```js
Relay.mount(el, { partner: 1, builder: "0x…", asset: "ETH", intervalSec: 300, api: "https://…", question: false });
Relay.unmount(el);
Relay.autoMount(document);          // mount every [data-relay-market] not yet mounted
Relay.optionsFromElement(el);       // read data-* into an options object
Relay.version;
```

The IIFE build auto-mounts on load and watches the DOM, so widgets added later
(SPA route changes, lazy sections) mount themselves.

## React

```jsx
import { RelayMarket } from "@relay/embed/react";

<RelayMarket partner={1} builder="0x…" asset="BTC" intervalSec={900}
             api="https://api.example.com"
             onTrade={d => …} onFill={d => …} onClaim={d => …} />
```

## Events

Dispatched on the host element and bubbling (composed, so they cross the shadow
boundary):

| Event | Fires | `detail` |
| --- | --- | --- |
| `relay:trade` | the user confirms, before signing | `{ marketId, outcome, amount, partner, builder, userData }` |
| `relay:fill` | our order fills, and for any fill streamed on the open market | `{ txHash, marketId, outcome, filled, tagged, builder }` (streamed fills carry the API's fill row) |
| `relay:claim` | a claim succeeds | `{ hashes, batched, count }` |

## What the card says

Under the header sits one line naming the actual bet — "Will BTC be above
$79,525.10 at 23:30?" — built from the asset, the window's opening price and its
close time, in the reader's own zone with UTC on hover. It switches to the past
tense once the window closes, names the strike instead on a fixed-strike market,
and while the oracle has not yet answered the opening price it says "close above
its opening price" rather than showing a blank. Hide it with `data-question="false"`.

Each side shows the market's probability as the big number and what it costs
underneath: **pay 23.0¢ per $1 share**. Those are the same fact, but only one of
them is a price, and the reader is about to pay it.

Under the button, a positions strip shows what the wallet already has riding on
this asset across every series — "2.54 UP · BTC 5m · settles in 3:03" — and turns
into a claim button when a position settles in the reader's favour. It replaces
the old claim banner, which only appeared after settlement and pushed the card
around when it did.

## Wallets

**Injected (EIP-1193)** — MetaMask, Rabby and friends. The widget switches or adds
Somnia Shannon (chain 50312), then hands the wallet `eth_sendTransaction`.

**Instant wallet** — one click creates a key in the browser, stores it in
`localStorage` under `relay.wallet.<chainId>`, asks the API for a small testnet gas
drip, calls the public tUSDC faucet from the new address, and approves the pool.
Each step is shown as it completes. The card always displays the address with
**Export key** and **Forget** next to it, and says plainly that the key lives in
this browser and is testnet-only. Relay never sees the key: the only thing the
server does is send 0.2 STT, which is the testnet stand-in for a mainnet
paymaster.

## Gas on Somnia

Somnia prices state creation far above Ethereum and `eth_estimateGas` does not
always tell you so. Two numbers measured on Shannon that the widget hard-codes as
floors rather than trusting an estimate:

| operation | real cost | what a naive limit does |
| --- | --- | --- |
| fund a never-funded address | **421 000 gas** | a 30 000 limit mines with status 0 and burns the whole limit; `estimateGas` still says 21 000 |
| ERC-20 `approve`, `faucet`, `setOperator` | 100–300 k | floors of 400–800 k are used |
| `placeBinaryOrder` that fills | 400–870 k | a 1.5 M floor, 3 M ceiling |

Every send pads `eth_estimateGas` by half and applies a floor, and every receipt is
checked — on this chain a mined transaction is not necessarily a successful one.

## What the partner earns

Every order the widget sends carries two things: `userData`, a 64-bit tag with
your partner id and surface, which the indexer reads straight off `OrderPlaced`;
and `builder`, your address, which the pool records in `BuilderFeeCharged`. The
tag is how flow is **counted**; the builder code is how it is **paid**. On Shannon
the pool's builder-fee cap is 0, so tagged orders cost the user nothing and earn
nothing yet — attribution still works end to end. On mainnet the cap is 1 %, and
the console projects revenue as `taker-side notional × fee bps` (a projection,
labelled as such, until a real builder fee is observed). See
`GET /v1/partners/:id/stats` and `docs/ATTRIBUTION.md`.

## States it handles

The result screen follows the market you **traded**, polled by id, not whatever
window the card has moved on to — the card rolls forward as soon as your window
locks, so a verdict tied to the displayed market would never arrive. It keeps
polling for a few ticks after resolution because the closing price is written by a
second pass, and once a claim lands it shows the redeem transaction rather than a
"settling" spinner over money already paid.

`redeemMany` is simulated with `eth_call` before it is sent, and falls back to one
redeem per market. Do not probe for it with `eth_getCode`: the module is a proxy,
130 bytes of delegating stub with no function selectors in it at all, so a bytecode
probe answers "unsupported" for everything.

No live market for the series · window `Locked` (buttons off, countdown to the
next one) · one side of the book empty (that side disabled, with the reason) ·
not enough tUSDC (offers the faucet again on testnet) · a reverted transaction
(shows the decoded contract error, e.g. `ImmediateOrCancelNoFill` → "the price
moved before the order landed") · the WebSocket down (badge plus 3-second REST
polling).

## Development

```bash
pnpm --filter @relay/embed build   # dist/relay.iife.js, relay.es.js, relay-react.es.js + sizes
pnpm --filter @relay/embed dev     # playground on http://127.0.0.1:5178/dev/index.html
pnpm --filter @relay/embed test
node e2e/run.mjs                   # headless Chromium: onboard → trade → attribute → claim
```

The playground mounts the widget three ways (script tag, `Relay.mount`, React),
has a theme toggle and a 300 px column, and logs the host events.

The script-tag panel loads the **built** `relay.iife.js`, served verbatim through
Vite's `publicDir`. That detail matters: point a `<script src>` at a path Vite
treats as source and it will rewrite the file through its module graph and serve a
stale, much larger transform — the page then looks fine while testing code that is
not the build. Rebuild before running the playground or the E2E.

## Size

The script-tag build is a single file with Preact and the viem primitives inlined.
`pnpm build` prints raw/gzip/brotli and fails if the IIFE exceeds the budget
(`RELAY_SIZE_BUDGET_KB`, default 70).

viem's client and actions layer costs 96 KB gzipped on its own, so the widget
keeps viem only for the parts that must not be hand-rolled — ABI encoding and
EIP-1559 signing — and talks to the node through a small `fetch` JSON-RPC client
(`src/rpc.ts`). Order maths is shared with the Node signer through
`@relay/core/browser`'s `buildTakerOrder`, so a preview and a signed order can
never disagree.
