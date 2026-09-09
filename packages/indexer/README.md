# @relay/indexer

Chain-only indexer for DreamDEX Event Contracts on Somnia (Shannon testnet) with Relay partner
attribution. **No dependency on the DreamDEX indexer** — everything comes from `eth_getLogs`,
`eth_getBlockByNumber` and a few `eth_call`s to the OracleHub. The SDK's price feed is used only
for the live underlying price.

```
pnpm db:up              # postgres:16 via docker compose (port 5433)
pnpm db:migrate         # drizzle migrations (checked in under drizzle/)
pnpm indexer:backfill   # cursor (or now − BACKFILL_HOURS) → head − 5, then enrich + stats once
pnpm indexer:tail       # catch up, then follow: blocks every 1.5 s, enrich 5 s, stats 60 s, price candles
pnpm indexer:stats      # recompute the materialised stats
pnpm test               # planner on the real Phase 1 receipts, pool epochs, stats definitions
```

`DATABASE_URL` accepts `postgres://…` or `pglite://<dir>` (embedded Postgres, same migrations).

## How it works

1. **Two passes per range** (`ingest/runner.ts`): module + settlement first (discovers pools and
   opens `pool_epochs`), then every known pool with a topic filter (`POOL_TOPICS`). 1000-block
   chunks, 8 in flight, applied strictly in block order; a chunk is one DB transaction and the
   cursor moves with it. 20 000-block segments keep the pool list fresh during backfill.
2. **Planner** (`ingest/plan.ts`, pure) turns a chunk's decoded logs into rows. It relies on the
   verified intra-tx order `BinaryOrderPlaced → [BuilderFeeCharged] → … OrderFilled … → OrderPlaced`
   (the placing event is LAST), so kind, builder and the taker's own fill are joined before insert.
   Every pool event is attributed through `EpochIndex.resolve(pool, block)` — never by pool alone.
3. **Attribution**: `userData` → `decodeUserData` → `partnerId`/`surfaceId` (v1 tag);
   `BuilderFeeCharged.builder` → `orders.builder`; a fill's attributed side is the **taker**, maker
   attribution is stored in separate columns.
4. **Enrichment** (`enrich/oracle.ts`): opening price = `hub.pullNumericAnswer(referenceQuestionId)`
   once `tradingStart + 2 s` passed; closing = `pullNumericAnswer(oracleQuestionId)` after expiry;
   winner from `MarketResolved.payoutNumerators`. Locked status when expiry passes.
5. **Reorgs**: 5-block confirmation lag; each chunk stores the last block's hash; the tail checks
   the cursor block's hash every poll and on a mismatch deletes everything above `cursor − 50` and
   re-fetches (`rollbackTo`).
6. **Stats** (`stats/compute.ts`): per venue × asset × cadence × UTC day, completed windows only:
   `zeroFillWindows` (0 `OrderFilled`) and `quotedButUntakenWindows` (0 fills AND ≥1 resting bid
   AND ≥1 resting ask). Per partner: fills, notional, unique wallets, markets, hourly series, and
   `projectedBuilderFee = notional × BUILDER_FEE_BPS / 10 000` (taker side; labelled projection).
   `computeVenueWindow` gives the same over an arbitrary trailing window.
7. **Price** (`price/ticker.ts`): SDK feed sampled every 2 s, 1-minute candles persisted.

## Tables

`cursor`, `blocks`, `markets`, `pool_epochs`, `orders`, `fills`, `builder_fee_events`,
`protocol_fee_events`, `redemptions`, `raw_events` (unnamed module events, SetMinted, PoolRecycled,
…), `partners`, `price_candles`, `stats_venue_daily`, `stats_partner`, `stats_partner_hourly`.
Schema: `src/db/schema.ts`. uint256/uint128/uint64 are `numeric(78,0)`; every chain row carries
`(block, block_hash, tx_hash, log_index)`; fills/orders also carry an interpolated block timestamp.

## Facts learned while building it

- `BinarySettlement.Redeemed.holder` is the **module** (it pulls the tokens); the wallet is `to`.
- `ProtocolFeeCharged.orderId` is the maker's id with `isTakerSide = true` on taker fills.
- A `BUY_NO` crossing a YES bid mints a complete set (`SetMinted`) — there is no `Transfer` of
  existing NO tokens.
- `OrderRested` follows `OrderPlaced` in the same tx; cancels/expiries arrive in later blocks, so
  they are batched `UPDATE … WHERE (pool, order_id) IN (…)` statements.
