// Relay Phase 0 probe — READ-ONLY.
//
// Proves we can see live DreamDEX Event Contract markets, books, pool params
// and fills on Somnia Shannon from raw chain reads, and reconciles that against
// the markets-sdk (indexer) view. Nothing here signs, sends, or even loads a
// private key. PRIVATE_KEY in .env is ignored on purpose.
//
//   pnpm probe
//
// Env: RPC_URL, WS_RPC_URL, CHAIN_ID, NETWORK, INDEXER_URL, VENUE_ID (blank →
// inferred), PROBE_WINDOW_HOURS (default 6), PROBE_LOG_CONCURRENCY (default 8).

import { config as dotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, formatUnits, getAddress, http, toFunctionSelector, type Address, type Hex } from "viem";
import {
  ADDRESSES,
  COLLATERAL_DECIMALS,
  ENDPOINTS,
  KIT_VENUE_HINTS,
  MarketStatus,
  PINNED_TOPICS,
  TOPICS,
  UNRESOLVED_OBSERVED_TOPICS,
  ZERO_ADDRESS,
  assertPinnedTopics,
  attributeFills,
  binaryPoolReadAbi,
  blocksForDuration,
  discoverMarketsFromLogs,
  erc20Abi,
  estimateBlockTime,
  eventNameForTopic,
  fillsNotional,
  formatBpsTimes1k,
  inferVenue,
  marketStatusLabel,
  networkForChainId,
  readMarketRecord,
  readMarketStatuses,
  readPoolSnapshot,
  readYesBooks,
  relayChain,
  scanFills,
  summarizeYes,
  toFourSided,
  EIP1967_IMPL_SLOT,
  type DiscoveredMarket,
  type Fill,
  type Network,
} from "@relay/core";
import { SomniaMarkets, SOMNIA_MAINNET_ADDRESSES, SOMNIA_TESTNET_ADDRESSES, type BinaryMarket } from "@somnia-chain/markets-sdk";
import { somniaMainnet, somniaShannon } from "@somnia-chain/markets-sdk/chains";

// ─────────────────────────────────────────────────────────────── env / config ──
dotenv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

const env = (k: string): string => (process.env[k] ?? "").trim();
const NETWORK: Network = env("NETWORK").toLowerCase() === "mainnet" ? "mainnet" : "testnet";
const CHAIN_ID = Number(env("CHAIN_ID") || (NETWORK === "mainnet" ? 5031 : 50312));
const RPC_URL = env("RPC_URL") || ENDPOINTS[NETWORK].http[0]!;
const WS_RPC_URL = env("WS_RPC_URL") || ENDPOINTS[NETWORK].ws[0]!;
const INDEXER_URL = env("INDEXER_URL") || ENDPOINTS[NETWORK].indexer;
const VENUE_ID_ENV = env("VENUE_ID");
const WINDOW_HOURS = Number(env("PROBE_WINDOW_HOURS") || 6);
const LOG_CONCURRENCY = Number(env("PROBE_LOG_CONCURRENCY") || 8);
const addrs = ADDRESSES[NETWORK];

if (networkForChainId(CHAIN_ID) !== NETWORK) {
  throw new Error(`CHAIN_ID=${CHAIN_ID} does not match NETWORK=${NETWORK}`);
}

// ────────────────────────────────────────────────────────────────── helpers ──
const out: string[] = [];
const line = (s = "") => {
  out.push(s);
  console.log(s);
};
const hr = (title: string) => {
  line("");
  line(`━━━ ${title} ${"━".repeat(Math.max(0, 74 - title.length))}`);
};
const warn = (s: string) => line(`  WARN  ${s}`);
const openQuestions: string[] = [];
const oq = (s: string) => openQuestions.push(s);

const short = (h: string, n = 10) => (h.length > n * 2 + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h);
const iso = (sec: number | bigint) => new Date(Number(sec) * 1000).toISOString();
const pad = (s: string | number, n: number) => String(s).padEnd(n);
const padL = (s: string | number, n: number) => String(s).padStart(n);
const pct = (num: number, den: number) => (den === 0 ? "n/a" : `${((100 * num) / den).toFixed(1)}%`);
const prob = (p: number | null) => (p === null ? "  —  " : p.toFixed(3));
const ms = (t0: number) => `${Date.now() - t0}ms`;

