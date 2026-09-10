# @relay/telegram-proxy

A Cloudflare Worker that forwards the Telegram Bot API, and nothing else.

## Why it exists

Render's egress to `api.telegram.org` times out. Measured on the deployed instance,
not assumed:

```
order=ipv4first · A=[149.154.166.110] · AAAA=[2001:67c:4e8:f004::9]
TypeError: ETIMEDOUT after 2100 ms
```

DNS resolves both families, `ipv4first` is in effect, and the same process talks to
Neon in us-east-2 and the Somnia RPC continuously. The same request from a laptop
answers `HTTP 200` in 1.3 s. So the route to Telegram specifically is blocked, and no
amount of retrying fixes it — the bot's `getMe` simply never returned, which on
`/health.bot` looked like `running: false, lastError: null`: never started, never
failed.

## Why a proxy and not a webhook

A webhook solves only half of it. Telegram would reach us, but every reply is an
outbound `sendMessage` to the same unreachable host. Pointing grammY's `apiRoot` here
fixes both directions, and leaves long polling and every handler untouched — the bot
code does not know it is talking through anything.

## Deploy

```bash
cd packages/telegram-proxy
npx wrangler secret put BOT_TOKEN     # paste the bot token; it is a SECRET, not a var
npx wrangler deploy
```

Then set `TELEGRAM_API_ROOT` on the server to the printed `workers.dev` URL, with no
trailing slash and no `/bot…` path — grammY appends that itself.

## What it forwards

Only `/bot<TOKEN>/…` for the one token it is configured with, plus `/file/bot<TOKEN>/…`
so a future photo card can fetch what it uploaded. Everything else is `403`.

Method, headers and body pass through untouched, and the body is forwarded as a stream
— so a multipart `sendPhoto` is relayed without the Worker buffering the file. The
upstream response is returned as-is, including its status: grammY's retry logic reads
Telegram's own `429 retry_after` and `409 Conflict`, and rewriting either would break
it.

## What it does not do

It **never logs the path, the query or the body.** The Bot API puts the token in the
path and the body carries users' messages; neither belongs in a log sink. `logpush` and
observability are off in `wrangler.toml` for the same reason.

The token comparison is constant-time. Not because a timing oracle across the public
internet is a practical attack, but because the alternative is code that looks like it
was not thought about.

The proxy adds no exposure the token does not already carry — anyone holding it can
call `api.telegram.org` directly. What the path check prevents is this URL becoming a
free relay for somebody else's bot.
