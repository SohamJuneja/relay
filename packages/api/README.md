# @relay/api

Public REST + WebSocket API for the widget and the partner console. Fastify 5, zod-validated
(request and response), OpenAPI 3.1 at **`/docs`** (`/docs/json` for the raw document), CORS open,
60 req/min/IP, ETag on GETs.

```
pnpm api:dev          # tsx watch, http://localhost:8787
API_PORT / API_HOST   # .env
```

| Endpoint | What |
| --- | --- |
| `GET /health` | cursor vs head, lag, DB ok |
| `GET /v1/venues` | per-venue summary + last-24h liquidity |
| `GET /v1/markets/live?venue&asset&intervalSec` | Trading markets with a live book snapshot (RPC, cached 1 s), opening price, seconds to expiry |
| `GET /v1/markets/recent?venue&asset&intervalSec&limit` | recently resolved: winner, opening/closing price, fills |
| `GET /v1/markets/:marketId` · `/book` · `/fills` | one market, its live top-10 book, its fills |
| `GET /v1/price/:asset` | live underlying (SDK feed, 2 s) |
| `GET /v1/stats/venue/:venueId?days` | zero-fill / quoted-but-untaken table (materialised daily) |
| `GET /v1/stats/venue/:venueId/window?hours` | the same over a trailing window, computed live |
| `POST /v1/partners` | register → `{partnerId, apiKey}` (key shown once, stored sha256) |
| `GET /v1/partners/:id/public` | name, fills, notional |
| `GET /v1/partners/:id/stats` · `/fills` | `x-api-key`; builder fee is a **projection** |
| `GET /v1/orders/:orderId?pool` | an order with its decoded tag |
| `GET /v1/wallets/:address/positions` | ERC-6909 balances on traded markets, `redeemable` flag |
| `WS /v1/stream` | `{"subscribe":{"all":true}}` or `{"subscribe":{"markets":[…]}}` → `market_created`, `book` (1 s), `fill`, `market_locked`, `market_resolved`, `price` (2 s) |

The API reads the indexer's Postgres and the RPC; it never talks to the indexer process, so
either can restart independently.
