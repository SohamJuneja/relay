# Contributing

## Running it

```bash
pnpm install
docker compose up -d postgres      # or set DATABASE_URL to any Postgres
cp .env.example .env               # fill RPC_URL and, to trade, PRIVATE_KEY
pnpm db:migrate && pnpm indexer:backfill
pnpm api:dev                       # :8787
```

Then any of `pnpm embed:dev` (widget playground, :5178), `pnpm console:dev` (:5179),
`pnpm demo:dev` (:5180), `pnpm tg:miniapp` (:5181).

## Before a pull request

```bash
pnpm typecheck && pnpm -r test
```

Both must pass. `pnpm --filter @relay/embed build` also enforces the widget's gzip
budget, and the build fails if it is exceeded — that budget is a product decision, not
a nice-to-have.

## House style

- **Comments explain why, not what.** A comment that restates the line above it is
  noise; one that records the measurement, the bug, or the constraint behind a choice
  is the most valuable thing in the file.
- **Numbers come from measurements**, and the measurement goes in the comment or in
  `docs/PROTOCOL_NOTES.md`. Several constants in this repo look arbitrary and are not.
- **No silent failure.** If something cannot be computed, return null and render "—";
  never a zero that reads as a real answer.
- **Chain first.** Trading decisions read chain state, never the indexer. The indexer
  is for history and aggregates.

## Tests

Unit tests where behaviour is pure, PGlite where SQL is the thing being tested, and
Playwright against a live testnet for the paths that only exist end to end. A test
that would pass against a mock of the bug is not worth writing.
