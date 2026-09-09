# DreamDEX Event Contracts — protocol notes for Relay

Written from a full read of `reference/dreamdex-bot-kit` (README, `docs/event-contracts.md`,
`docs/gotchas.md`, `skills/dreamdex-bot/SKILL.md`, `skills/somnia/SKILL.md`, all of
`packages/ec-core/src/`, `scripts/ec-doctor.ts`, `docs/tests/ec-test-report.md`,
`docs/24-7-operations.md`), `reference/ec-dreamdex-hackathon-template` (`SKILL.md`,
`solidity/src/IEventContracts.sol`, `solidity/script/Lifecycle.s.sol`, `typescript/src/*.mjs`),
and the published `@somnia-chain/markets-sdk` **0.29.0** (`dist/` + shipped `src/`).
Live facts were checked against Shannon on 2026-09-09 (see `scripts/probe.ts`).

> Version note: `npm view @somnia-chain/markets-sdk versions` → latest is **0.29.0**
> (0.28.1 is the previous). The kit pins `^0.28.1`, the template `^0.28.1`. Relay pins
> **0.29.0** exactly. 0.29.0 matters: it corrected the `binaryPoolImpl` constant that
> 0.28.1 had wrong (kit gotcha #22), and it exports `listLiveBinaryMarkets`.

---

## 1. What a market is, and its lifecycle

A binary "event contract" is a question on one asset over one time window ("will BTC be at or
above X at time T?"). Each market owns two ERC-6909 outcome ids on a shared singleton —
**YES** (Up, index 0) and **NO** (Down, index 1). One unit of collateral mints one YES **and**
one NO (`mintSet` / `mintCompleteSet`); the pair can be merged back (`burnSet`). Outcome tokens
trade on a CLOB (the **BinaryPool**). After expiry an oracle resolves; the winning token redeems
for `1 − settlementFee` of collateral, the loser for 0; a **voided** market refunds both sides
(uniform 0.5, or a CLOB-snapshot split on newer venues).
(`hackathon SKILL.md` "The lifecycle"; kit `packages/ec-core/src/settlement.ts` header; SDK
`markets.ts` `MarketOnchain.voidPolicy`.)

Contracts involved (all addresses in §8):

| Contract | Role | Where it is in the sources |
| --- | --- | --- |
| **BinaryMarketsModule** | registry; `createMarket` → emits `MarketCreated`; `redeem`; keeper entries `finalizeMarket` / `releasePool` | SDK `moduleAbi.ts`; template `IEventContracts.sol` `IBinaryMarketsModule` |
| **BinaryMarket** (clone per window) | `status()`, `expiry()`, `payoutNumerators()`, `isResolved/isVoided`, `settlementWindow()`, `voidExpired()` | SDK `readsAbi.ts` `binaryMarketReadAbi`; template `IBinaryMarket` |
| **BinaryPool** (beacon proxy, recycled) | the CLOB: `placeBinaryOrder`, `cancelOrder`, `getBookLevels`, `getBinaryPoolParams`, `approveBuilder`, `mintSet/burnSet`, vault | SDK `tradeAbi.ts` / `readsAbi.ts`; template `IBinaryPool` |
| **BinarySettlement** (singleton) | permanent redemption home after `finalizeMarket`; `getSettlement(marketKey)` | SDK `readsAbi.ts` `binarySettlementAbi` |
| **OutcomeToken** (ERC-6909 singleton) | `balanceOf(owner, id)`, `setOperator` | template `IOutcomeToken6909` |
| **MarketCreator** (rolling series) | creates windows on a cadence; emits its own 13-field `MarketCreated` | SDK `eventsAbi.ts` `marketCreatorEventsAbi` |

Lifecycle in order (kit `docs/event-contracts.md`, SDK `eventsAbi.ts` comments):

1. `createMarket` → `MarketCreated` on the module (and, for series, on the creator). Status `Listed`
   until `tradingStart`, then `Trading` (the Listed→Trading→Settling transitions are
   **timestamp-implicit and emit no event** — SDK `markets.ts` `BinaryMarket.status` docs).
2. `Trading` (status 1): the only status that accepts orders. Orders carry `expireTimestampNs
   ≤ pool.marketExpiryNs()`.
3. At `expiry` the pool **freezes its whole book** until the market is terminal — every cancel
   path reverts `CloseNotCaptured()` (kit gotcha #21). The pool captures a closing price
   (`closingPrice()` / `closingTop()`, newer pools).
4. Oracle answers → `Resolved` (payout vector, one-hot) or `Voided` (kit `settlement.ts`;
   `voidExpired()` becomes callable at `expiry + settlementWindow()`, 300 s on live markets).
5. `finalizeMarket(marketId)` (permissionless keeper) sweeps backing to the settlement
   singleton → `MarketFinalized`; `releasePool` → `PoolReleased` returns the pool to its
   creator's free list, **and the pool is then recycled onto a new market with `marketNonce + 1`**.
6. Winners `redeem(operatorId, venueId, marketId, outcomeIdx, amount)` on the module — pulled
   through the module, which needs an ERC-6909 operator grant to the module (kit gotcha #19).
   Winnings are **claimed, not received** (kit `docs/event-contracts.md` "Winnings are claimed").

## 2. `MarketStatus` enum (on-chain, `BinaryMarket.status()`)

| Code | Name | Accepts orders? |
| --- | --- | --- |
| 0 | Listed | no |
| 1 | **Trading** | **yes** |
| 2 | Locked | no |
| 3 | Settling | no |
| 4 | Resolved | no (redeem) |
| 5 | Voided | no (redeem both sides) |

Source: kit `packages/ec-core/src/markets.ts` `MARKET_STATUS`; SDK `MarketOnchain.status` doc;
template `redeem.mjs` comment. The **indexer** adds a 7th string `"Finalized"` (SDK
`store.d.ts` `BinaryMarketStatus`) — terminal and *not* a chain status. Relay mirrors the enum
in `packages/core/src/status.ts`.

Gate writes on the **chain** status, never the indexer's, which lags by seconds (kit sharp edges
#1, #9; `ec-core/markets.ts` `isTradable`).

## 3. Price / quantity encoding

- **Price = YES probability** in (0,1), scaled by the **collateral's decimals** — *not* a fixed
  1e6. `0.727` → `727000` on 6-dp tUSDC (testnet), `727e15` on 18-dp USDso (mainnet).
  Getting the scale wrong reverts with `PriceOutOfBounds()` / `PostOnlyWouldCross()` that point
  you at the wrong cause (kit gotcha #17). The template's "1e6 units" wording is testnet-only.
- **Every order is quoted on the YES side**, even NO orders: `BUY_NO at p` is sent as YES price
  `1 − p` with `kind = BUY_NO` (kit gotcha #18; `ec-core/orders.ts` `priceYes`). The pool stores
  one book; the NO book is the complement (SDK `orders.ts` `toBinaryBook`):
  `NO bids = YES asks @ (1 − p)`, `NO asks = YES bids @ (1 − p)`.
- **Quantity** = outcome tokens in collateral-decimal units (`oneCollateral = 10^decimals` = one
  whole contract). Collateral escrowed for a buy = `price × quantity / one`.
- **Grid**: `getOrderBookParameters()` → `tickSize`, `minQuantity`, `lotSize`. Testnet measured
  as tick 1e3 / lot 1 (kit `config.ts`); mainnet 1e15 for both. Quantize in integer space
  (`snapDown`), never through a float on an 18-dp venue — `(0.05).toFixed(18)` is three wei off
  the grid and reverts `InvalidPrice` (kit sharp edge #3, `ec-core/orders.ts` header).
- **Fees** are `bps × 1000`: `100000` = 100 bps = 1 %. Fields: `makerFeeBpsTimes1k`,
  `takerFeeBpsTimes1k`, `maxBuilderFeeBpsTimes1k`, `settlementFeeBpsTimes1k`
  (`getBinaryPoolParams`, kit `settlement.ts`). The kit reports a **1 % builder cap on mainnet,
  0 on testnet** (gotcha #13); the probe reads the live value.
- **Order expiry** `expireTimestampNs` is **nanoseconds**, mandatory, `0 < x ≤ marketExpiryNs()`
  (else revert `0xd3dea628`); `0` is not "never" (kit gotcha #2, template SKILL).
- **Outcome ids** (SDK `ids.ts`): `id = (pool << 72) | (nonce << 8) | idx`; `marketKey = id >> 8`.
  Implemented in `packages/core/src/encoding.ts`.

## 4. `venueId` / `marketId` / pools

- **`marketId`** (`bytes32`) is the market's identity — the key for `module.markets()`,
  `getMarketOnchain`, `redeem`, and the indexer's primary key. **Key everything by marketId.**
  On testnet the ids are small integers (`0x…1771e`), on the module they are just registry keys.
- **Pools are recycled.** A pool address is a *time-varying* binding: after finalize + release,
  the same pool serves the next market with `marketNonce + 1`. Anything keyed by pool address
  (state, fee reads, fills) silently mixes markets (kit sharp edge #10; SDK `MarketOnchain.pool`
  docs; kit `settlement.ts` refuses to read a fee from a possibly-recycled pool). Relay's fill
  attribution therefore joins `(pool, blockNumber)` to the latest `MarketCreated` on that pool
  at or before the block (`packages/core/src/fills.ts`).
- **`venueId`** (`bytes32`) + **`operatorId`** (`uint32`) are the *origin* attribution stamped
  at creation (`BinaryMarketsModule.MarketCreated.venueId/operatorId`, and
  `module.markets().originVenueId/originOperatorId`). One deployment hosts several venues side
  by side; the kit refuses to trade unless `VENUE_ID` is set or every live market sits on one
  venue (`ec-core/markets.ts` `activeMarkets`). **Venue ids move** — both networks changed theirs
  three times in a week (kit `docs/event-contracts.md`). Relay infers the venue from live
  `MarketCreated` logs (`inferVenue`) and only uses `.env` as an override.
- `redeem`'s `(operatorId, venueId)` are attribution-only and may be 0 (SDK `moduleAbi.ts`).

## 5. Discovery: chain logs vs indexer

**Chain (authoritative, indexer-free):**
`BinaryMarketsModule.MarketCreated(marketId, market, pool, oracleQuestionId, operatorId,
venueId, creator, collateral, yesId, noId, nonce, outcomeSlotCount, marketType, tradingStart,
expiry, voidPolicy, asset, strike, question, context)` — 19 fields, fires for **every** market,
the only creation event with venue/operator (SDK `eventsAbi.ts` `binaryModuleEventsAbi`).
Then `BinaryMarket.status()` per market for the live gate. Point lookup by id:
`module.markets(marketId)` → `(…, collateral, originOperatorId, originVenueId, …, market, pool,
yesId, noId, tradingStart, expiry)` + `module.marketNonce(marketId)` — exactly what the SDK's
`getMarketOnchain` does (SDK `src/markets.ts:1856`).
`MarketCreator.MarketCreated` (13 fields) is the series creator's own event: it carries
`intervalSec` and `strike` but **no venueId**, and the creator address is not stable (kit
`addresses.ts` says `0x5Ce6…`, SDK 0.29.0 says `0x138C…`, and the 1-minute testnet series come
from a third address). Relay derives `intervalSec = expiry − tradingStart` snapped to the
1m/5m/15m/1h/4h/24h ladder, which is how the indexer derives it too (SDK `BinaryMarket.intervalSec`).

**RPC constraint:** Shannon `eth_getLogs` rejects ranges > **1000 blocks**
(`"block range exceeds 1000"`, measured; template `discover.mjs`, kit `24-7-operations.md`).
Blocks are **~100 ms**, so 1000 blocks ≈ 100 s. A 6-hour window is ~216 k blocks → ~216 calls
per address set; `packages/core/src/logs.ts` chunks and parallelises, halving on range errors.

**Indexer (fast, lagging, sometimes down):** `client.listBinaryMarkets({ venueId, status,
asset, intervalSec, limit })`, `client.listLiveBinaryMarkets()` (expiry > now), `exchange.
loadMarkets()` (unified; **skips finalized binaries**, so it cannot find winnings — kit sharp
edge #11 → use `listBinaryMarkets({ status: "Finalized" })`). Rows carry `venueId`,
`operatorId`, `intervalSec`, `status`, `tradeCount`, volumes. The SDK requires an `indexerUrl`
at construction even if never used, and the live tail/chain reads go over the WebSocket
(`wsRpcUrl`; required unless the chain definition carries one — SDK `config.d.ts`). Endpoints:
testnet `https://dev.smk.somnia.host/v1/graphql`, mainnet `https://prd.smk.somnia.host/v1/graphql`
(kit `ec-core/config.ts`; "the indexer URL moves").

Relay rule: chain first; indexer as an accelerator; reconcile by `marketId`.

## 6. `placeBinaryOrder` — the signature Relay tags

```solidity
function placeBinaryOrder(
    uint8   kind,                 // 0 BUY_YES · 1 SELL_YES · 2 BUY_NO · 3 SELL_NO
    uint256 price,                // YES probability × 10^collateralDecimals
    uint256 quantity,             // outcome tokens × 10^collateralDecimals
    uint64  expireTimestampNs,    // 0 < x <= marketExpiryNs()
    uint8   orderType,            // 0 LIMIT · 1 FILL_OR_KILL · 2 IOC (SDK: MARKET) · 3 POST_ONLY
    uint8   selfMatchingOption,   // 0 CANCEL_TAKER · 1 CANCEL_MAKER
    address builder,              // builder code = an ADDRESS; address(0) = untagged
    uint96  builderFeeBpsTimes1k, // per-order builder fee, bps×1000; <= pool cap AND <= user's approval
    uint64  userData              // opaque; echoed in OrderPlaced.placedOrder.userData
) external payable returns (bool success, uint128 orderId);
```

Sources: template `IEventContracts.sol` `IBinaryPool.placeBinaryOrder`; SDK `tradeAbi.ts`
`binaryPoolWriteAbi` (identical, return named `id`); SDK `orders.ts` `binaryOrderCall` (defaults:
`builder = ZERO_ADDRESS`, `builderFeeBpsTimes1k = 0n`, `userData = 0n`, `expiry =
marketExpiryNs`). There is also `placeBinaryOrderFor(owner, …)` for session keys.

Things the template's doc-comment gets right and the kit re-confirms:

- `success=false` does **not** revert; a mined tx can be a silent rejection — confirm an
  `OrderPlaced` log in the receipt (kit gotcha #8).
- A `POST_ONLY` that would cross **reverts** `PostOnlyWouldCross()` (template SKILL; kit
  `orders.ts`).
- The inherited spot `placeOrder(bool isBid, …)` exists on the pool ABI and **reverts
  `UseBinaryPlacement`** on a binary pool (kit gotcha #18; SDK `tradeAbi.ts`).
- `price = 0` is a real price, not "market"; taker orders must cross a few ticks through the
  touch (kit gotchas #3, #9).

**Events the order emits** (SDK `eventsAbi.ts`): `OrderPlaced(orderId indexed, (orderId, isBid,
owner, userData, price, fullQuantity, quantityRemaining, expireTimestampNs))` — note it carries
`userData` and `owner` but **not** `builder`; `BinaryOrderPlaced(orderId indexed, kind)` — the
only authoritative side source (v2 stopped encoding side in `userData`); `OrderFilled(taker
OrderId indexed, makerOrderId indexed, quantityFilled, takerRemaining, makerRemaining,
fillPrice)` — 6 args, topic0 pinned `0xc87f4223…1a399` (kit `packages/core/src/contract.ts`;
`packages/core/src/abi/events.ts` asserts the ABI-derived selector equals the pin).

## 7. Builder codes — what the kit says

- "Builder codes are **enabled on mainnet** — all four pools report
  `getMaxBuilderFeeBpsTimes1k() = 100000` (a **1 % fee cap**). **Testnet** currently reports a cap
  of `0`." The kit itself trades untagged (`builder = address(0)`, fee 0) and enforces that with
  `assertBuilderDisabled`. "To use a builder code: read the live cap with
  `getMaxBuilderFeeBpsTimes1k()`, call **`approveBuilder`** once, then pass a fee `<= cap`."
  (kit `docs/gotchas.md` #13; `skills/dreamdex-bot/SKILL.md` #13.)
- `approveBuilder(address builder, uint256 maxFeeBpsTimes1k)` is a **pool** function, called by
  the **user** (the payer), and `getBuilderApproval(user, builder)` /
  `getEffectiveBuilderApproval(user, builder)` (= approval clamped by the pool cap) are per-pool
  views (SDK `tradeAbi.ts`, `readsAbi.ts`, `fees.ts`). The SDK's order form "shows the pool
  ceiling and decides whether a one-time approveBuilder is needed before the user has a signer".
- Revert names in the SDK error table: `BuilderFeeExceedsCap`, `BuilderFeeExceedsApproval`,
  `BuilderNotApproved`, `BuilderCodesNotSupported`, `BuilderAddressReserved`, `InvalidBuilder`,
  and router variants `RouterBuilderFeeWithoutBuilder`, `RouterBuilderNotApproved(legIndex, pool,
  fee, approved)`, `RouterBuilderCodesNotSupportedOnPool` (SDK `contractErrorsAbi.ts`).
- The indexer keeps a `BuilderFeeRecord { orderId, builder, payer, token, amount, market, pool,
  timestamp, txHash }` table (`client.listBuilderFees`) and per-venue `maxBuilderFeeBps` /
  `builderFeesCollected` rollups (SDK `fees.ts`, `gql`). The fee **event** is "intentionally not
  decoded in the SDK" (SDK `eventsAbi.ts` comment) — see open questions.
- **Observed live (probe §7, 2026-09-09):** the pool emits
  `ProtocolFeeCharged(uint128 indexed orderId, address indexed payer, address indexed token,
  uint256 amount, bool isTakerSide)` once per fill side (topic0 `0xca479494…`), between
  `BinaryOrderPlaced` and `OrderFilled` in the placing tx. SDK `src/writer.ts` names
  `BuilderFeeCharged` as another pool event it does not decode. The builder event was **not**
  observed (no builder-tagged orders on testnet); by analogy it should carry `(orderId, builder,
  payer, token, amount[, isTakerSide])`, which is exactly the indexer's `BuilderFeeRecord` row.
  Two more identified: module `MarketResolved(bytes32 indexed marketId, uint256 indexed
  oracleQuestionId, uint32 payoutDenominator, uint256[] payoutNumerators, bool voided)` and
  settlement `MarketFinalized(uint256 indexed marketKey, address indexed pool, uint64 nonce,
  address collateralToken, uint256 netBacking, bool voided, uint256[] payoutNumerators)` — the
  SDK's `binarySettlementEventsAbi` still declares the pre-vector `uint8 winningOutcome` form,
  which has a different topic0 and will never match on this deployment. All three live in
  `packages/core/src/abi/events.ts` `observedEventsAbi`.

## 8. Testnet (Shannon) facts

| Item | Value | Source |
| --- | --- | --- |
| chainId | **50312** (mainnet 5031) | kit `skills/somnia/SKILL.md` |
| HTTP RPC | `https://dream-rpc.somnia.network` (alias of `https://api.infra.testnet.somnia.network`) | kit README; SDK `somniaShannon` |
| WS RPC | `wss://api.infra.testnet.somnia.network/ws` (kit `ec-core/config.ts`); SDK also lists `wss://dream-rpc.somnia.network/ws` | |
| block time | ~100 ms (measured 1000 s / 10 000 blocks) | probe §1 |
| getLogs cap | 1000 blocks | measured |
| multicall3 | `0x841b8199E6d3Db3C6f264f6C2bd8848b3cA64223` | SDK `somniaShannon` |
| native gas token | STT (18 dp); mainnet SOMI | kit somnia skill |
| collateral **tUSDC** | `0x70a86D8842FB63C4Ad2b7cdddF530eBf1BB25d8E`, **6 dp**, public `faucet(uint256)` | kit `addresses.ts`; SDK `actionsAbi.ts` `testUsdcAbi` |
| binaryModule | `0x3ecC694Cef705358864a646142ac17A90E29e388` (same on mainnet — CREATE3) | kit + SDK |
| binarySettlement | `0xbF4a49e0Dfd092e5FBE8E5761064C49533e6Ed23` | kit + SDK |
| binaryPoolBeacon | `0x85C01B5ef4F4ed59caC69749565e309f01b14Dbc` | SDK 0.29.0 |
| binaryPoolImpl | `0x48e523c9f22f98548d263f0aD444D732e5202C0E` (SDK 0.29.0; kit/0.28.1 had `0x82A1…`, stale) | kit gotcha #22 |
| marketsCore / collateralRouter / marketCreatorFactory / oracleHub | `0x2802…0294` / `0xbC0C…183C` / `0xE6bE…4F6B` / `0xe40d…E32b` | kit + SDK |
| marketCreator | SDK `0x138CfA6b80475b8c03d7E468b2442278E51e645a`; kit `0x5Ce69567…44e6` (venue-2 creator) | drift — not needed for discovery |
| kit's VENUE_ID hint | `0x679795a0…8a28c` (testnet), `0x458b30c2…432d` (mainnet) — **stale by design** | kit `.env.example` |
| indexer | `https://dev.smk.somnia.host/v1/graphql` | kit `config.ts`, template `.env.example` |
| explorer | `https://shannon-explorer.somnia.network` | kit somnia skill |
| mainnet collateral | USDso `0x00000022dA000002656c64D9eA6011ea952D008A`, **18 dp**, no faucet | kit gotcha #15 |

Somnia gas differences (template SKILL "Somnia gas / tx behavior"): Cancun EVM + EIP-7702;
state creation priced aggressively (estimate gas, never hard-code 21k); base fee floor ~6 gwei —
set `maxFeePerGas` with headroom; EIP-7702 has a ~1.19 M gas intrinsic floor.

## 9. Gotchas that bind a browser widget and an indexer

**Widget / SDK**

1. Gate on `status() == 1` at click time; markets die on schedule (1-minute series exist on
   testnet) and the list you rendered 30 s ago is stale.
2. Scale price/quantity by `decimals()` of the pool's collateral; integer tick/lot math only.
3. `expireTimestampNs` mandatory, ≤ `marketExpiryNs()`; headroom scaled to the window (kit
   `headroomSec`: `max(30, min(300, 0.4 × intervalSec))`).
4. Buys need an ERC-20 **allowance to the pool**; sells need `outcomeToken.setOperator(pool,
   true)` once; redeem needs `setOperator(module, true)` (kit gotcha #19; SDK `orders.ts`
   `placeOrder` autoApprove).
5. `success=false` doesn't revert → check `OrderPlaced` in the receipt; read `orderId` from the
   log, not from a simulation.
6. Post-only can revert `PostOnlyWouldCross`; IOC remainder is dropped; LIMIT remainder **rests
   with escrow locked** — the widget must show open orders (kit sharp edge #4).
7. A user cannot cancel between expiry and terminal (`CloseNotCaptured`).
8. `getBookLevels` returns `[]` on an empty side, never reverts — don't mask RPC errors as
   "empty book" (kit gotcha #12).
9. Fills settle to the **wallet** (auto-pull/auto-deliver); the per-pool vault is a payout
   fallback that normally reads 0 (kit sharp edge #7).
10. Builder tagging: read `getMaxBuilderFeeBpsTimes1k()` live; if the fee is non-zero the user
    must `approveBuilder` first (per pool?). On testnet the cap is 0 → Relay tags with
    `builder ≠ 0, fee = 0` **if the pool accepts it** (open question #1), and always with a
    `userData` tag as a fallback.
11. The SDK opens a WebSocket that keeps Node alive — end scripts with `process.exit(0)`;
    in a browser the SDK expects a **healthy WebSocket** (no HTTP fallback) — the widget should
    keep its own plain `viem` HTTP client for reads, and use the SDK only where it helps.
12. SIWE chain id must match the network (kit gotcha #14).
13. Pools are beacon proxies; don't pin behaviour to an implementation address (kit gotcha #22).
14. Don't parse the question text; use `strike` / `intervalSec` (kit sharp edge #12) — and
    `strike`'s scale is the oracle adapter's (2 dp on OracleHub), `0` means reference mode.

**Indexer**

1. `eth_getLogs` ≤ 1000 blocks; ~100 ms blocks; chunk + parallelise; keep a persistent cursor.
2. Key by `marketId`; model `pool_bindings(pool, nonce, market_id, from_block, to_block)` from
   `MarketCreated` / `PoolReleased`; attribute a pool log to the binding active at its block.
3. Pin `OrderFilled` topic0 and assert it at boot; `OrderPlaced` gives owner + userData;
   `BinaryOrderPlaced.kind` gives the side (never derive side from `userData`).
4. `OrderFilled` fires **before** the taker's `OrderPlaced` in the same tx (SDK `eventsAbi.ts`
   header) — join taker side after the tx's logs are all seen.
5. `fillPrice` is YES-terms; notional = `fillPrice × quantityFilled / one`; value at the
   maker's resting price (kit `24-7-operations.md`).
6. Settlement fee is skimmed **once at finalize** on the settlement singleton
   (`SettlementFeeCharged` there), not per redeem on the pool.
7. The DreamDEX indexer drops finalized binaries from `loadMarkets()`; ours must not.
8. Somnia `eth_getLogs` with **no address filter** over 1000 busy blocks is heavier — prefer
   address lists (pools are few: they're recycled).

## 11. Phase 1 findings — the signed path, verified on Shannon (2026-09-08)

Scripts: `pnpm wallet` → `pnpm builder-matrix` → `pnpm trade` → `pnpm settle` → `pnpm price`.
Core: `packages/core/src/{attribution,trade,settle,errors}.ts`. Design: `docs/ATTRIBUTION.md`.
Matrix: `docs/BUILDER_FINDINGS.md`.

- **Gas.** Somnia's schedule is dear: `faucet(1000e6)` estimates 1.38 M gas and a 300 k limit ran
  out (tx reverted, `gasUsed == gasLimit`); `eth_call` does not catch this. Base fee 6 gwei,
  priority 0 accepted. Relay uses `2 × eth_estimateGas` with 1–3 M floors (`estimateGasWithFloor`).
  A 1-contract IOC that fills costs ~0.43–0.80 M gas.
- **tUSDC faucet** accepts up to somewhere between 10 000 e6 and 100 000 e6 (`FaucetCapExceeded`
  above); 1 000 e6 works.
- **Builder tagging on a cap-0 pool**: `builder ≠ 0, fee 0` is accepted with no approval and emits
  `BuilderFeeCharged(orderId, builder, token, 0)`; `fee = 1` reverts `BuilderFeeExceedsCap`
  (selector `0xf559e808`) both on placement and on `approveBuilder`.
- **Receipt log order for a filling IOC buy** (pool = P, collateral = C, 6909 = T):
  `C.Transfer(escrow pull)` → `P.BinaryOrderPlaced(orderId, kind)` → [`P.BuilderFeeCharged` if
  builder ≠ 0] → `C.Transfer` → `P.ProtocolFeeCharged(makerOrderId, makerOwner, C, amount,
  isTakerSide=true)` → `T.Transfer(6909)` → `P.OrderFilled(taker, maker, qty, …, fillPrice)` →
  `P.OrderPlaced(orderId, {owner, userData, …})`. **`OrderPlaced` fires last** — an indexer must
  buffer a tx's logs before joining. Note the `ProtocolFeeCharged.orderId` was the MAKER's id with
  `isTakerSide = true` on both fills — the field semantics need a second look (open question).
- **Reconciliation**: two 1-contract buys at 0.344 and 0.338 → tUSDC −0.682, YES 6909 +2.000;
  the taker is charged the maker's resting price; fees 0 on testnet.
- **`userData` round-trips** from `OrderPlaced.placedOrder.userData` and from calldata; builder
  round-trips from calldata and from `BuilderFeeCharged.builder`.
- **IOC with nothing to cross REVERTS** `ImmediateOrCancelNoFill()` (`0xd48c4403`); it does not
  mine as a no-op. The touch moves every second on the DreamDEX venue (the maker requotes), so
  an IOC priced exactly at the touch fails often. Price a few ticks through (kit gotcha #9): the
  pool escrows at the limit and **refunds the difference in the same tx** — run 2 escrowed 0.435,
  filled at the maker's 0.315, refunded 0.120.
- **`BUY_NO` mechanics**: sent as `kind 2` at YES price `y`, pays `1 − y` per NO; it crosses YES
  *bids* at ≥ y. When both sides are buys the pool **mints a complete set** (`SetMinted`, YES to
  the maker, NO to us) — nothing is "sold", collateral from both buyers backs the pair.
- **Redeem via the module**: `BinarySettlement.Redeemed(marketKey, holder, to, outcomeIdx,
  amountBurned, collateralOut)` has `holder = BinaryMarketsModule` (it pulled the tokens) and
  `to = the wallet`. Attribute payouts by `to`. The module additionally emits its own
  venue-attributed record (`0xe0f8…`, indexed marketId / holder=wallet / operatorId, data venueId,
  amount) — still unnamed, stored raw by the indexer.

## 13. Phase 2 — indexer facts (see `packages/indexer/README.md`)

- Ingest volume on Shannon: ~100 `MarketCreated` and 0.3–14 k `OrderPlaced` per 20 000 blocks
  (33 min); the 1-minute "Pricefeed test" venue dominates order churn. Pools seen in 24 h: ~300
  (they are recycled, so the address list for `eth_getLogs` stays bounded); a 300-address filter is
  accepted by the RPC.
- The intra-tx log order (§11) is what makes single-pass attribution possible: buffer a tx,
  apply `OrderPlaced` (last) before joining `OrderFilled`s to it.
- Cancels/expiries land in later blocks than the placement → batched `UPDATE … IN (…)`.

## 12. Reference price — where "window open" lives (Phase 1, Step 6)

Verified on market `0x…177a2` (BTC 5 m, open 23:40:00Z, expiry 23:45:00Z, DreamDEX venue):

- **Underlying now**: the SDK's testnet price feed (`SOMNIA_TESTNET_PRICE_FEED`,
  `https://price-feed.dev.oracle.somnia.host/v1/graphql`, quote USDC) — `exchange.fetchPrice("BTC")`
  → `{ price 78445.75, ema 78445.79, datetime 23:45:29Z, block 483379246 }`, ~1 tick/s, 4 s old
  at read time. Same for ETH (2485.45). `client.fetchPriceHistory(asset, { from, to })` gives the
  ticks (`price, ema, blockNumber, blockTimestamp, txHash`). Testnet-only; mainnet has no bundled
  feed (kit `docs/event-contracts.md` "Known limitation").
- **The market's own oracle question** (`module.markets(id).oracleQuestionId` = 52351) is a plain
  sequential **OracleHub** question (`oracleAdapter == oracleHub`). Once resolved,
  `hub.pullNumericAnswer(52351)` = `7844998` → **closing** price 78 449.98 (2 dp, no
  `PRICE_DECIMALS` getter on the hub). It reverts before resolution.
- **The opening price is the answer to a second hub question — the "reference question"** —
  scheduled to resolve at `tradingStart`. For this market it was id 52355, answered at
  `tradingStart + 1 s` (23:40:01Z) with `7845603` → **opening** 78 456.03. Three ways to find it:
  1. **On chain, at creation**: the module emits
     `MarketReference(bytes32 indexed marketId, uint256 indexed referenceQuestionId)`
     (`topic0 0xa304dae0…`, identified by keccak match) right after `MarketCreated`. topic2 ==
     the indexer's `MarketReferenceLink.referenceQuestionId`. In `@relay/core`
     `observedEventsAbi` as `marketReferenceEvent`; Relay's indexer records it as `reference_qid`.
  2. **On chain, after open**: `oracleHub.pullNumericAnswer(referenceQuestionId)` — the widget's
     "BTC now vs window open" needs exactly this plus the live feed.
  3. **Indexer**: `client.getMarketResolution(marketId)` → `reference.oracleQuestionId`,
     `openingAnswer.numericValue`, `closingAnswer.numericValue` (both 2-dp decimal strings).
- `MarketResolved(module)` carries the payout vector only (`[0, 1e7]` here = DOWN won because
  78 449.98 < 78 456.03); **no price**. Do not look for a price there.
- The feed tick nearest to open (23:40:11Z, first tick returned) was 78 457.675 / ema 78 457.17 —
  the hub's 78 456.03 is the oracle's own 23:40:00 observation, not necessarily a feed row, so
  the widget should display the **hub answer** as "open" and the feed as "now", never derive open
  from the feed.
- Reference-mode markets are the ones with `strike == 0` (`binaryResolutionMode`); fixed-strike
  markets have no reference question and `strike` itself is the threshold.
- **Hub questions are shared across consecutive windows.** The 15 m market that opened at
  23:45:00Z (`0x…177b0`) has `referenceQuestionId = 52351` — the *same* id that was the
  **closing** question of the 5 m market that expired at 23:45:00Z (`0x…177a2`). One hub question
  ("BTC/USDC at 23:45:00") is reused (`OracleHub.QuestionReused`) as the close of every window
  ending then and the open of every window starting then. So for a live window the opening price is
  usually **already answered on chain** at `tradingStart + ~1 s`, and the widget can read it with
  one `pullNumericAnswer(referenceQuestionId)` call — no indexer, no feed history.

## 14. Funding a fresh address costs 421 000 gas (Phase 3)

Sending native STT to an address that has **never been funded** is a state-creation
write, and Somnia prices those aggressively. Measured on Shannon 2026-09-09, same
recipient shape each time:

| gas limit | result | gasUsed | recipient balance |
| --- | --- | --- | --- |
| 30 000 | **reverted** | 30 000 (whole limit burned) | 0 |
| 100 000 | **reverted** | 100 000 | 0 |
| 500 000 | success | **421 000** | 0.03 STT |
| 600 000 (production drip) | success | **421 000** | 0.2 STT |

The last row is the E2E's own drip, `0x04a24b40bef2b097d54cbc87fe871afc7a9026a407c116ec92656069305ea570`,
which funded burner `0xB1C8…77a1`: 421 000 gas used against a 600 000 limit. The cost
is flat in the amount sent — it is the account creation that is dear, not the value.

Two traps, both of which the hackathon SKILL.md warns about in general terms and
which bit us concretely:

1. **`eth_estimateGas` answers 21 000** for this transfer — the Ethereum number,
   not the real one. Estimating and sending is not enough; a native transfer to a
   fresh address needs a pinned high limit (Relay's drip uses 600 000).
2. **A reverted transfer still returns a transaction hash.** `POST /v1/gas-drip`
   originally reported success from the hash alone, so the widget sat waiting for
   funds that never came. It now waits for the receipt and reports `drip_failed`
   when `status != success`. Same lesson as `placeBinaryOrder` returning
   `success = false` without reverting: on Somnia, always read the receipt.

## 15. The module is a proxy, so `eth_getCode` cannot answer capability questions (Phase 3)

`BinaryMarketsModule` at `0x3ecC694Cef705358864a646142ac17A90E29e388` returns **130
bytes** of runtime code — a delegating stub. It contains no function selectors, so
searching its bytecode for one answers "not supported" for every method the contract
actually has. Relay shipped a `supportsRedeemMany` probe that did exactly this and
therefore never once returned true; every claim silently fell back to one redeem per
market. Two lessons:

1. **Probe behaviour, not bytecode, behind a proxy.** An `eth_call` either returns or
   reverts, which is the real question. The widget now simulates `redeemMany` and
   falls back on failure.
2. **Derive selectors from the ABI you encode with.** Both hand-written constants were
   wrong (`0x8c0e156d` / `0x0b7bf5f1` against the true `0x5b1ffcf2` / `0x88cb9474`).
   A wrong selector in a substring probe fails silently — there is no error to see.

Verified selectors, from the deployed calls in the Phase 3 E2E:

| call | selector | target |
| --- | --- | --- |
| `redeem(uint32,bytes32,bytes32,uint8,uint256)` | `0x5b1ffcf2` | binary module |
| `redeemMany(uint32,bytes32,bytes32[],uint8[],uint256[])` | `0x88cb9474` | binary module |
| `setOperator(address,bool)` | `0x558a7297` | ERC-6909 outcome token |
| `placeBinaryOrder(...)` | `0x718c2d4d` | pool |
| `faucet(uint256)` | `0x57915897` | tUSDC |

## 16. Resolution and enrichment are two separate writes (Phase 3)

A market flips to `Resolved` before the indexer has written `closingPriceRaw`. A
client that stops polling on the first resolved snapshot renders a settled market
with a blank closing price forever. Poll a few ticks past resolution, bounded.

## 10. OPEN QUESTIONS

1. ~~Does a testnet pool (cap = 0) accept `builder ≠ address(0)` with fee 0?~~ **RESOLVED — YES.**
   Phase 1 simulated and then sent a real IOC with `builder = PARTNER, fee = 0` and **no**
   `approveBuilder`: accepted, filled, and the pool emitted `BuilderFeeCharged(orderId, PARTNER,
   tUSDC, 0)` (`docs/BUILDER_FINDINGS.md`, tx `0x0daeba75…`).
2. ~~Is `approveBuilder` required at fee 0?~~ **RESOLVED — NO.** The gate is on the fee, not on the
   address. `approveBuilder(PARTNER, 0)` is itself a valid pool call (sent, 61k gas) but changes
   nothing at fee 0; `approveBuilder(PARTNER, 1)` reverts `BuilderFeeExceedsCap` on a cap-0 pool,
   so approvals are capped at approval time as well as at placement.
3. **Scope of `approveBuilder`** (still open): it is a pool call with per-pool views; pools are
   recycled per window. Whether one approval survives the pool's next market, and whether a partner
   needs approval on every pool a user touches, needs a mainnet (cap 1 %) test.
4. ~~Exact `BuilderFeeCharged` signature.~~ **RESOLVED in Phase 1** (see §11): the pool emits
   `BuilderFeeCharged(uint128 indexed orderId, address indexed builder, address indexed token,
   uint256 amount)` for every order with `builder ≠ 0`, **even at fee 0** (amount 0). No payer
   field (join `orderId` → `OrderPlaced.owner`), no `isTakerSide`. The oracle-binding event is
   also named now (`MarketReference`, §12). Two module-level topics remain unmatched
   (`UNRESOLVED_OBSERVED_TOPICS` in `events.ts`): a per-market fee-config event
   (`marketId, operatorId, venueId` indexed + `feeRecipient` + 5 fee words — the indexer's
   `MarketVenue` row) and a venue-attributed redeem event.
5. **`OrderPlaced` has no builder field** — chain-only attribution costs an extra
   `eth_getTransactionByHash` per order unless the fee event carries `orderId` (the indexer's
   record does).
6. **Strike decimals** are per oracle adapter (OracleHub 2 dp; price-feed adapter 18 dp) — the
   module record exposes `oracleAdapter`; is `PRICE_DECIMALS()` reliably present?
7. **Which venue is "DreamDEX"** when several appear? The kit says read it off a live row in the
   app; the probe infers when live markets are on one venue only.
8. **Discovery horizon**: indexer-free discovery of 24 h series needs ≥ 24 h of logs (~864
   calls) or a persistent cursor.
9. **`selfMatchingOption` semantics for a widget** where the same wallet may rest and take:
   CANCEL_TAKER (0) vs CANCEL_MAKER (1) — the kit never sets it.
10. **Mainnet builder cap is "1 %"** per the kit — is it per fill notional, and is the fee taken
    from the taker only or from both sides? (`BuilderFeeRecord.payer` suggests per payer.)
