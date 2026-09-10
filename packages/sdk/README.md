# @relay/sdk

**Your agent is a partner.** A bot that trades DreamDEX Event Contracts through Relay
carries the same attribution a publisher's widget does: its operator's partner id in the
order's `userData`, and its operator's builder code on the fee channel. On mainnet that
builder code is the address the builder fee is paid to — so an agent that routes flow
earns on it, exactly as a site that embeds the card does.

On this testnet the pool's builder fee cap is `0`, so the code is an identity and the
taker pays nothing extra for it. The plumbing is the same either way.

```ts
import { createRelay } from "@relay/sdk";

const relay = createRelay({
  rpcUrl: process.env.RPC_URL!,
  privateKey: process.env.PRIVATE_KEY! as `0x${string}`,
  apiUrl: "https://relay-server-htey.onrender.com",
  partnerId: 12,                                   // yours, from POST /v1/partners
  builder: "0xYourBuilderAddress",
});

const [window] = await relay.markets.live({ asset: "BTC", intervalSec: 300 });

const res = await relay.buy({ asset: "BTC", intervalSec: 300, side: "UP", budget: 1 });
// { txHash, filled, avgPrice, spent, tag: { partnerId, surfaceId, builder }, marketId, side }

await relay.positions();
await relay.claimAll();
```

## What it is

A front door onto [`@relay/core`](../core) — the same code the widget and the repo's
scripts use, not a second implementation. Reads go through the Relay API (markets,
books, positions, claimable); writes go straight to the chain, signed locally. **The
private key never leaves your process** and is never sent anywhere.

| | |
| --- | --- |
| `relay.markets.live({ asset, intervalSec })` | Windows currently trading, with their books. |
| `relay.markets.recent({ asset, intervalSec })` | Recently closed windows, for deciding. |
| `relay.markets.get(marketId)` | One market. |
| `relay.buy({ marketId \| {asset,intervalSec}, side, budget, maxPrice? })` | An IOC taker order. `side` is `"UP"` or `"DOWN"`, `budget` is collateral in whole units. Returns the fill and the attribution **as the chain recorded it**, read back from the order's own log rather than from what was intended. |
| `relay.positions()` | Open and settled positions for this account. |
| `relay.claimAll()` | Redeem every won position, in sequence, returning each tx and a total. |

`buy()` takes either a `marketId` or a series (`asset` + `intervalSec`), in which case
it takes the window that is currently trading with more than ten seconds left — an IOC
racing a close is a wasted transaction.

`claimAll()` redeems sequentially on purpose: the positions share one account, and two
redemptions racing for the same nonce is a lost transaction, not a faster one.

## Surfaces

Every order Relay routes says where it came from. `@relay/sdk` tags `surface=agent`, so
agent flow is separable from a publisher's page or a Telegram chat on the leaderboard
and in `/v1/partners/:id/breakdown`.

| Surface | Id | What sends it |
| --- | --- | --- |
| `web` | 1 | The embeddable widget on a publisher's page |
| `telegram` | 2 | The Telegram mini-app |
| `agent` | 7 | A bot using this SDK |
| `api` | 6 | Anything talking to the contracts directly with a Relay tag |

## The example

[`examples/momentum-bot.ts`](examples/momentum-bot.ts) — thirty lines: read the last
three 5-minute windows, buy whichever way they went, $1 a time, then claim what won.

It is not a strategy worth money. Three windows is noise, and a market that has gone up
three times is not thereby more likely to go up again. It is there to show that a bot is
a surface like any other: read, decide, buy, and the attribution rides along without the
bot doing anything about it.

```bash
RPC_URL=… PRIVATE_KEY=0x… API_URL=… RELAY_PARTNER_ID=… RELAY_BUILDER=0x… \
  pnpm --filter @relay/sdk example:momentum
```

## Register first

An agent needs a partner id before its flow can be credited to anyone:

```bash
curl -X POST "$API_URL/v1/partners" -H 'content-type: application/json' \
  -d '{"name":"My Agent","builderAddress":"0xYourBuilderAddress"}'
```

The API key comes back once. Sign the message from
`GET /v1/partners/:id/verification-message` with the builder address's key to have the
claim marked verified — anyone can type any address into that form, and the badge is
what separates a claim from a proof.
