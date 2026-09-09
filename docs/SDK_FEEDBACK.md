# Feedback on the DreamDEX Event Contracts SDK and docs

Written while building Relay against Shannon testnet over six phases. Everything below
is something we actually hit, with the reproduction and what we ended up doing. It is
offered in the spirit of "here is where an integrator loses a day", not as criticism:
the protocol itself behaved correctly in every case, and most of these are documentation
or ergonomics gaps rather than bugs.

Environment: `@somnia-chain/markets-sdk` 0.29.0, Somnia Shannon (chain 50312),
venue `0x679795…e8a28c`, September 2026.

---

## 1. `eth_estimateGas` under-reports a transfer to a never-funded address by 20×

**What we hit.** Our faucet endpoint sent 0.03 STT to a fresh burner wallet with a
30,000 gas limit — twenty per cent above the 21,000 that `eth_estimateGas` returned.
The transaction mined with `status: 0`, burned the entire limit, and the recipient
balance stayed at zero. Because a reverted transfer still returns a transaction hash,
our code reported success and the client waited forever for funds that never arrived.

**Reproduce.**
```bash
# to an address that has never held a balance
cast estimate --value 0.03ether 0xFRESH…            # → 21000
cast send   --value 0.03ether --gas-limit 30000 …   # → status 0, gasUsed 30000
cast send   --value 0.03ether --gas-limit 500000 …  # → status 1, gasUsed 421000
```

**What we did.** Pinned a 600,000 gas limit for the drip and checked the receipt rather
than the hash. Documented in `PROTOCOL_NOTES.md` §14.

**Suggested fix.** A line in the Somnia docs stating that account creation is priced
separately and that `eth_estimateGas` does not include it, with the measured figure.
Ideally the node's estimator would account for it. This is the single most expensive
thing we lost time to, and it is not specific to Event Contracts — anything that funds
a user hits it.

---

## 2. `BinaryMarketsModule` is a proxy, so `eth_getCode` cannot answer capability questions

**What we hit.** `redeemMany` is in the ABI but we could not assume it was deployed, so
we probed the module's bytecode for its selector before using it. The probe returned
false forever and every claim silently fell back to one transaction per market. The
module at `0x3ecC694Cef705358864a646142ac17A90E29e388` returns **130 bytes** of runtime
code — a delegating stub containing no function selectors at all.

**Reproduce.**
```bash
cast code 0x3ecC694Cef705358864a646142ac17A90E29e388 | wc -c   # ~262 chars of hex
```

**What we did.** Replaced the bytecode probe with an `eth_call` simulation of
`redeemMany`, falling back to sequential `redeem` when it reverts.

**Suggested fix.** Note in the SDK docs that the module addresses are proxies, and
recommend simulation over bytecode inspection for feature detection. A
`supportsInterface`-style view, or a documented version getter on the module, would be
better still.

---

## 3. Redeem selectors are easy to get wrong and fail silently

**What we hit.** We hand-wrote the selectors for `redeem` and `redeemMany` and both
were wrong. Nothing failed loudly, because their only consumer was the substring probe
above, which simply kept answering "not supported".

The correct values, confirmed against transactions on chain:

| call | selector |
| --- | --- |
| `redeem(uint32,bytes32,bytes32,uint8,uint256)` | `0x5b1ffcf2` |
| `redeemMany(uint32,bytes32,bytes32[],uint8[],uint256[])` | `0x88cb9474` |
| `setOperator(address,bool)` (ERC-6909) | `0x558a7297` |
| `placeBinaryOrder(...)` | `0x718c2d4d` |

**What we did.** Derive every selector from the same ABI used to encode the call, and
test that the derived values match the ones observed on chain.

**Suggested fix.** Publish the selector table in the SDK docs. It is the kind of
constant every integrator ends up recomputing, and a wrong one is invisible.

---

## 4. `placeBinaryOrder` can return `success = false` without reverting

**What we hit.** An order that the pool declines comes back as a mined transaction with
a `false` in the return data rather than a revert. Code that checks only the receipt
status treats it as filled.

**What we did.** Simulate with `eth_call` and decode `(bool, uint128)` before sending,
and decode the receipt's logs afterwards rather than trusting status alone.

**Suggested fix.** Say so explicitly next to the function in the docs. The current
description reads like a normal write.

---

## 5. `ImmediateOrCancelNoFill` is the common case, not an error case

**What we hit.** Roughly one IOC order in three failed on a thin book because the touch
moved between reading the book and the transaction landing — about 400 ms on this chain.
The revert name reads like a fault; in practice it is ordinary.

**What we did.** Price five ticks through the touch, re-read the book on chain
immediately before signing rather than trusting a streamed snapshot, and retry once
automatically. The pool escrows at the limit and refunds the difference, so crossing
costs the taker nothing when the book is where they thought it was.

**Suggested fix.** A short "placing a taker order that fills" section in the docs
covering exactly this: read the book at signing time, cross the touch, expect and
handle the no-fill. It is the first thing every integrator will need and the one thing
none of the examples show.

---

## 6. The window's opening price is not available when the window opens

**What we hit.** A market becomes `Trading` before `pullNumericAnswer(referenceQuestionId)`
answers. For the first one to two seconds a reference-mode market has no baseline, so a
UI cannot state its own question ("above *what*?"), show the move since open, or draw a
direction.

**Reproduce.** Poll `pullNumericAnswer` for a market's `referenceQuestionId` from the
moment `tradingStart` passes; it reverts for the first second or two, then answers.

