# Block Ledger — a fictional publication with Relay embedded

Block Ledger does not exist. It is a two-page newspaper built to answer one question:
does the widget survive contact with somebody else's design, and does flow from that
page get credited to that publisher?

Its stylesheet shares nothing with Relay's. Serif headlines, warm paper neutrals, an
ink-blue accent, a drop cap, an ad slot. If the widget looked at home here by
accident, the demonstration would be worthless.

```bash
pnpm --filter @relay/embed build      # the widget bundle the page loads
pnpm --filter @relay/demo-site dev    # http://127.0.0.1:5180
```

| Path | What it is |
| --- | --- |
| `/` | Front page: a lead story and six teasers, all dated today, all invented. |
| `/btc-window/` | The lead article, with the widget in the right rail. |

## How a real publisher would do this

Two lines, in the page where the card should appear:

```html
<script src="https://cdn.relay.example/relay.iife.js"></script>
<div data-relay-market data-partner="3" data-builder="0xYourBuilderAddress"></div>
```

That is the whole integration, and it is exactly what
[`btc-window/index.html`](btc-window/index.html) contains. The script tag is a static
file — this repo copies it into `public/` from `packages/embed/dist` before dev and
build, which is the local equivalent of putting it on a CDN. The widget renders into
its own shadow root, so Block Ledger's serif and Relay's sans never meet.

`data-partner` and `data-builder` are the two attributes that decide who is credited.
Everything else is optional: this page adds `data-surface="web"`, `data-theme="auto"`,
`data-asset="BTC"` and `data-interval="900"`.

The only thing the demo does beyond those two lines is override the API base from an
environment variable, so the same source can run against a local indexer or a deployed
one. A publisher would hard-code it, or leave it at the default.

| Variable | Default | |
| --- | --- | --- |
| `VITE_RELAY_API` | `http://localhost:8787` | Relay API base |
| `VITE_RELAY_CONSOLE` | `http://127.0.0.1:5179` | where "attribution on-chain" links |
| `VITE_RELAY_PARTNER` | `3` | partner id |
| `VITE_RELAY_BUILDER` | Demo News's address | builder code |

## One widget per page

The mid-article call-out is a link, not a second card. It scrolls to the one in the
rail and flashes it. Mounting a second widget would double every request the page
makes to the API, and give the reader two positions to reconcile when only one of them
is theirs.

## Mobile

Below 860 px the rail moves under the article and stops being sticky — a sticky rail
in a single column follows the reader down the page and covers the thing they are
reading. Verified at 390 px.

## Disclosure

The article is filed as opinion, carries an "Opinion — not financial advice" flag, and
says in its own text that a publication hosting a live market next to commentary about
that market is a conflict worth naming. A real publisher should do at least that much.
