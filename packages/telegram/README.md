# @relay/telegram — mini-app and bot

Telegram is the second surface. The same widget, the same venue, tagged
`surface=telegram` so the flow it brings is countable on its own.

```bash
pnpm --filter @relay/embed build                  # the widget bundle
pnpm --filter @relay/telegram run setup:partner   # registers "Relay Telegram", writes .env.local
pnpm --filter @relay/telegram miniapp:dev         # http://127.0.0.1:5181
pnpm --filter @relay/telegram bot                 # dry run without a token
```

Note the `run` in `setup:partner`: `pnpm setup` is one of pnpm's own commands and will
rewrite your PATH if you let it shadow a package script. The script is named
`setup:partner` for that reason.

## The mini-app

One page. It reads `Telegram.WebApp`, maps `themeParams` onto CSS variables so the
chrome around the card matches the client, asks for full height, and mounts the widget
with `data-surface="telegram"`. The widget keeps its own tokens inside its shadow root
— that is what the shadow root is for — so Telegram's palette styles the page and the
card stays itself.

Three Telegram-specific behaviours:

- **Swipe-to-close is disabled while a trade is pending.** Telegram closes a Mini App
  on a downward swipe, and that gesture during a signature would abandon a transaction
  already on its way to the chain. It is restored when the fill lands.
- **Haptics** on trade, fill and claim, when the client provides them.
- **`initData` is displayed, never trusted.** Anything security-relevant would have to
  be verified server-side against the bot token. Nothing here is: the wallet is created
  on the device and the order is signed there.

It also works in a plain browser, where it shows a bar saying what you are missing.

### The harness

`/harness.html` defines `Telegram.WebApp` before the app runs — a real palette, a
`colorScheme`, an `initData` string, and recording stubs for every method the app
calls. `window.__harnessCalls` is what a test reads to assert the app expanded, locked
the swipe and buzzed. `?scheme=dark` switches the palette.

The stub sets `__harness: true`, so `isRealTelegram()` still reports false and the
"open in Telegram" bar still appears — because this is, in fact, a browser.

## The bot

grammY. Three commands and a scheduler; it never signs anything and never holds a key.

| | |
| --- | --- |
| `/start` | What this is, plus a button that opens the mini-app. |
| `/market [btc\|eth]` | The live window: question, price against the open, UP/DOWN cents, time left, and a `web_app` button. |
| `/positions` | Says positions live in the mini-app — the bot cannot see a wallet whose key never left the reader's device. |

The scheduler posts a card when a window opens, aligned to **the venue's** boundaries
rather than the wall clock: it reads the live market's `expiry` and treats that instant
as the next window's start. A venue that shifted its epoch by thirty seconds would
leave a wall-clock scheduler posting into the window that just closed, forever.

All copy lives in [`src/copy.ts`](src/copy.ts), with no control flow around it, so
rewording is a one-line diff.

### Dry run

Without `TELEGRAM_BOT_TOKEN` (or with `TELEGRAM_DRY_RUN=true`) the bot prints every
message it would send, using real market data, and the scheduler logs instead of
posting. That is enough to review the copy and the cadence without a token.

## Environment

| Variable | Where | |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | repo `.env` | From BotFather. Absent → dry run. |
| `TELEGRAM_MINIAPP_URL` | repo `.env` | Public **https** URL. Absent → no buttons. |
| `TELEGRAM_CHAT_ID` | repo `.env` | Channel or group for the scheduler. Absent → scheduler off. |
| `TELEGRAM_SCHEDULE_INTERVAL_SEC` | repo `.env` | Which cadence to post. Default 900. |
| `VITE_RELAY_PARTNER`, `VITE_RELAY_BUILDER`, `VITE_RELAY_API` | `packages/telegram/.env.local` | Written by `setup:partner`. |

`.env.local` also holds that partner's API key and is gitignored.

## HTTPS, and BotFather

Telegram will only open a Mini App over https, which a dev server is not.

```bash
pnpm --filter @relay/telegram tunnel
```

That starts **cloudflared** if it is installed, otherwise **localtunnel**, waits for
the URL on stdout, and points the bot's chat menu button at it through
`setChatMenuButton` — the scripted equivalent of BotFather's `/setmenubutton`. Install
one of:

```bash
winget install Cloudflare.cloudflared      # or: brew install cloudflared
npm i -g localtunnel                       # then the script uses `lt`
```

Copy the printed URL into `TELEGRAM_MINIAPP_URL` and restart the bot so its inline
buttons use it too.

### By hand, in BotFather

1. `/newbot` — choose a name and username; it replies with the token. Put it in `.env`
   as `TELEGRAM_BOT_TOKEN`.
2. `/newapp` (or `/myapps` → your bot) — set the Mini App title, description, a 640×360
   photo, and the **https** URL from the tunnel.
3. `/setmenubutton` — pick the bot, choose the web app, paste the same URL. The tunnel
   script does this step for you.
4. `/setcommands` — paste:
   ```
   start - What Relay is
   market - The live window, with a button to trade it
   positions - Where to find what you are holding
   ```
5. For the scheduler: add the bot to a channel or group as an administrator, then put
   that chat's id in `TELEGRAM_CHAT_ID` (a channel id looks like `-1001234567890`).

The tunnel URL changes every restart on the free tiers, so steps 2 and 3 repeat unless
you host the built mini-app somewhere stable — `pnpm --filter @relay/telegram
miniapp:build` emits a static `dist-miniapp/` that any static host will serve.
