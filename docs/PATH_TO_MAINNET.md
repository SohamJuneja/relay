# Path to mainnet

Everything here is built and measured against Somnia Shannon testnet. This is the list
of what actually changes on mainnet, why, and what is still unknown — written so that
the unknowns are visible rather than discovered during a launch.

Nothing below is speculative about our own code: each item names the file that has to
change. The claims about the *chain* are marked where they are untested, because a
cap-0 testnet pool cannot answer questions about a 1% cap.

---

## 1. Collateral: USDso, 18 decimals

Testnet settles in tUSDC at **6 decimals**; mainnet settles in **USDso at 18**.

`COLLATERAL_DECIMALS` in [`packages/core/src/addresses.ts`](../packages/core/src/addresses.ts)
already carries both, and every conversion in the widget, indexer and API reads it
rather than assuming six. The risk is not the constant — it is anywhere a number went
through JavaScript's `Number` on the way.

- **`notional` is stored as `numeric(78,0)`** and summed in SQL, so totals are safe.
- **The API divides by `10 ** decimals` when it serialises.** At 18 decimals a single
  $1,000,000 notional is `1e24`, well past `Number.MAX_SAFE_INTEGER` (`9.007e15`). The
  division happens *after* the sum, so the sum is exact and only the presented value
  loses precision — acceptable for a dashboard, not for accounting. If these numbers
  ever settle money, serialise the raw string alongside and let the client decide.
- **The widget's order sizing** multiplies a budget by `one`. `Math.round(1 * 1e18)` is
  exact; `Math.round(0.1 * 1e18)` is not (`1.0000000000000000159e17`). Sizing must move
  to `parseUnits` on the string, not arithmetic on a float.

**Verify first:** call `decimals()` on the mainnet collateral rather than trusting the
constant. The kit's venue ids moved three times in a week; assume the same of anything
not read from chain.

## 2. Builder fee: cap 100000 (1%), and `BuilderFeeCharged` starts carrying a number

On testnet the pool's builder fee cap is **0**. [`docs/BUILDER_FINDINGS.md`](BUILDER_FINDINGS.md)
records what that implies, tested:

- A builder address **can** be attached at fee 0 with no `approveBuilder` — accepted.
- `approveBuilder(PARTNER, 0)` is a valid call even at cap 0.
- fee = 1 on a cap-0 pool **reverts** with `BuilderFeeExceedsCap`.

On mainnet the cap is `100000` = 1% (bps × 1000). Three consequences:

1. **`builderFeeBpsTimes1k` stops being decorative.** Everything in this repo sends `0`.
   A partner who wants the fee sets it, and it must be ≤ the pool cap **and** ≤ the
   taker's own `approveBuilder` allowance.
2. **`BuilderFeeCharged` will carry a non-zero `amount`.** The indexer already decodes
   and stores that event into `builder_fee_events` — but every row today has
   `amount = 0`, so **the shape has never been exercised with a real value**. The
   dashboard's "projected builder fee" is exactly that: a projection at
   `BUILDER_FEE_BPS`, computed by us, labelled as a projection. On mainnet it should be
   replaced by the sum of actual `BuilderFeeCharged` amounts, and the two compared for a
   while before the projection is removed.
3. **Takers must approve.** A non-zero fee needs `approveBuilder(builder, cap)` from the
   *taker's* account before the order. That is a second transaction on a reader's first
   trade, which changes the onboarding flow described in §4.

**Untested and important:** whether an approval survives the pool recycling onto its
next market (nonce + 1). If it does not, every window needs a fresh approval and the
one-tap trade is gone. This cannot be answered on a cap-0 pool.

## 3. Gas: a paymaster or EIP-7702, not a drip

[`POST /v1/gas-drip`](../packages/api/src/routes/faucet.ts) sends a few STT to a fresh
burner so it can pay for its own first transaction. It is a testnet stand-in and says so
in its first line. It does not go to mainnet: it is a faucet holding a hot key that
anyone can ask for money.

The replacement is sponsorship, and there are two shapes:

- **A paymaster** — the reader's transaction is submitted by a bundler and the gas is
  paid by a sponsor contract the partner funds. Costs are per-transaction and
  attributable, which fits the model here: the partner already earns the builder fee, so
  sponsoring the gas on the flow they sent is their trade to make.
- **EIP-7702** — the burner delegates to a contract that batches approve + order into
  one authorisation. Somnia supports 7702; the kit's `advanced/batch-7702` example in
  [`reference/`](../reference) is the starting point. This removes a transaction rather
  than paying for one, which is the better fix for the approval problem in §2.

Whichever ships, the widget's onboarding steps (`gas` → `faucet` → `approve` → `order`)
collapse, and the "instant wallet" copy needs rewriting: it currently promises a funded
wallet, and a sponsored one is a different promise.

## 4. Wallets: injected and passkey by default, instant wallet off

The instant wallet keeps a private key in `localStorage`. On a testnet where the money
is a faucet, that is a reasonable trade for removing every barrier to a first trade. On
mainnet it is a browser holding real funds with no recovery path — clear the site data
and it is gone.