**What we did.** Re-poll every two seconds for any trading window older than five
seconds and render an explicit "waiting for the opening price" state rather than a
blank. Measured after that change: 4 of 862 one-second samples still saw the gap.

**Suggested fix.** Either delay `Trading` until the reference answer exists, or expose
the pending state on the market record so a client can distinguish "not yet" from
"never".

---

## 7. `pullNumericAnswer` reverts as a state, not an error

**What we hit.** Unanswered oracle questions revert. Batched through multicall this
fails the whole batch unless every call is marked as allowed to fail, which is easy to
miss and produces a confusing error at the call site.

**What we did.** Every oracle read goes through a batch reader that tolerates
individual failures and treats a revert as "not answered yet".

**Suggested fix.** Document that revert-means-pending, or add a
`tryPullNumericAnswer` returning `(bool answered, int256 value, bool voided)`.

---

## 8. Resolution and price enrichment are two separate writes

**What we hit.** A market flips to `Resolved` before its closing price is readable. Our
client stopped polling on the first resolved snapshot and then displayed a settled
market with a blank closing price, permanently.

**What we did.** Keep polling a few ticks past resolution until the closing price is
present, bounded so it cannot spin.

**Suggested fix.** Worth a sentence in the lifecycle documentation. The states are
`Listed → Trading → Locked → Settling → Resolved`, and "Resolved" does not imply "fully
enriched".

---

## 9. `eth_getLogs` is capped at 1000 blocks, which is 100 seconds here

**What we hit.** With ~100 ms blocks, the standard 1000-block log range covers less than
two minutes of chain. A 24-hour backfill is ~864 chunks. The cap is normal; the
interaction with the block time is what surprises.

**What we did.** Chunked scanning with adaptive range reduction on error and bounded
concurrency.

**Suggested fix.** A worked backfill example in the docs with the arithmetic spelled
out. Every indexer against this chain will write the same loop.

---

## 10. Builder fee cap is 0 on testnet, so the payment path cannot be exercised

**What we hit.** `getMaxBuilderFeeBpsTimes1k()` returns 0 on Shannon. An order with
`builderFeeBpsTimes1k > 0` reverts with `BuilderFeeExceedsCap`. So attribution can be
proven end to end but the fee that makes it economically interesting cannot be tested
before mainnet.

We resolved the ambiguity empirically instead: a non-zero `builder` address with a zero
fee **is** accepted, and `BuilderFeeCharged` is emitted with a zero amount, so the
attribution channel works independently of the fee. That is written up with the
transaction hashes in `docs/BUILDER_FINDINGS.md`.

**Suggested fix.** Either raise the testnet cap above zero, or document explicitly that
`builder` is recorded regardless of the fee. We spent a phase determining this by
experiment, and it is the central question for anyone building distribution.

---

## 11. Two attribution channels, and the docs do not say which is authoritative

**What we hit.** `builder` (an address, on the fill) and `userData` (64 bits, on
`OrderPlaced`) both identify who sent an order, and it is not stated which a venue is
expected to honour, or whether `userData` is reserved.

**What we did.** Treat `userData` as primary for counting — it is on the order, it
survives pool recycling, and it carries more than an address — and `builder` as the
payment channel. Layout in `docs/ATTRIBUTION.md`.

**Suggested fix.** State the intended division in the docs, and whether any bits of
`userData` are reserved by the protocol. If integrators pick incompatible layouts, the
field becomes unusable for anyone downstream.

---

## 12. Pools are recycled across windows, which is not obvious from the ABI

**What we hit.** A `BinaryPool` serves successive markets, with a nonce incrementing on
recycle. Attributing a fill to a market therefore needs the pool **and** the epoch at
that block, not just the pool address. Getting this wrong silently attributes fills to
the previous window.

**What we did.** Track pool epochs as a first-class table and resolve every fill through
`(pool, block) → market`.

**Suggested fix.** Call this out prominently. It is the single most likely source of a
wrong number in any indexer built against this venue, and it fails quietly.

---

## 13. Smaller things

- **Address drift between the kit and the SDK.** `dreamdex-bot-kit` and
  `markets-sdk` disagreed on some addresses; we pinned the SDK's and documented the
  difference. Worth reconciling.
- **`expireTimestampNs` is nanoseconds** while everything else on chain is seconds.
  Easy to be off by 10⁹ and get a revert that does not say so.
- **Fees are `bps × 1000`.** Also easy to get wrong by three orders of magnitude; the
  name helps, an example would help more.
- **Outcome ids are packed** as `(pool << 72) | (nonce << 8) | idx`. We derived this
  from the SDK source; it deserves a line in the docs.
- **`OrderFilled`'s topic0** is worth publishing as a constant. We pinned ours and
  assert it at startup, because a silently changed event signature would show up as
  "no fills" rather than an error.

---

## What worked well

Worth saying, since the rest of this document is problems:

- The chain is genuinely fast, and 100 ms blocks make a trading UI feel different in a
  way that is hard to convey until you use one.
- `parseAbi` interfaces in the SDK matched the deployed contracts everywhere we checked.
- Event coverage is complete: we built the entire indexer from logs alone, with no
  dependency on DreamDEX's own indexer, and every number in our product is derived from
  them.
- Settlement is quick and reliable. Windows resolved within a few seconds of expiry in
  every one of the dozens of cycles we watched.