function withTimeout<T>(p: Promise<T>, msLimit: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${msLimit}ms`)), msLimit);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

const errMsg = (e: unknown): string => {
  const m = (e as { shortMessage?: string; message?: string }) ?? {};
  return (m.shortMessage ?? m.message ?? String(e)).split("\n")[0] ?? "error";
};

// ──────────────────────────────────────────────────────────────────── main ──
async function main(): Promise<void> {
  const chain = relayChain({ network: NETWORK, rpcUrl: RPC_URL, wsRpcUrl: WS_RPC_URL });
  const client = createPublicClient({ chain, transport: http(RPC_URL, { timeout: 30_000, retryCount: 3 }) });
  const decimals = COLLATERAL_DECIMALS[NETWORK];
  const one = 10n ** BigInt(decimals);

  line("Relay · Phase 0 probe (read-only)");
  line(`  network      ${NETWORK} (chain ${CHAIN_ID})`);
  line(`  rpc          ${RPC_URL}`);
  line(`  ws           ${WS_RPC_URL}`);
  line(`  indexer      ${INDEXER_URL}`);
  line(`  binaryModule ${addrs.binaryModule}`);
  line(`  collateral   ${addrs.collateral} (expected ${decimals} dp)`);
  line(`  VENUE_ID     ${VENUE_ID_ENV || "(blank — will infer)"}`);
  line(`  PRIVATE_KEY  ${env("PRIVATE_KEY") ? "present in .env but IGNORED (Phase 0 signs nothing)" : "not set (correct for Phase 0)"}`);

  // Pinned-topic sanity before anything scans logs.
  assertPinnedTopics();
  line(`  OrderFilled topic0 ${TOPICS.OrderFilled} == kit pin ${short(PINNED_TOPICS.OrderFilled, 6)} ✓`);

  // ═════════════════════════════════════════════════════════ 1. RPC health ═══
  hr("1. RPC health");
  const t1 = Date.now();
  const chainIdLive = await client.getChainId();
  const bt = await estimateBlockTime(client, 10_000n);
  const localNow = Math.floor(Date.now() / 1000);
  const drift = localNow - Number(bt.headTimestamp);
  line(`  eth_chainId           ${chainIdLive} ${chainIdLive === CHAIN_ID ? "✓" : `✗ expected ${CHAIN_ID}`}`);
  line(`  latest block          ${bt.head}`);
  line(`  block timestamp       ${bt.headTimestamp} (${iso(bt.headTimestamp)})`);
  line(`  local clock           ${localNow} (${iso(localNow)})`);
  line(`  local − block         ${drift}s ${Math.abs(drift) <= 15 ? "✓" : "(large drift — check RPC lag / local clock)"}`);
  line(`  avg block time        ${bt.secondsPerBlock.toFixed(3)}s over last 10,000 blocks`);
  line(`  multicall3            ${chain.contracts?.multicall3?.address ?? "(none)"}`);
  line(`  (${ms(t1)})`);
  if (chainIdLive !== CHAIN_ID) throw new Error("chain id mismatch — refusing to continue");

  // ═══════════════════════════════════════════════════ 2. market discovery ═══
  hr("2. Live binary markets — chain logs vs markets-sdk, reconciled");
  const windowBlocks = blocksForDuration(WINDOW_HOURS * 3600, bt.secondsPerBlock);
  const toBlock = bt.head;
  const fromBlock = toBlock - windowBlocks > 0n ? toBlock - windowBlocks : 0n;
  line(`  window        ${WINDOW_HOURS}h ≈ ${windowBlocks} blocks → [${fromBlock}, ${toBlock}] (eth_getLogs capped at 1000 blocks/call → ${Math.ceil(Number(windowBlocks) / 1000)} calls, concurrency ${LOG_CONCURRENCY})`);

  // (b) raw chain: BinaryMarketsModule.MarketCreated (19 fields, carries venueId/operatorId)
  const t2 = Date.now();
  let lastPct = -1;
  const discovered = await discoverMarketsFromLogs({
    client,
    binaryModule: addrs.binaryModule,
    fromBlock,
    toBlock,
    concurrency: LOG_CONCURRENCY,
    onProgress: (p) => {
      const q = Math.floor((100 * p.done) / p.total / 25) * 25;
      if (q !== lastPct && q > 0) {
        lastPct = q;
        process.stdout.write(`  … MarketCreated scan ${q}% (${p.logs} logs)\r`);
      }
    },
  });
  line(`  (b) chain: ${discovered.length} MarketCreated logs from module in window (${ms(t2)})`);

  const nowSec = Math.floor(Date.now() / 1000);
  // Live status for EVERY discovered market (multicall), so the fill stats can be sliced by status too.
  const t2b = Date.now();
  const statuses = await readMarketStatuses(client, discovered.map((m) => m.market));
  const statusOf = new Map<Hex, number | null>();
  discovered.forEach((m, i) => statusOf.set(m.marketId, statuses[i] ?? null));
  line(`      status() read for ${discovered.length} markets (${ms(t2b)})`);

  const chainUnexpired = discovered.filter((m) => m.expiry > nowSec);
  const chainTrading = discovered.filter((m) => statusOf.get(m.marketId) === MarketStatus.Trading);

  // (a) markets-sdk: loadMarkets + listLiveBinaryMarkets (indexer-backed). May be down → warn and continue.
  let sdkLive: BinaryMarket[] = [];
  let sdkLoadCount: { total: number; activeBinary: number } | null = null;
  let sdkOk = false;
  const t2a = Date.now();
  try {
    const exchange = new SomniaMarkets({
      indexerUrl: INDEXER_URL,
      chain: NETWORK === "mainnet" ? somniaMainnet : somniaShannon,
      wsRpcUrl: WS_RPC_URL,
      addresses: NETWORK === "mainnet" ? SOMNIA_MAINNET_ADDRESSES : SOMNIA_TESTNET_ADDRESSES,
      // no privateKey: read-only
    });
    sdkLive = await withTimeout(exchange.client.listLiveBinaryMarkets(), 25_000, "listLiveBinaryMarkets");
    try {
      const all = Object.values(await withTimeout(exchange.loadMarkets(true), 25_000, "loadMarkets"));
      sdkLoadCount = { total: all.length, activeBinary: all.filter((m) => m.type === "binary" && m.active).length };
    } catch (e) {
      warn(`markets-sdk loadMarkets failed: ${errMsg(e)} (listLiveBinaryMarkets still succeeded)`);
    }
    sdkOk = true;
    line(`  (a) sdk:   listLiveBinaryMarkets → ${sdkLive.length} rows; loadMarkets → ${sdkLoadCount ? `${sdkLoadCount.total} unified markets, ${sdkLoadCount.activeBinary} active binary` : "n/a"} (${ms(t2a)})`);
    try {
      await Promise.race([Promise.resolve(exchange.close()), new Promise((r) => setTimeout(r, 1500))]);
    } catch {
      /* ignore */
    }
  } catch (e) {
    warn(`markets-sdk / indexer unreachable — continuing on chain reads only: ${errMsg(e)}`);
  }

  // Reconcile by marketId.
  const chainIds = new Set(discovered.map((m) => m.marketId.toLowerCase()));
  const sdkIds = new Set(sdkLive.map((m) => m.marketId.toLowerCase()));
  const chainLiveIds = new Set(chainUnexpired.map((m) => m.marketId.toLowerCase()));
  const inBoth = [...sdkIds].filter((id) => chainLiveIds.has(id));
  const sdkOnly = [...sdkIds].filter((id) => !chainIds.has(id));
  const sdkOnlyExpiredOnChain = [...sdkIds].filter((id) => chainIds.has(id) && !chainLiveIds.has(id));
  const chainOnly = [...chainLiveIds].filter((id) => !sdkIds.has(id));

  // Markets the indexer lists but our window did not see (created before the window,
  // e.g. long-cadence series): resolve them by raw point lookup on the module.
  const resolvedOutOfWindow: DiscoveredMarket[] = [];
  if (sdkOnly.length > 0) {
    for (const id of sdkOnly) {
      const row = sdkLive.find((m) => m.marketId.toLowerCase() === id)!;
      const rec = await readMarketRecord(client, addrs.binaryModule, row.marketId as Hex);
      if (!rec) continue;
      const windowSec = rec.expiry - rec.tradingStart;
      resolvedOutOfWindow.push({
        marketId: row.marketId as Hex,
        market: rec.market,
        pool: rec.pool,
        oracleQuestionId: rec.oracleQuestionId,
        operatorId: rec.operatorId,
        venueId: rec.venueId,
        creator: rec.creator,
        collateral: rec.collateral,
        yesId: rec.yesId,
        noId: rec.noId,
        nonce: rec.nonce,
        outcomeSlotCount: rec.outcomeSlotCount,
        marketType: 0,
        tradingStart: rec.tradingStart,
        expiry: rec.expiry,
        voidPolicy: rec.voidPolicy,
        asset: row.asset,
        strike: BigInt(row.strike ?? "0"),
        question: row.question,
        context: "0x",
        windowSec,
        intervalSec: Number(row.intervalSec ?? windowSec),
        createdAtBlock: BigInt(row.createdAtBlock ?? "0"),
        createdTxHash: (row.createdByTx ?? "0x") as Hex,
        logIndex: 0,
      });
    }
    const st = await readMarketStatuses(client, resolvedOutOfWindow.map((m) => m.market));
    resolvedOutOfWindow.forEach((m, i) => statusOf.set(m.marketId, st[i] ?? null));
  }

  if (sdkOk) {
    line(`  reconcile  in both: ${inBoth.length} · sdk-only: ${sdkOnly.length} (created before window; ${resolvedOutOfWindow.length} resolved via module.markets()) · sdk-listed but expired on chain: ${sdkOnlyExpiredOnChain.length} · chain-only (unexpired, not in sdk): ${chainOnly.length}`);
    if (chainOnly.length > 0) {
      line(`             chain-only ids: ${chainOnly.map((id) => short(id, 6)).join(", ")}  (indexer lag: rows appear seconds after MarketCreated)`);
    }
    if (sdkOnlyExpiredOnChain.length > 0) {
      line(`             sdk says live but expiry passed on chain: ${sdkOnlyExpiredOnChain.map((id) => short(id, 6)).join(", ")}`);
    }
  } else {
    line(`  reconcile  skipped (sdk unavailable). Chain view stands alone.`);
  }

  // The live set we act on: chain-discovered unexpired ∪ out-of-window resolved.
  const live = [...chainUnexpired, ...resolvedOutOfWindow].sort((a, b) => a.expiry - b.expiry);
  const expiredInWindow = discovered.filter((m) => m.expiry <= nowSec);

  line("");
  line(`  live (unexpired) markets: ${live.length}   ·   expired in window: ${expiredInWindow.length}`);
  line("");
  line(`  ${pad("marketId", 14)} ${pad("pool", 14)} ${pad("asset", 5)} ${padL("strike(raw)", 12)} ${padL("intv", 6)} ${pad("expiry (ISO)", 24)} ${pad("status", 13)} ${pad("venueId", 14)} op`);
  for (const m of live) {
    line(
      `  ${pad(short(m.marketId, 5), 14)} ${pad(short(m.pool, 5), 14)} ${pad(m.asset, 5)} ${padL(m.strike.toString(), 12)} ${padL(m.intervalSec, 6)} ${pad(iso(m.expiry), 24)} ${pad(marketStatusLabel(statusOf.get(m.marketId)), 13)} ${pad(short(m.venueId, 5), 14)} ${m.operatorId}${m.windowSec !== m.intervalSec ? `  (window ${m.windowSec}s)` : ""}`,
    );
  }
  line("");
  line("  strike is the raw oracle value (OracleHub answers in 2 dp → 7853895 = 78538.95); intv = expiry − tradingStart snapped to the 1m/5m/15m/1h/4h/24h ladder.");

  // Status distribution over everything discovered.
  const dist = new Map<string, number>();
  for (const m of [...discovered, ...resolvedOutOfWindow]) {
    const k = marketStatusLabel(statusOf.get(m.marketId));
    dist.set(k, (dist.get(k) ?? 0) + 1);
  }
  line(`  status distribution (all ${discovered.length + resolvedOutOfWindow.length} discovered): ${[...dist.entries()].map(([k, v]) => `${k}=${v}`).join(", ")}`);

  // Venue inference.
  const vi = inferVenue(live);
  line("");
  line(`  venues among live markets: ${[...vi.byVenue.entries()].map(([v, n]) => `${v} (${n})`).join(" | ") || "(none)"}`);
  line(`  operators among live markets: ${[...vi.byOperator.entries()].map(([o, n]) => `${o} (${n})`).join(" | ") || "(none)"}`);
  const kitHint = KIT_VENUE_HINTS[NETWORK].toLowerCase();
  // Per-venue breakdown of the live set: who is on it, what cadences, is it the kit's hint.
  const venueRows = new Map<string, { op: Set<number>; assets: Set<string>; intervals: Set<number>; n: number; trading: number }>();
  for (const m of live) {
    const k = m.venueId.toLowerCase();
    const r = venueRows.get(k) ?? { op: new Set(), assets: new Set(), intervals: new Set(), n: 0, trading: 0 };
    r.op.add(m.operatorId);
    r.assets.add(m.asset);
    r.intervals.add(m.intervalSec);
    r.n++;
    if (statusOf.get(m.marketId) === MarketStatus.Trading) r.trading++;
    venueRows.set(k, r);
  }
  line("  per venue (live set):");
  for (const [v, r] of [...venueRows.entries()].sort((a, b) => b[1].n - a[1].n)) {
    line(
      `    ${v}  op=${[...r.op].join(",")}  live=${r.n} trading=${r.trading}  assets=${[...r.assets].join("/")}  cadences=${[...r.intervals].sort((a, b) => a - b).join("/")}s${v === kitHint ? "  ← kit's DreamDEX VENUE_ID hint" : ""}`,
    );
  }
  if (vi.inferredVenueId) {
    line(`  VENUE_ID inferred: ${vi.inferredVenueId}  ${vi.inferredVenueId === kitHint ? "(matches kit hint)" : `(DIFFERS from kit hint ${short(kitHint, 6)} — venue ids move; use the inferred value)`}`);
    if (VENUE_ID_ENV && VENUE_ID_ENV.toLowerCase() !== vi.inferredVenueId) warn(`VENUE_ID in .env (${short(VENUE_ID_ENV, 6)}) does not match the live venue`);
  } else if (vi.byVenue.size > 1) {
    warn(`live markets span ${vi.byVenue.size} venues — cannot infer a single VENUE_ID; set it explicitly`);
    if (venueRows.has(kitHint)) {
      line(`  VENUE_ID recommended: ${KIT_VENUE_HINTS[NETWORK]}  (the kit's DreamDEX venue hint is LIVE here with ${venueRows.get(kitHint)!.n} markets — use it until confirmed against the app)`);
    }
    oq(`Live markets span ${vi.byVenue.size} venues (${[...vi.byVenue.keys()].map((v) => short(v, 6)).join(", ")}). The kit's hint ${short(kitHint, 6)} is ${venueRows.has(kitHint) ? "live (BTC/ETH reference-mode series, strike=0)" : "NOT live"}. Confirm which venue the DreamDEX app trades by reading a live row in the app; the others look like third-party/test operators (e.g. 'Pricefeed test' 1m series on op 4, 'BOTNAV' on op 20).`);
  } else {
    warn("no live markets — cannot infer VENUE_ID");
  }
  const allVenue = inferVenue([...discovered]);
  if (allVenue.byVenue.size > 1) {
    line(`  note: over the whole ${WINDOW_HOURS}h window ${allVenue.byVenue.size} venues appear: ${[...allVenue.byVenue.entries()].map(([v, n]) => `${short(v, 6)}=${n}`).join(", ")}`);
  }

  // ════════════════════════════════════════════════════════════ 3. books ═══
  hr("3. Order books for Trading markets (getBookLevels, top 5 each side)");
  const trading = live.filter((m) => statusOf.get(m.marketId) === MarketStatus.Trading);
  const t3 = Date.now();
  const books = await readYesBooks(client, trading.map((m) => m.pool), 5);
  line(`  ${trading.length} Trading markets, ${books.length} book reads (${ms(t3)})`);
  let emptyBooks = 0;
  let oneSided = 0;
  const bookSummaries: Array<{ m: DiscoveredMarket; s: ReturnType<typeof summarizeYes> }> = [];
  for (const [i, m] of trading.entries()) {
    const b = books[i];
    line("");
    line(`  ▸ ${m.asset} ${m.intervalSec}s  marketId=${short(m.marketId, 6)}  pool=${m.pool}  expires ${iso(m.expiry)} (${Math.round((m.expiry - nowSec) / 60)}m)`);
    if (!b || "error" in b) {
      warn(`getBookLevels failed: ${b && "error" in b ? b.error : "no result"}`);
      continue;
    }
    const four = toFourSided(b, one);
    const s = summarizeYes(b, decimals);
    bookSummaries.push({ m, s });
    if (s.empty) emptyBooks++;
    else if (s.bidEmpty || s.askEmpty) oneSided++;
    const fmtSide = (ls: typeof four.yesBids) => (ls.length === 0 ? "(empty)" : ls.map((l) => `${formatUnits(l.price, decimals)}×${formatUnits(l.quantity, decimals)}`).join("  "));
    line(`    YES bids  ${fmtSide(four.yesBids)}`);
    line(`    YES asks  ${fmtSide(four.yesAsks)}`);
    line(`    NO  bids  ${fmtSide(four.noBids)}   (= 1 − YES asks)`);
    line(`    NO  asks  ${fmtSide(four.noAsks)}   (= 1 − YES bids)`);
    line(
      `    YES best bid ${prob(s.bestBid)}  best ask ${prob(s.bestAsk)}  mid ${prob(s.mid)}  spread ${s.spread === null ? "  —  " : `${(s.spread * 100).toFixed(1)} pts`}  ` +
        `flags: bidEmpty=${s.bidEmpty} askEmpty=${s.askEmpty} bookEmpty=${s.empty}`,
    );
  }
  line("");
  line(`  summary: ${trading.length} Trading · ${emptyBooks} with EMPTY book (${pct(emptyBooks, trading.length)}) · ${oneSided} one-sided · ${trading.length - emptyBooks - oneSided} two-sided`);

  // ══════════════════════════════════════════════════════ 4. pool params ═══
  hr("4. getBinaryPoolParams (one pool — all fields)");
  const samplePool = trading[0]?.pool ?? live[0]?.pool ?? discovered[discovered.length - 1]?.pool;
  if (!samplePool) {
    warn("no pool to read");
  } else {
    const snap = await readPoolSnapshot(client, samplePool);
    const p = snap.params;
    line(`  pool                         ${samplePool}${trading[0] ? `  (market ${short(trading[0].marketId, 6)}, ${trading[0].asset} ${trading[0].intervalSec}s)` : ""}`);
    line(`  collateralToken              ${p.collateralToken}`);
    line(`  market                       ${p.market}`);
    line(`  outcomeToken (ERC-6909)      ${p.outcomeToken}`);
    line(`  yesId                        ${p.yesId}`);
    line(`  noId                         ${p.noId}`);
    line(`  oneCollateral                ${p.oneCollateral}  (= 10^${p.oneCollateral.toString().length - 1} → ${p.oneCollateral === one ? `${decimals} dp ✓` : `MISMATCH vs expected ${decimals} dp`})`);
    line(`  setBacking                   ${p.setBacking}  (${formatUnits(p.setBacking, decimals)} collateral)`);
    line(`  feeRecipient                 ${p.feeRecipient}`);
    line(`  makerFeeBpsTimes1k           ${formatBpsTimes1k(p.makerFeeBpsTimes1k)}`);
    line(`  takerFeeBpsTimes1k           ${formatBpsTimes1k(p.takerFeeBpsTimes1k)}`);
    line(`  maxBuilderFeeBpsTimes1k      ${formatBpsTimes1k(p.maxBuilderFeeBpsTimes1k)}  ← builder-code cap`);
    line(`  settlementFeeBpsTimes1k      ${formatBpsTimes1k(p.settlementFeeBpsTimes1k)}`);
    line(`  settlement                   ${p.settlement}${p.settlement.toLowerCase() === addrs.binarySettlement.toLowerCase() ? " (= known BinarySettlement ✓)" : " (≠ known BinarySettlement!)"}`);
    line(`  marketNonce                  ${p.marketNonce}`);
    line(`  finalized                    ${p.finalized}`);
    line(`  ── extra reads ──`);
    line(`  getMaxBuilderFeeBpsTimes1k() ${snap.maxBuilderFeeBpsTimes1k === null ? "revert" : snap.maxBuilderFeeBpsTimes1k.toString()}${snap.maxBuilderFeeBpsTimes1k === p.maxBuilderFeeBpsTimes1k ? " (agrees with params ✓)" : ""}`);
    line(`  getOrderBookParameters()     ${snap.bookParams ? `tickSize=${snap.bookParams.tickSize} minQuantity=${snap.bookParams.minQuantity} lotSize=${snap.bookParams.lotSize}` : "revert"}`);
    line(`  marketExpiryNs()             ${snap.marketExpiryNs === null ? "revert" : `${snap.marketExpiryNs} (${iso(snap.marketExpiryNs / 1_000_000_000n)})`}`);
    line(`  booksEmpty()                 ${snap.booksEmpty === null ? "revert" : snap.booksEmpty}`);
    line(`  market.settlementWindow()    ${snap.settlementWindowSec === null ? "revert" : `${snap.settlementWindowSec}s`}`);
    for (const e of snap.errors) warn(e);
    if (p.maxBuilderFeeBpsTimes1k === 0n) {
      line(`  → builder fee cap is 0 on this pool: a non-zero builderFeeBpsTimes1k would revert (BuilderFeeExceedsCap). Attribution must ride on builder≠0 with fee 0, or on userData.`);
    }
  }

  // ══════════════════════════════════════════════════════════ 5. fills ═══
  hr(`5. Fill activity over the same window (OrderFilled on ${new Set(discovered.map((m) => m.pool.toLowerCase())).size} distinct pools)`);
  const poolSet = [...new Set([...discovered, ...resolvedOutOfWindow].map((m) => getAddress(m.pool)))];
  const t5 = Date.now();
  lastPct = -1;
  const fills: Fill[] = await scanFills({
    client,
    pools: poolSet,
    fromBlock,
    toBlock,
    concurrency: LOG_CONCURRENCY,
    onProgress: (p) => {
      const q = Math.floor((100 * p.done) / p.total / 25) * 25;
      if (q !== lastPct && q > 0) {
        lastPct = q;
        process.stdout.write(`  … OrderFilled scan ${q}% (${p.logs} logs)\r`);
      }
    },
  });
  line(`  scanned ${poolSet.length} pools × [${fromBlock}, ${toBlock}] (${ms(t5)})`);
  const allMarkets = [...discovered, ...resolvedOutOfWindow];
  const attr = attributeFills(fills, allMarkets);
  const notional = fillsNotional(fills, one);
  line(`  total fills                 ${fills.length}`);
  line(`  total notional              ${formatUnits(notional, decimals)} collateral (Σ fillPrice×qty)`);
  line(`  fills unattributed          ${attr.unattributed.length} (on a pool before any MarketCreated we saw — belong to pre-window markets)`);

  const withFills = allMarkets.filter((m) => (attr.byMarket.get(m.marketId)?.length ?? 0) > 0);
  const zero = allMarkets.filter((m) => (attr.byMarket.get(m.marketId)?.length ?? 0) === 0);
  const expiredZero = expiredInWindow.filter((m) => (attr.byMarket.get(m.marketId)?.length ?? 0) === 0);
  line("");
  line(`  fills per market (non-zero only, desc):`);
  const ranked = withFills
    .map((m) => ({ m, f: attr.byMarket.get(m.marketId) ?? [] }))
    .sort((a, b) => b.f.length - a.f.length);
  for (const { m, f } of ranked.slice(0, 25)) {
    line(`    ${pad(short(m.marketId, 5), 14)} ${pad(m.asset, 4)} ${padL(m.intervalSec + "s", 7)} ${pad(marketStatusLabel(statusOf.get(m.marketId)), 13)} fills=${padL(f.length, 4)} notional=${formatUnits(fillsNotional(f, one), decimals)}`);
  }
  if (ranked.length > 25) line(`    … ${ranked.length - 25} more markets with fills`);
  line("");
  line(`  ── the "empty markets" measurement ──`);
  line(`  markets discovered in window          ${allMarkets.length}`);
  line(`  markets with ≥1 fill                  ${withFills.length}`);
  line(`  markets with ZERO fills               ${zero.length}  (${pct(zero.length, allMarkets.length)} of all discovered)`);
  line(`  of which already EXPIRED (complete)   ${expiredZero.length} of ${expiredInWindow.length} expired  (${pct(expiredZero.length, expiredInWindow.length)} of completed windows ended with zero fills)`);
  // Slice by series.
  const seriesKey = (m: DiscoveredMarket) => `${m.asset} ${m.intervalSec}s`;
  const series = new Map<string, { n: number; zero: number; fills: number }>();
  for (const m of expiredInWindow) {
    const k = seriesKey(m);
    const e = series.get(k) ?? { n: 0, zero: 0, fills: 0 };
    const f = attr.byMarket.get(m.marketId)?.length ?? 0;
    e.n++;
    e.fills += f;
    if (f === 0) e.zero++;
    series.set(k, e);
  }
  line(`  by series (expired windows only, all venues):`);
  for (const [k, e] of [...series.entries()].sort()) {
    line(`    ${pad(k, 12)} windows=${padL(e.n, 4)}  zero-fill=${padL(e.zero, 4)} (${pct(e.zero, e.n)})  fills=${e.fills}`);
  }
  // The same, per venue — the 1-minute test series on other operators dominate the raw number,
  // so the pitch figure is the per-venue one.
  const byVenueSeries = new Map<string, Map<string, { n: number; zero: number; fills: number; notional: bigint }>>();
  for (const m of expiredInWindow) {
    const v = m.venueId.toLowerCase();
    const inner = byVenueSeries.get(v) ?? new Map();
    const k = seriesKey(m);
    const e = inner.get(k) ?? { n: 0, zero: 0, fills: 0, notional: 0n };
    const fl = attr.byMarket.get(m.marketId) ?? [];
    e.n++;
    e.fills += fl.length;
    e.notional += fillsNotional(fl, one);
    if (fl.length === 0) e.zero++;
    inner.set(k, e);
    byVenueSeries.set(v, inner);
  }
  line(`  by venue × series (expired windows only):`);
  for (const [v, inner] of byVenueSeries.entries()) {
    let n = 0;
    let z = 0;
    let f = 0;
    let nt = 0n;
    for (const e of inner.values()) {
      n += e.n;
      z += e.zero;
      f += e.fills;
      nt += e.notional;
    }
    line(`    venue ${v}${v === kitHint ? " (kit DreamDEX hint)" : ""}: windows=${n} zero-fill=${z} (${pct(z, n)}) fills=${f} notional=${formatUnits(nt, decimals)}`);
    for (const [k, e] of [...inner.entries()].sort()) {
      line(`      ${pad(k, 12)} windows=${padL(e.n, 4)}  zero-fill=${padL(e.zero, 4)} (${pct(e.zero, e.n)})  fills=${padL(e.fills, 5)}  notional=${formatUnits(e.notional, decimals)}`);
    }
  }

  // ═══════════════════════════════════════════════════════ 6. tUSDC sanity ═══
  hr("6. Collateral (tUSDC) contract sanity — read-only");
  const token = addrs.collateral;
  const [dec, sym, name, supply, code] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }).catch(() => "?"),
    client.readContract({ address: token, abi: erc20Abi, functionName: "name" }).catch(() => "?"),
    client.readContract({ address: token, abi: erc20Abi, functionName: "totalSupply" }).catch(() => 0n),
    client.getCode({ address: token }),
  ]);
  line(`  address       ${token}`);
  line(`  name/symbol   ${name} / ${sym}`);
  line(`  decimals()    ${dec} ${Number(dec) === decimals ? "✓" : `✗ expected ${decimals}`}`);
  line(`  totalSupply   ${formatUnits(supply, Number(dec))}`);
  const faucetSel = toFunctionSelector("function faucet(uint256 amount)");
  let codeToCheck = code ?? "0x";
  let via = "direct";
  if (!codeToCheck.toLowerCase().includes(faucetSel.slice(2).toLowerCase())) {
    // Maybe a proxy: check the EIP-1967 implementation slot.
    const slot = await client.getStorageAt({ address: token, slot: EIP1967_IMPL_SLOT });
    const impl = slot && slot !== "0x" ? (`0x${slot.slice(-40)}` as Address) : null;
    if (impl && impl !== ZERO_ADDRESS) {
      codeToCheck = (await client.getCode({ address: impl })) ?? "0x";
      via = `EIP-1967 impl ${impl}`;
    }
  }
  const hasFaucet = codeToCheck.toLowerCase().includes(faucetSel.slice(2).toLowerCase());
  line(`  faucet(uint256) selector ${faucetSel} ${hasFaucet ? `FOUND in bytecode (${via}) ✓` : "NOT found in bytecode ✗"}  — not called (read-only probe)`);
  line(`  bytecode size ${(codeToCheck.length - 2) / 2} bytes`);

  // ═══════════════════════════════════════════════ 7. topics + open questions ═══
  hr("7. Recent log topics on pools/module/settlement (surfacing fee events) + open questions");
  // Topic-less (all events) over the last 3 chunks of ≤1000 blocks — the RPC cap is inclusive.
  const tailFrom = toBlock - 2999n > fromBlock ? toBlock - 2999n : fromBlock;
  const tailAddrs = [...poolSet.slice(0, 200), addrs.binaryModule, addrs.binarySettlement];
  const rawLogs: Awaited<ReturnType<typeof client.getLogs>> = [];
  for (let f = tailFrom; f <= toBlock; f += 1000n) {
    const t = f + 999n < toBlock ? f + 999n : toBlock;
    rawLogs.push(...(await client.getLogs({ address: tailAddrs, fromBlock: f, toBlock: t })));
  }
  const topicCounts = new Map<string, number>();
  for (const l of rawLogs) {
    const t0 = l.topics[0] ?? "(anonymous)";
    topicCounts.set(t0, (topicCounts.get(t0) ?? 0) + 1);
  }
  line(`  last ${toBlock - tailFrom + 1n} blocks, ${rawLogs.length} logs on ${Math.min(poolSet.length, 200)} pools + module + settlement:`);
  const unknownTopics: string[] = [];
  for (const [t0, n] of [...topicCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const nm = eventNameForTopic(t0);
    if (!nm) unknownTopics.push(t0);
    const hint = !nm ? UNRESOLVED_OBSERVED_TOPICS[t0.toLowerCase()] : undefined;
    line(`    ${pad(nm ?? "UNKNOWN", 36)} ${padL(n, 6)}  ${t0}${hint ? `\n      ↳ ${hint}` : ""}`);
  }
  const builderTopicsSeen = unknownTopics.filter((t) => !UNRESOLVED_OBSERVED_TOPICS[t.toLowerCase()]);
  line(`  ProtocolFeeCharged / MarketResolved / settlement MarketFinalized were identified from live topics (see @relay/core observedEventsAbi); ${builderTopicsSeen.length === 0 ? "no never-seen topic0 in this tail — no BuilderFeeCharged observed (no builder-tagged orders on testnet yet)." : `${builderTopicsSeen.length} never-seen topic0(s): ${builderTopicsSeen.join(", ")} — candidates for BuilderFeeCharged.`}`);

  // Open questions — hit during research + this run.
  oq("Builder tagging on testnet: pools report maxBuilderFeeBpsTimes1k = 0. Is `builder ≠ address(0)` with `builderFeeBpsTimes1k = 0` ACCEPTED, or does the pool revert (candidate errors in the SDK error table: BuilderCodesNotSupported, InvalidBuilder, BuilderNotApproved)? Needs a signed test order in Phase 1 (or an eth_call simulation from a funded address).");
  oq("Is approveBuilder required when the fee is 0? The kit says 'call approveBuilder once' before passing a fee <= cap; the SDK comment says 'the builder must be opted in via approveBuilder'. Unclear whether that gate applies at fee 0.");
  oq("approveBuilder is a POOL call (binaryPoolWriteAbi: approveBuilder(address builder, uint256 maxFeeBpsTimes1k) on the pool; getBuilderApproval(user, builder) per pool). Pools are recycled per window — so does a user's approval persist across the pool's successive markets, and does a partner need approval on EVERY pool a user trades? (Router errors mention RouterBuilderNotApproved(legIndex, pool, …), suggesting per-pool.)");
  oq(`Exact BuilderFeeCharged signature. Confirmed: it is a POOL event (markets-sdk src/writer.ts: the pool "also emits OrderAmended, MarkPriceUpdated and BuilderFeeCharged, none of which this ABI carries") and the indexer stores BuilderFeeRecord(orderId, builder, payer, token, amount, market, pool, txHash). Its sibling ProtocolFeeCharged(uint128 indexed orderId, address indexed payer, address indexed token, uint256 amount, bool isTakerSide) WAS identified live this run (one per fill side). Best guess for the builder one: (uint128 indexed orderId, address indexed builder, address indexed payer, address token, uint256 amount[, bool isTakerSide]) — unverifiable until a builder-tagged order fills. ${builderTopicsSeen.length > 0 ? `This run saw ${builderTopicsSeen.length} never-seen topic0(s) — decode those first.` : "Not observed in this run (no builder-tagged orders on testnet)."} Fallback: decode placeBinaryOrder calldata of the placing tx (builder = arg 7).`);
  oq("OrderPlaced carries `userData` (uint64) and `owner` but NOT the builder. For chain-only attribution the indexer must either (a) decode the builder fee event, or (b) fetch each placing tx and decode calldata. (b) costs one eth_getTransactionByHash per order.");
  oq("Strike scale: MarketCreated.strike is raw in the oracle adapter's decimals (OracleHub = 2 dp per SDK comments; a price-feed adapter = 18 dp). The widget must read the adapter/PRICE_DECIMALS rather than assume 2 dp. Reference-mode markets have strike = 0 (threshold is the opening price).");
  oq("The MarketCreator address differs between the kit (0x5Ce6…) and SDK 0.29.0 (0x138C…), and testnet 1-minute 'Pricefeed test' series are created by a creator that is neither. Discovery via the module is unaffected; anything keyed on the creator address is not stable.");
  oq("Indexer-free discovery of LONG-cadence series (4h/24h) needs a log window at least as long as the cadence (24h ≈ 864k blocks ≈ 864 getLogs calls). Alternative: keep a persistent cursor (the indexer does) and only backfill once.");
  oq("markets-sdk's own testnet address set (0.29.0) disagrees with the kit's on clobFactory / binaryPoolImpl / marketCreator. Pools are beacon proxies, so the implementation can change without notice — the widget must not pin behaviour to an impl address.");

  line("");
  line("  OPEN QUESTIONS");
  openQuestions.forEach((q, i) => line(`  ${padL(i + 1, 2)}. ${q}`));

  line("");
  line("━━━ done ━━━");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error("\nPROBE FAILED:", e);
    process.exit(1);
  },
);