- **Default to injected** (EIP-1193) and **passkey** wallets on mainnet.
- **`data-instant-wallet="false"` should be the default**, opt-in rather than opt-out.
- **Auto-claim (§ `data-auto-claim`) is unaffected** in principle — it only ever fires
  for the instant wallet, and `claimMode()` cannot return `auto` for an injected one.
  But if the instant wallet is off by default, auto-claim effectively is too, and the
  redemption UX needs the same sponsorship treatment as §3.

## 5. Proof of name ownership

Registration is open: anyone may POST a partner claiming any builder address and any
name. Today that is bounded by a signature — `POST /v1/partners/:id/verify` proves
control of the *builder address*, and the console shows a verified badge.

That proves the address. It does not prove the **name**. Nothing stops someone
registering "Bloomberg" with an address they control and appearing on a public
leaderboard under it. On testnet that is a nuisance; on mainnet it is impersonation on a
page that also shows money.

What has to exist before mainnet:

- **A namespace check on registration** — reserved names, or a claim flow tied to a
  domain (a DNS TXT record or a well-known file on the homepage already in the
  registration payload).
- **A rename path with an audit trail.** `PATCH /v1/partners/:id` exists and is guarded
  by `ADMIN_TOKEN`, but it records nothing. Any correction on mainnet should be logged
  with who and why.
- **Display rules.** An unverified partner's name should be visibly provisional
  wherever it appears — the leaderboard already distinguishes them; the widget's "via X"
  receipt line does not.

## 6. Rate limits

`API_RATE_LIMIT_PER_MIN` is **120** per IP, one fixed minute window
([`packages/api/src/app.ts`](../packages/api/src/app.ts)). Measured: 140 requests in
3.3 s → 120 × 200 and 20 × 429 with `retry-after: 58`.

That is enough for a page with a widget on it and far too little for a venue with real
traffic, because it is **per IP** — one corporate NAT or one popular publisher is one
bucket. Before mainnet:

- **Key the limit on the API key** where there is one, and keep the IP limit only for
  anonymous reads.
- **Separate the buckets.** A widget polling `/v1/markets/live` and an agent hammering
  `/v1/partners/:id/breakdown` should not share a budget.
- **Return `Retry-After` on the widget path and handle it.** Today a 429 on the market
  lookup surfaces as an error notice; it should back off and retry.

## 7. Postgres sizing, from measured growth

Measured on this venue, per day, including indexes — the numbers in
[`render.yaml`](../render.yaml):

| Table | Rows/day | Bytes/row | Per day |
| --- | --- | --- | --- |
| `orders` | 873,500 | 635 | **529 MB** |
| `raw_events` | 35,377 | 1,127 | 38 MB |
| `fills` | 14,128 | 737 | 10 MB |
| `redemptions` | 10,443 | 716 | 7 MB |
| `protocol_fee_events` | 9,910 | 609 | 6 MB |
| `markets` | 838 | 1,241 | 1 MB |

`orders` is 89% of it and is needed only to attribute a fill whose order arrived in an
earlier chunk. With the retention in `render.yaml` (3 h of orders, 6 h of raw events)
the database settles at **~106 MB of rolling data plus ~11 MB/day of permanent history**
— about 430 MB after a month.

Two things that will not survive mainnet unchanged:

- **This is one venue on a testnet.** Mainnet volume is unknown; the shape scales with
  order count, which is the number that grows fastest.
- **The free tier is the wrong tool.** 0.5 GB was exhausted in hours before retention
  was enforced during the backfill. Mainnet wants a plan with headroom and a real
  backup, and `ORDER_RETENTION_DAYS` becomes a tuning knob rather than a survival
  measure.

**Also:** the API and indexer share one process and one connection pool
(`PG_POOL_MAX=5`) because a free instance has 512 MB. On mainnet they should be separate
services, so a backfill cannot starve the API of connections.

---

## Summary

| # | Change | Where |
| --- | --- | --- |
| 1 | USDso, 18 decimals; `parseUnits` instead of float arithmetic | `packages/core/src/addresses.ts`, widget sizing |
| 2 | Builder fee cap 1%; real `BuilderFeeCharged` amounts; taker `approveBuilder` | `packages/core/src/trade.ts`, dashboard projection |
| 3 | Paymaster or EIP-7702 instead of `/v1/gas-drip` | `packages/api/src/routes/faucet.ts`, widget onboarding |
| 4 | Injected/passkey default, instant wallet opt-in | `packages/embed/src/wallet.ts` |
| 5 | Name ownership, not just address ownership | `packages/api/src/routes/partners.ts` |
| 6 | Rate limit per key, separate buckets, honest `Retry-After` | `packages/api/src/app.ts` |
| 7 | Paid Postgres, split API and indexer processes | `render.yaml` |

The three that are genuinely unknown rather than merely unbuilt: whether
`approveBuilder` survives a pool recycle, the real shape of a non-zero
`BuilderFeeCharged`, and mainnet order volume. The first two need a cap-1% pool to
answer, and everything in §2 depends on them.
