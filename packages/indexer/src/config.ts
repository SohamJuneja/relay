import { config as dotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http, type PublicClient } from "viem";
import { ADDRESSES, COLLATERAL_DECIMALS, ENDPOINTS, KIT_VENUE_HINTS, networkForChainId, relayChain, type EcAddresses, type Network } from "@relay/core";

// Load .env for local development only.
//
// In production the host injects the environment, and there is no .env to read — but
// "no file, so dotenv quietly does nothing" is the wrong reason for it to be
// harmless. A deployed process should not be looking for a secrets file on disk at
// all: if one ever appeared next to the bundle it would silently override what the
// host configured, which is a very bad surprise to debug. So the load is skipped
// outright when NODE_ENV is production.
//
// The path is resolved from this module, never from cwd — Render starts the server
// from the repo root, not from the package.
if (process.env.NODE_ENV !== "production") {
  dotenv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env") });
}

const env = (k: string): string => (process.env[k] ?? "").trim();

export interface IndexerConfig {
  network: Network;
  chainId: number;
  rpcUrl: string;
  wsRpcUrl: string;
  indexerUrl: string;
  databaseUrl: string;
  addresses: EcAddresses;
  decimals: number;
  one: bigint;
  /** The venue Relay reports on by default (the DreamDEX venue). */
  defaultVenueId: `0x${string}`;
  /** Backfill start; undefined → now − BACKFILL_HOURS. */
  startBlock: bigint | undefined;
  backfillHours: number;
  chunkSize: bigint;
  concurrency: number;
  confirmations: bigint;
  reorgDepth: bigint;
  tailPollMs: number;
  builderFeeBps: number;
  priceAssets: string[];
}

export function loadConfig(): IndexerConfig {
  const network: Network = env("NETWORK").toLowerCase() === "mainnet" ? "mainnet" : "testnet";
  const chainId = Number(env("CHAIN_ID") || (network === "mainnet" ? 5031 : 50312));
  if (networkForChainId(chainId) !== network) throw new Error(`CHAIN_ID=${chainId} does not match NETWORK=${network}`);
  return {
    network,
    chainId,
    rpcUrl: env("RPC_URL") || ENDPOINTS[network].http[0]!,
    wsRpcUrl: env("WS_RPC_URL") || ENDPOINTS[network].ws[0]!,
    indexerUrl: env("INDEXER_URL") || ENDPOINTS[network].indexer,
    databaseUrl: env("DATABASE_URL") || "postgres://relay:relay@localhost:5433/relay",
    addresses: ADDRESSES[network],
    decimals: COLLATERAL_DECIMALS[network],
    one: 10n ** BigInt(COLLATERAL_DECIMALS[network]),
    defaultVenueId: ((env("VENUE_ID") || KIT_VENUE_HINTS[network]).toLowerCase()) as `0x${string}`,
    startBlock: env("START_BLOCK") ? BigInt(env("START_BLOCK")) : undefined,
    backfillHours: Number(env("BACKFILL_HOURS") || 24),
    chunkSize: BigInt(env("INDEXER_CHUNK") || 1000),
    concurrency: Number(env("INDEXER_CONCURRENCY") || 8),
    confirmations: BigInt(env("INDEXER_CONFIRMATIONS") || 5),
    reorgDepth: BigInt(env("INDEXER_REORG_DEPTH") || 50),
    tailPollMs: Number(env("INDEXER_TAIL_POLL_MS") || 1500),
    builderFeeBps: Number(env("BUILDER_FEE_BPS") || 100),
    priceAssets: (env("PRICE_ASSETS") || "BTC,ETH").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
  };
}

export function makePublicClient(cfg: IndexerConfig): PublicClient {
  return createPublicClient({
    chain: relayChain({ network: cfg.network, rpcUrl: cfg.rpcUrl, wsRpcUrl: cfg.wsRpcUrl }),
    transport: http(cfg.rpcUrl, { timeout: 45_000, retryCount: 3, batch: false }),
  });
}
