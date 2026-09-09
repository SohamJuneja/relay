// Run the widget's OWN modules outside the browser to get a real stack trace.
const store = new Map<string, string>();
(globalThis as never as { localStorage: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const { Rpc } = await import("../src/rpc.js");
const { chainInfo, loadOrCreateInstantWallet, FEES } = await import("../src/wallet.js");
const { readMarketContext, readYesBook, quote, placeOrder, faucet, TradeError } = await import("../src/chain.js");
const { RelayApi } = await import("../src/api.js");
const { encodeUserData, SURFACE, ADDRESSES } = await import("@relay/core/browser");

const chain = chainInfo("testnet");
const rpc = new Rpc(chain.rpcUrl);
const api = new RelayApi("http://localhost:8787");
const wallet = loadOrCreateInstantWallet(chain, rpc);
console.log("burner", wallet.address, "| fee cap", FEES.maxFeePerGas / 1_000_000_000n, "gwei");

const drip = await api.gasDrip(wallet.address);
console.log("drip", drip.txHash || "(already funded)", drip.amount);
for (let i = 0; i < 40; i++) {
  if ((await rpc.getBalance(wallet.address)) > 0n) break;
  await new Promise((r) => setTimeout(r, 500));
}
console.log("balance", await rpc.getBalance(wallet.address));

await faucet(rpc, wallet, ADDRESSES.testnet.collateral, 25_000_000n);
console.log("faucet done; balance", await rpc.getBalance(wallet.address));

const markets = await api.liveMarkets({ asset: "BTC", intervalSec: 900, limit: 5 });
const m = markets.find((x) => x.status === 1 && x.secondsToExpiry > 60) ?? markets[0]!;
console.log("market", m.marketId, m.asset, m.intervalSec + "s");
const ctx = await readMarketContext(rpc, m);
const raw = await readYesBook(rpc, ctx.pool, 10);
console.log("book asks", raw.yesAsks.length, "bids", raw.yesBids.length);
const q = quote({ book: m.book ?? null, raw, ctx, outcome: raw.yesAsks.length ? "UP" : "DOWN", budget: 1_000_000n, partner: { builder: "0xb5eCf004491aa8589a82af91633D18867fcFF038", userData: encodeUserData({ partnerId: 1, surfaceId: SURFACE.WEB }) }, nowSec: Math.floor(Date.now() / 1000) });
console.log("quote", q.ok, q.reason ?? "", "qty", q.qty, "escrow", q.escrow);
try {
  const res = await placeOrder({ rpc, wallet, ctx, args: q.args, escrow: q.escrow, outcome: raw.yesAsks.length ? "UP" : "DOWN", onStage: (s) => console.log("  stage:", s) });
  console.log("TRADE OK", res.hash, "filled", res.filledRaw, "tagged", res.tagged, "builder", res.builderSeen);
} catch (e) {
  console.log("FAILED:", e instanceof TradeError ? `TradeError(${e.revertName}) ${e.message}` : (e as Error).message);
  console.log((e as Error).stack?.split("\n").slice(0, 6).join("\n"));
}
process.exit(0);
