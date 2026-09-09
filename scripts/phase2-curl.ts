// Phase 2 · verification 4 — hit every endpoint once and print trimmed responses.
//   API_URL=http://localhost:8787 pnpm tsx scripts/phase2-curl.ts

import { existsSync, readFileSync } from "node:fs";
import { loadPhase1Env } from "./_env.js";

const API = (process.env.API_URL ?? "http://localhost:8787").replace(/\/$/, "");
const TRIM = Number(process.env.TRIM ?? 700);
const env = loadPhase1Env();
const partner = existsSync("artifacts/phase2-partner.json") ? (JSON.parse(readFileSync("artifacts/phase2-partner.json", "utf8")) as { partner: { partnerId: number; apiKey: string }; tx: string; marketId: string }) : null;

const trim = (s: string) => (s.length > TRIM ? s.slice(0, TRIM) + ` …(${s.length} chars)` : s);
async function hit(method: string, path: string, opts: { headers?: Record<string, string>; body?: unknown } = {}) {
  const t0 = Date.now();
  const init: RequestInit = { method, headers: { ...(opts.body ? { "content-type": "application/json" } : {}), ...(opts.headers ?? {}) } };
  if (opts.body) init.body = JSON.stringify(opts.body);
  const res = await fetch(`${API}${path}`, init);
  const text = await res.text();
  let pretty = text;
  try {
    pretty = JSON.stringify(JSON.parse(text));
  } catch {
    /* non-JSON */
  }
  console.log(`\n${method} ${path} → ${res.status} (${Date.now() - t0} ms, etag ${res.headers.get("etag") ?? "-"}, ratelimit-remaining ${res.headers.get("x-ratelimit-remaining") ?? "-"})\n${trim(pretty)}`);
  return (text ? JSON.parse(text) : null) as unknown;
}
const arr = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

const venue = env.venueId;
await hit("GET", "/health");
await hit("GET", "/v1/venues");
const live = arr<{ marketId: string }>(await hit("GET", `/v1/markets/live?venue=${venue}&limit=3`));
const recent = arr<{ marketId: string }>(await hit("GET", `/v1/markets/recent?venue=${venue}&limit=3`));
const mid = partner?.marketId ?? live[0]?.marketId ?? recent[0]?.marketId;
if (mid) {
  await hit("GET", `/v1/markets/${mid}`);
  await hit("GET", `/v1/markets/${mid}/book`);
  const fills = arr<{ takerOrderId: string; pool: string }>(await hit("GET", `/v1/markets/${mid}/fills?limit=3`));
  const f = fills[0];
  if (f) await hit("GET", `/v1/orders/${f.takerOrderId}?pool=${f.pool}`);
}
await hit("GET", "/v1/price/BTC");
await hit("GET", "/v1/price/ETH");
await hit("GET", `/v1/stats/venue/${venue}?days=2`);
await hit("GET", `/v1/stats/venue/${venue}/window?hours=6`);
await hit("GET", `/v1/stats/venue/${venue}/window?hours=24`);
if (partner) {
  await hit("GET", `/v1/partners/${partner.partner.partnerId}/public`);
  await hit("GET", `/v1/partners/${partner.partner.partnerId}/stats?hours=24`, { headers: { "x-api-key": partner.partner.apiKey } });
  await hit("GET", `/v1/partners/${partner.partner.partnerId}/fills?limit=2`, { headers: { "x-api-key": partner.partner.apiKey } });
  await hit("GET", `/v1/partners/${partner.partner.partnerId}/fills?limit=2`, { headers: { "x-api-key": "wrong" } });
} else {
  await hit("POST", "/v1/partners", { body: { name: "curl-sample", builderAddress: "0x000000000000000000000000000000000000dEaD" } });
}
await hit("GET", `/v1/wallets/${env.account.address}/positions?limit=20`);
await hit("GET", "/docs/json");
process.exit(0);
