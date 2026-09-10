# Attribution design — how Relay knows an order is a partner's

Relay's product is: partner sends order flow → order lands on DreamDEX → the partner is
credited (and, on mainnet, paid). That needs a per-order tag that survives on chain and can
be read back without trusting anything off chain. There are two fields on
`placeBinaryOrder` that can carry it:

```solidity
placeBinaryOrder(kind, price, quantity, expireTimestampNs, orderType, selfMatchingOption,
                 address builder, uint96 builderFeeBpsTimes1k, uint64 userData)
```

## Decision: `userData` is primary, `builder` is secondary

| | `userData` (uint64) | `builder` (+ `builderFeeBpsTimes1k`) |
| --- | --- | --- |
| Where it lands on chain | `OrderPlaced.placedOrder.userData` — on **every** order, always | only in the (undocumented) `BuilderFeeCharged` event **when a fee is charged**, and in the tx calldata |
| Readable from the order's own log? | **yes** — one `OrderPlaced` decode, no tx fetch | **no** — `OrderPlaced` has no builder field; you need the fee event (ABI unknown, never observed on testnet) or `eth_getTransactionByHash` + calldata decode per order |
| Needs a user approval? | no | `approveBuilder(builder, cap)` is a **pool** call the *user* must send when fee > 0 (kit gotcha #13; SDK `fees.ts`) |
| Pools recycle every window | irrelevant | approval is per pool; whether it survives the pool's next market is unknown (open question) |
| Testnet | works (verified §Phase 1) | cap is `0`, so a fee is impossible; tagging with fee 0 is verified separately (`docs/BUILDER_FINDINGS.md`) |
| Mainnet | works | cap `100000` = 1 % — this is what **pays** the partner |
| Spoofable? | yes, by anyone sending the same uint64 (it is opaque MM bookkeeping to the pool) | the fee actually moves collateral to `builder`, so a spoofer pays the partner |

So: **`userData` is the attribution channel** (what the indexer and console count), and
**`builder` is the monetisation channel** (what pays on mainnet). Relay sets both on every
order it routes. A partner is credited if *either* matches; fees are reported from the fee
channel only.

## `userData` layout (v1)

64 bits, big-endian, implemented in `packages/core/src/attribution.ts`:

```
 63      56 55                    24 23          8 7        0
 ┌────────┬─────────────────────────┬─────────────┬──────────┐
 │version │        partnerId        │  surfaceId  │ reserved │
 │ 8 bits │         32 bits         │   16 bits   │  8 bits  │
 └────────┴─────────────────────────┴─────────────┴──────────┘
```

- `version` — `0` = **untagged** (every kit / DreamDEX-app order today sends `userData = 0`;
  any foreign value whose top byte is 0 also decodes as untagged). `1` = this layout.
- `partnerId` — Relay's partner id, 1…2³²−1. `0` is reserved and makes the tag invalid.
- `surfaceId` — where the order came from: `0` unknown, `1` web, `2` telegram, `3` farcaster,
  `4` discord, `5` mobile, `6` api, `7` agent. Room for 65k.
- `reserved` — must be 0 in v1. A non-zero value makes `tagged = false`, so a future v1.x
  cannot be mis-read by a v1 decoder as a plain v1 tag.

`decodeUserData()` never throws on foreign data; it returns `tagged: false`. Tests in
`attribution.test.ts` cover round-trip, bit positions, bounds, version 0, reserved ≠ 0, and
the uint64 ceiling.

Example: partner 42 from Telegram → `0x01_0000002A_0002_00` = `72057594307936768`.

## Surfaces

Four of those ids carry real flow today, and they exist so that "who sent this order"
and "what was the reader looking at" stay separate questions. A partner with a site, a
Telegram channel and a bot is one partner with three surfaces, not three partners.

| Surface | Id | What sends it | Signs with |
| --- | --- | --- | --- |
| `web` | 1 | The embeddable widget on a publisher's page | Instant wallet in the browser, or the reader's injected wallet |
| `telegram` | 2 | The Telegram mini-app | Instant wallet inside the WebView |
| `agent` | 7 | A bot built on [`@relay/sdk`](../packages/sdk) | The operator's own key, in their process |
| `api` | 6 | Anything calling the contracts directly with a Relay tag | Whatever the caller uses |

The split is visible wherever attribution is: `/v1/partners/:id/breakdown` groups by it,
and the console's dashboard shows a "By surface" bar. A publisher who adds a bot sees
both rows under one id rather than having to reconcile two partner accounts.

## Why not encode more (campaign ids, click ids)?

64 bits is all the pool forwards. Campaigns and click-level attribution belong off chain,
keyed by `(txHash, orderId)` which the indexer already has; the on-chain tag only needs to
answer "whose order is this, from which surface".

## Builder fee channel on mainnet

Pool fee unit: `bps × 1000` — `100000` = 100 bps = **1 %** (`getMaxBuilderFeeBpsTimes1k()`;
kit gotcha #13). The order carries `builderFeeBpsTimes1k ≤ min(pool cap, user's
approveBuilder cap)`.

**Projection formula the console uses** (`projectBuilderFee` in `attribution.ts`):

```
notional_raw  = fillPrice_raw × quantityFilled_raw / oneCollateral          (YES-terms fill price)
builderFee    = notional_raw × builderFeeBpsTimes1k / 10_000_000            (bps×1000 → fraction)
```

**Flagged open question — `isTakerSide`.** The pool's `ProtocolFeeCharged` event (identified
in Phase 0) carries `bool isTakerSide`, i.e. protocol fees are charged per **side** with
separate maker/taker rates. `BuilderFeeCharged` has not been observed; it is unknown whether
the builder fee is taken from the taker only (Relay's user, who is the taker in the widget)
or from both sides. The projection takes `sides: 1 | 2` and defaults to **1 (taker only)**;
the console must label the number as a projection until a builder-tagged fill is observed on
mainnet.

Worked example: a widget user buys 100 YES at 0.62 → notional 62 USDso; at the 1 % cap the
builder fee is 0.62 USDso (taker only) or 1.24 USDso (if both sides).

## Operational rules

1. Every Relay order sets `userData = encodeUserData({ partnerId, surfaceId })` **and**
   `builder = partner's builder address`. On testnet `builderFeeBpsTimes1k = 0`; on mainnet
   `min(cap, approved)`.
2. The indexer attributes on `OrderPlaced.userData` (tag) and joins fills by `orderId`; it
   records builder fees from the fee event when one appears.
3. If a pool rejects `builder ≠ 0` at fee 0 (see `docs/BUILDER_FINDINGS.md`), Relay sends
   `builder = address(0)` on that network and relies on `userData` alone — attribution keeps
   working, only the fee channel is off.
