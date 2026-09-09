// Give the mini-app an https URL, and tell BotFather about it.
//
//   pnpm --filter @relay/telegram tunnel
//
// Telegram will only open a Mini App over https, which a localhost dev server is not.
// This starts whichever tunnel is installed, waits for the URL to appear on its
// stdout, and points the bot's menu button at it through the Bot API — so the whole
// loop is one command instead of a copy-paste into a chat with BotFather.

import { spawn } from "node:child_process";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.resolve(here, "../../../.env") });

const PORT = Number(process.env.TELEGRAM_MINIAPP_PORT ?? 5181);
const TOKEN = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** Try cloudflared, then localtunnel. Both print their URL on stdout. */
const CANDIDATES = [
  { cmd: "cloudflared", args: ["tunnel", "--url", `http://127.0.0.1:${PORT}`], match: /https:\/\/[a-z0-9-]+\.trycloudflare\.com/ },
  { cmd: "lt", args: ["--port", String(PORT)], match: /https:\/\/[a-z0-9-]+\.loca\.lt/ },
];

async function has(cmd) {
  return new Promise((resolve) => {
    const p = spawn(process.platform === "win32" ? "where" : "which", [cmd], { shell: true });
    p.on("close", (code) => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
}

const picked = [];
for (const c of CANDIDATES) if (await has(c.cmd)) picked.push(c);

if (picked.length === 0) {
  console.error("No tunnel found. Install one of:");
  console.error("  cloudflared — https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
  console.error("                (winget install Cloudflare.cloudflared / brew install cloudflared)");
  console.error("  localtunnel — npm i -g localtunnel   (then `lt --port 5181`)");
  process.exit(1);
}

const choice = picked[0];
log(`starting ${choice.cmd} for http://127.0.0.1:${PORT}`);
const proc = spawn(choice.cmd, choice.args, { shell: true });

let announced = false;
const onData = async (buf) => {
  const text = String(buf);
  process.stdout.write(text);
  const m = choice.match.exec(text);
  if (!m || announced) return;
  announced = true;
  const url = m[0];
  log(`mini-app URL: ${url}`);
  log(`set TELEGRAM_MINIAPP_URL=${url} in .env and restart the bot`);

  if (!TOKEN) {
    log("no TELEGRAM_BOT_TOKEN — skipping the menu-button update");
    return;
  }
  // Point the chat menu button at the mini-app. This is the same thing BotFather's
  // /setmenubutton does, done over the API so it can be scripted.
  const res = await fetch(`https://api.telegram.org/bot${TOKEN}/setChatMenuButton`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ menu_button: { type: "web_app", text: "Trade", web_app: { url } } }),
  }).catch((e) => ({ ok: false, statusText: e.message }));
  const body = res.json ? await res.json().catch(() => ({})) : {};
  log(body.ok ? "menu button now opens the mini-app" : `menu button not set: ${JSON.stringify(body).slice(0, 200)}`);
};

proc.stdout.on("data", onData);
proc.stderr.on("data", onData); // cloudflared prints its URL on stderr
proc.on("close", (code) => {
  log(`${choice.cmd} exited with ${code}`);
  process.exit(code ?? 0);
});
