# Relay — architecture and phased plan

Relay is a **distribution layer** for DreamDEX Event Contracts on Somnia. Any website or Telegram
bot embeds a widget (or calls a headless SDK) and routes prediction-market order flow to DreamDEX.
Every order is tagged with the partner's on-chain builder code (`builder`,
`builderFeeBpsTimes1k`, `userData` on `placeBinaryOrder`). A chain-log indexer attributes fills
and fees to partners, and a console shows it to them.

The pitch problem Relay solves is visible in the probe: most windows end with **zero fills**
(§5 of `pnpm probe`). DreamDEX has markets every minute but no distribution. Relay brings
order flow from where users already are, and pays the partner a builder fee for it.

## The four parts

```
 partner site / TG bot                     Somnia (Shannon → mainnet)
 ┌──────────────────────┐   signed tx     ┌─────────────────────────────┐
 │ 1. @relay/embed      │ ──────────────▶ │ BinaryPool.placeBinaryOrder │
 │   <relay-market>     │  builder=P      │   (builder, fee, userData)  │
 │   headless SDK       │  userData=tag   └──────────────┬──────────────┘
 └──────────┬───────────┘                                │ logs
            │ reads (chain-first)                        ▼
            ▼                                ┌────────────────────────┐
 ┌──────────────────────┐   rollups          │ 2. @relay/indexer      │
 │ 3. @relay/console    │ ◀───────────────── │   MarketCreated,       │
 │   per-partner stats  │                    │   OrderPlaced/Filled,  │
 └──────────────────────┘                    │   builder fee events   │
                                             └────────────────────────┘
            ▲ shared by all three
 ┌──────────┴───────────┐
 │ 0. @relay/core       │  chain config · addresses · pinned ABIs · discovery from logs ·
 │   (browser-safe)     │  book/pool reads · integer encoding · chunked getLogs
 └──────────────────────┘
```

### 0. `packages/core` — shared, browser-safe (Phase 0 ✓)

- `relayChain()` — viem chain for Shannon/mainnet with multicall3.
- `ADDRESSES` — from markets-sdk 0.29.0, with the kit's drift documented.
- ABIs — `IEventContracts.sol` interfaces as viem `parseAbi`, cross-checked with the SDK;
  event ABIs mirrored from the SDK; `OrderFilled` topic pinned and asserted.
- `scanLogs` — chunked (≤1000 blocks), concurrent, adaptive on range errors.
- `discoverMarketsFromLogs` / `readMarketRecord` / `readMarketStatuses` / `inferVenue`.
- `readYesBooks` → `toFourSided` → `summarizeYes`; `readPoolSnapshot`.
- `scanFills` + `attributeFills` (pool-recycle aware).
- `encoding.ts` — probability ↔ raw price by decimals (string-exact), kinds, order types,
  bps×1000 helpers, outcome-id encoding.

### 1. `packages/embed` — widget + SDK (Phase 3 ✓)

- Web component `<relay-market asset interval>` (Shadow DOM) + `createRelay()` headless API.
- Discovery chain-first (`@relay/core`), indexer as accelerator; polls `status()` before submit.
- Order builder produces calldata for `placeBinaryOrder(kind, price, qty, expireNs, orderType,
  selfMatch, builder, builderFeeBpsTimes1k, userData)`; the host wallet signs (viem
  `walletClient` / EIP-1193). Relay never holds keys.
- Fee flow: read `getMaxBuilderFeeBpsTimes1k()`; if partner fee > 0, prompt `approveBuilder`
  once per pool; on testnet (cap 0) tag `builder ≠ 0, fee 0` if accepted (open question), and
  always set `userData` to a Relay tag (partner id + campaign) as a second attribution channel.
- Receipt handling: require `OrderPlaced`; show fills from `OrderFilled`; show resting orders.
- Telegram bot: same headless SDK; bot signs with a per-user session key
  (`placeBinaryOrderFor` + OperatorPermissionsRegistry, kit `docs/session-keys.md`) — later.

### 2. `packages/indexer` — attribution (Phase 2)

- Backfill + live tail of module/pool/settlement logs into SQLite/Postgres (schema in
  `packages/indexer/README.md`); pool-binding table handles recycling.
- Attribution key = builder address (from the builder-fee event once identified, else decoded
  from `placeBinaryOrder` calldata) + `userData` tag.
- Rollups per partner × day; per market fill counts (the "empty market" metric).
- Independent of the DreamDEX indexer; optional cross-check against `listBuilderFees`.

### 3. `apps/console` + `apps/demo-site` (Phase 3)

- Console: partner sign-in (SIWE), builder-code setup, live cap, stats, CSV export.
- Demo site: a fake crypto-news page with `<relay-market>` embedded + the TG bot, for the demo
  loop: reader trades on a third-party page → order tagged → console shows it.

## Attribution design (why both `builder` and `userData`)

| Channel | Where it lands on chain | Pros | Cons |
| --- | --- | --- | --- |
| `builder` address + `builderFeeBpsTimes1k` | fee event (TBD) / tx calldata | protocol-native, pays the partner | cap 0 on testnet; needs `approveBuilder` when fee > 0; event ABI not in SDK |
| `userData` (uint64) | `OrderPlaced.placedOrder.userData` | always emitted, free, no approval | partner-defined, spoofable, 64 bits |

Relay sets both. `userData` layout (proposal): `[8 bits version][24 bits partnerId][32 bits campaign/nonce]`.

## Phased plan

| Phase | Deliverable | Exit criterion |
| --- | --- | --- |
| **0** (this) | monorepo, `@relay/core`, read-only probe, protocol notes | `pnpm probe` runs clean against Shannon; open questions listed |
| **1** ✓ | signed test orders on testnet resolving open questions #1–#3 | a tagged order landed with `OrderPlaced`; `BuilderFeeCharged` identified |
| **2** ✓ | `@relay/indexer` (Postgres/Drizzle, chain-only, reorg-safe) + `@relay/api` (Fastify, zod, OpenAPI 3.1, WS stream); builder-fee event identified; partner rollups | `GET /v1/partners/:id/fills` shows a tagged fill seconds after it mines, from chain logs only |
| **3** ✓ | `@relay/embed`: Shadow-DOM widget (IIFE / ESM / React), instant wallet, claim flow; `@relay/core/browser`; `POST /v1/gas-drip` + `GET /v1/wallets/:a/claimable` | a headless browser onboards a fresh wallet and places a tagged trade the API attributes to the partner |
| **4** | `apps/console`; Telegram bot; mainnet dry-run with the 1 % cap | partner-facing dashboard; mainnet checklist |

## Non-goals (for now)

Market making, custody, fiat, cross-chain, our own oracle. Relay is distribution + attribution.
