// Shared Phase 1 environment: config + a signer built from PRIVATE_KEY.
// The key is read once and never logged; only the derived address is exposed.

import { config as dotenv } from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, http, type Account, type Chain, type Hex, type PublicClient, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { ADDRESSES, COLLATERAL_DECIMALS, ENDPOINTS, KIT_VENUE_HINTS, networkForChainId, relayChain, type EcAddresses, type Network } from "@relay/core";

dotenv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

const env = (k: string): string => (process.env[k] ?? "").trim();

export interface Phase1Env {
  network: Network;
  chainId: number;
  chain: Chain;
  rpcUrl: string;
  wsRpcUrl: string;
  indexerUrl: string;
  venueId: Hex;
  addresses: EcAddresses;
  decimals: number;
  one: bigint;
  explorer: string;
  account: Account;
  publicClient: PublicClient;
  walletClient: WalletClient;
}

export function loadPhase1Env(): Phase1Env {
  const network: Network = env("NETWORK").toLowerCase() === "mainnet" ? "mainnet" : "testnet";
  const chainId = Number(env("CHAIN_ID") || (network === "mainnet" ? 5031 : 50312));
  if (networkForChainId(chainId) !== network) throw new Error(`CHAIN_ID=${chainId} does not match NETWORK=${network}`);
  const rpcUrl = env("RPC_URL") || ENDPOINTS[network].http[0]!;
  const wsRpcUrl = env("WS_RPC_URL") || ENDPOINTS[network].ws[0]!;
  const indexerUrl = env("INDEXER_URL") || ENDPOINTS[network].indexer;
  const venueId = ((env("VENUE_ID") || KIT_VENUE_HINTS[network]).toLowerCase()) as Hex;

  const rawKey = env("PRIVATE_KEY");
  if (!/^(0x)?[0-9a-fA-F]{64}$/.test(rawKey)) {
    throw new Error("PRIVATE_KEY missing or malformed in .env (expected 32-byte hex). Phase 1 needs a funded Shannon key.");
  }
  const account = privateKeyToAccount((rawKey.startsWith("0x") ? rawKey : `0x${rawKey}`) as Hex);

  const chain = relayChain({ network, rpcUrl, wsRpcUrl });
  const transport = http(rpcUrl, { timeout: 30_000, retryCount: 3 });
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ chain, transport, account });
  const decimals = COLLATERAL_DECIMALS[network];
  return {
    network,
    chainId,
    chain,
    rpcUrl,
    wsRpcUrl,
    indexerUrl,
    venueId,
    addresses: ADDRESSES[network],
    decimals,
    one: 10n ** BigInt(decimals),
    explorer: ENDPOINTS[network].explorer,
    account,
    publicClient,
    walletClient,
  };
}

export const txUrl = (explorer: string, hash: string) => `${explorer}/tx/${hash}`;
export const nowSec = () => Math.floor(Date.now() / 1000);
export const iso = (sec: number | bigint) => new Date(Number(sec) * 1000).toISOString();
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
