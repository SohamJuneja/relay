// Chain configuration for Somnia. Browser-safe: no env access here — callers
// (the probe, the indexer, the widget host) resolve URLs and pass them in.
//
// Sources:
//   - dreamdex-bot-kit/packages/ec-core/src/config.ts  (ENDPOINTS per network)
//   - dreamdex-bot-kit/skills/somnia/SKILL.md          (chain ids, explorers)
//   - @somnia-chain/markets-sdk dist/chains/definitions/somniaShannon.js
//     (block time ≈ 100 ms, multicall3 address, secondary RPC aliases)

import { defineChain, type Chain } from "viem";

export type Network = "testnet" | "mainnet";

export const CHAIN_IDS: Record<Network, number> = {
  testnet: 50312, // Shannon
  mainnet: 5031,
};

export interface NetworkEndpoints {
  http: readonly string[];
  ws: readonly string[];
  /** DreamDEX Envio/Hasura GraphQL indexer. Moves occasionally; treat as optional. */
  indexer: string;
  explorer: string;
}

export const ENDPOINTS: Record<Network, NetworkEndpoints> = {
  testnet: {
    http: ["https://dream-rpc.somnia.network", "https://api.infra.testnet.somnia.network"],
    ws: ["wss://api.infra.testnet.somnia.network/ws", "wss://dream-rpc.somnia.network/ws"],
    indexer: "https://dev.smk.somnia.host/v1/graphql",
    explorer: "https://shannon-explorer.somnia.network",
  },
  mainnet: {
    http: ["https://api.infra.mainnet.somnia.network"],
    ws: ["wss://api.infra.mainnet.somnia.network/ws"],
    indexer: "https://prd.smk.somnia.host/v1/graphql",
    explorer: "https://explorer.somnia.network",
  },
};

/**
 * Measured on Shannon: 10,000 blocks spanned exactly 1,000 s → 100 ms blocks.
 * Use `estimateBlockTime()` at runtime rather than trusting this constant when
 * sizing a log window; this is only a sane default.
 */
export const APPROX_BLOCK_TIME_SEC: Record<Network, number> = {
  testnet: 0.1,
  mainnet: 0.1,
};

/** Shannon's eth_getLogs rejects ranges wider than this ("block range exceeds 1000"). */
export const GET_LOGS_MAX_RANGE = 1000n;

export const MULTICALL3: Partial<Record<Network, { address: `0x${string}`; blockCreated: number }>> = {
  // From the markets-sdk chain definition for Shannon.
  testnet: { address: "0x841b8199E6d3Db3C6f264f6C2bd8848b3cA64223", blockCreated: 71314235 },
};

export function networkForChainId(chainId: number): Network {
  if (chainId === CHAIN_IDS.mainnet) return "mainnet";
  if (chainId === CHAIN_IDS.testnet) return "testnet";
  throw new Error(`Unknown Somnia chain id ${chainId} (expected 50312 testnet or 5031 mainnet)`);
}

export interface RelayChainOptions {
  network: Network;
  /** Override the HTTP RPC (defaults to ENDPOINTS[network].http[0]). */
  rpcUrl?: string;
  /** Override the WebSocket RPC (defaults to ENDPOINTS[network].ws[0]). */
  wsRpcUrl?: string;
}

/** A viem `Chain` for the selected Somnia network, with multicall3 wired where known. */
export function relayChain(opts: RelayChainOptions): Chain {
  const ep = ENDPOINTS[opts.network];
  const http = opts.rpcUrl ? [opts.rpcUrl, ...ep.http.filter((u) => u !== opts.rpcUrl)] : [...ep.http];
  const ws = opts.wsRpcUrl ? [opts.wsRpcUrl, ...ep.ws.filter((u) => u !== opts.wsRpcUrl)] : [...ep.ws];
  const mc = MULTICALL3[opts.network];
  return defineChain({
    id: CHAIN_IDS[opts.network],
    name: opts.network === "mainnet" ? "Somnia" : "Somnia Shannon Testnet",
    nativeCurrency:
      opts.network === "mainnet"
        ? { name: "Somnia", symbol: "SOMI", decimals: 18 }
        : { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
    rpcUrls: { default: { http, webSocket: ws } },
    blockExplorers: { default: { name: "Explorer", url: ep.explorer } },
    ...(mc ? { contracts: { multicall3: mc } } : {}),
    testnet: opts.network === "testnet",
  });
}
