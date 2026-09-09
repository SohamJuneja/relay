# Deploying the four static sites to Vercel

Four projects from one monorepo. Each has a **root directory** and its own
`vercel.json`; all four build from the workspace root so pnpm can resolve the
workspace links, then Vercel publishes that project's output directory.

| Project | Root directory | Output | What it is |
| --- | --- | --- | --- |
| `relay-console` | `apps/console` | `dist` | Partner console and public venue data |
| `relay-demo-site` | `apps/demo-site` | `dist` | Block Ledger, the demo publication |
| `relay-miniapp` | `packages/telegram/miniapp` | `../dist-miniapp` | Telegram Mini App |
| `relay-cdn` | `packages/embed` | `dist` | The widget bundle, served with CORS |

## Once per project

Vercel → Add New → Project → import `SohamJuneja/relay` → **Root Directory** =
the path above → Deploy. The committed `vercel.json` supplies the build command,
output directory and headers, so nothing else needs setting in the dashboard.

The build command in each config starts with `cd ../..` (or `../../..`) and runs
`pnpm install --frozen-lockfile` at the workspace root. Vercel's default install step
is skipped, because installing inside a package directory in a pnpm workspace does not
resolve `workspace:*` links.

## Environment variables

Set these on **Production** (and Preview, if you use it). Everything is a URL, and a
production build **fails loudly** if one is missing rather than silently pointing at
localhost — see `apps/console/src/config.ts`.

**relay-console**

| | |
| --- | --- |
| `VITE_API_URL` | the Render service URL, e.g. `https://relay-server.onrender.com` |
| `VITE_CDN_URL` | the `relay-cdn` URL |
| `VITE_CONSOLE_URL` | this project's own URL |
| `VITE_EXPLORER_URL` | `https://shannon-explorer.somnia.network` |

**relay-demo-site**

| | |
| --- | --- |
| `VITE_RELAY_API` | the Render service URL |
| `VITE_RELAY_CONSOLE` | the console URL |
| `VITE_RELAY_PARTNER` | `3` |
| `VITE_RELAY_BUILDER` | Demo News's builder address |

**relay-miniapp**

| | |
| --- | --- |
| `VITE_RELAY_API` | the Render service URL |
| `VITE_RELAY_PARTNER` | from `packages/telegram/.env.local` |
| `VITE_RELAY_BUILDER` | from `packages/telegram/.env.local` |

**relay-cdn** — none. It is a static bundle.

## Why the CDN is its own project

The widget is loaded by a `<script src>` from origins we do not control, so it needs
permissive CORS and a cache policy that a partner's page can rely on. Its `vercel.json`
sets `Access-Control-Allow-Origin: *`, `Cross-Origin-Resource-Policy: cross-origin`,
and:

```
Cache-Control: public, max-age=300, s-maxage=86400, stale-while-revalidate=604800
```

Five minutes in the reader's browser, a day at the edge, and a week of serving stale
while revalidating. A partner's page keeps working through a bad deploy, and a fix
reaches every reader within five minutes.

Check what got deployed:

```bash
curl -sI https://<cdn>/relay.iife.js | grep -i 'cache-control\|access-control'
curl -s  https://<cdn>/relay.iife.js | grep -o '"[0-9]\+\.[0-9]\+\.[0-9]\+"' | head -1
```

The version also appears in the console footer, read from `Relay.version`.

## The console's SPA rewrite

`react-router` uses real paths, so `/dashboard` must serve `index.html` rather than
404. The rewrite excludes `/assets/` so hashed bundles are still served as files:

```json
{ "source": "/((?!assets/).*)", "destination": "/index.html" }
```

## The mini-app and Telegram

Telegram embeds the Mini App in an iframe, so its `vercel.json` sets a
`frame-ancestors` policy allowing `web.telegram.org`. After the first deploy, point
the bot at it:

```bash
curl -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setChatMenuButton" \
  -H 'content-type: application/json' \
  -d '{"menu_button":{"type":"web_app","text":"Trade","web_app":{"url":"https://<miniapp>"}}}'
```

and set `MINIAPP_URL` in Render so the bot's inline buttons use it too.

## Redeploying

Pushes to `main` redeploy all four. A change to `packages/embed` affects three of them,
because the console and the demo site bundle the widget from source while the CDN ships
it as a file.
