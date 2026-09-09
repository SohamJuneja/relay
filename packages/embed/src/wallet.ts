// Two ways to sign, one interface.
//
//   injected  — the user's own wallet over EIP-1193 (MetaMask, Rabby …). We add
//               or switch to Somnia Shannon first, then hand it `eth_sendTransaction`
//               and let it manage nonce and signing.
//   instant   — a key generated in the browser and kept in localStorage. It is a
//               TESTNET convenience so a first-time user can trade in one click;
//               the UI says plainly where the key lives and offers Export and
//               Forget. Never ship this pattern on mainnet.
//
// Relay never sees a key. Transactions are signed locally by viem's
// `privateKeyToAccount(...).signTransaction` and pushed with `eth_sendRawTransaction`.

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { CHAIN_IDS, ENDPOINTS, type Network } from "@relay/core/browser";
import type { Rpc, TxRequest } from "./rpc.js";

export type WalletKind = "injected" | "instant";

/**
 * Fee cap for browser-signed transactions.
 *
 * A node reserves `gas × maxFeePerGas` from the balance BEFORE it executes, and
 * only refunds the difference afterwards. The SDK's 60 gwei default is 10× the
 * ~6 gwei base-fee floor, so a 3 M-gas order reserves 0.18 STT to spend 0.005 —
 * enough to make a freshly funded burner fail with "insufficient balance" while
 * holding plenty. 15 gwei keeps 2.5× headroom over the floor and reserves a
 * quarter as much. Somnia also rejects a tip that pushes past the cap, so the
 * priority fee stays at 0.
 */
export const FEES = { maxFeePerGas: 15_000_000_000n, maxPriorityFeePerGas: 0n } as const;

export interface RelayWallet {
  kind: WalletKind;
  address: Address;
  /** Sign (or delegate) and broadcast. Returns the transaction hash. */
  send(tx: TxRequest): Promise<Hex>;
  /** Instant wallet only — backs the Export action. */
  exportKey?: () => string;
}

export interface ChainInfo {
  id: number;
  name: string;
  rpcUrl: string;
  explorer: string;
  nativeCurrency: { name: string; symbol: string; decimals: number };
}

export function chainInfo(network: Network): ChainInfo {
  const ep = ENDPOINTS[network];
  return {
    id: CHAIN_IDS[network],
    name: network === "mainnet" ? "Somnia" : "Somnia Shannon Testnet",
    rpcUrl: ep.http[0] ?? "",
    explorer: ep.explorer,
    nativeCurrency: network === "mainnet" ? { name: "Somnia", symbol: "SOMI", decimals: 18 } : { name: "Somnia Test Token", symbol: "STT", decimals: 18 },
  };
}

const STORAGE_PREFIX = "relay.wallet.";
const storageKey = (chainId: number) => `${STORAGE_PREFIX}${chainId}`;

function readStoredKey(chainId: number): Hex | null {
  try {
    const v = localStorage.getItem(storageKey(chainId));
    return v && /^0x[0-9a-fA-F]{64}$/.test(v) ? (v as Hex) : null;
  } catch {
    return null; // storage blocked (private mode, sandboxed iframe)
  }
}

export const hasInstantWallet = (chainId: number): boolean => readStoredKey(chainId) !== null;

export function forgetInstantWallet(chainId: number): void {
  try {
    localStorage.removeItem(storageKey(chainId));
  } catch {
    /* ignore */
  }
}

/** Load the burner stored for this chain, or create and persist a fresh one. */
export function loadOrCreateInstantWallet(chain: ChainInfo, rpc: Rpc): RelayWallet {
  let key = readStoredKey(chain.id);
  if (!key) {
    key = generatePrivateKey();
    try {
      localStorage.setItem(storageKey(chain.id), key);
    } catch {
      /* not persistable — still usable for this page view */
    }
  }
  const account = privateKeyToAccount(key);
  return {
    kind: "instant",
    address: account.address,
    exportKey: () => key as string,
    async send(tx: TxRequest): Promise<Hex> {
      const nonce = await rpc.getTransactionCount(account.address);
      const serialized = await account.signTransaction({
        type: "eip1559",
        chainId: chain.id,
        to: tx.to,
        data: tx.data ?? "0x",
        value: tx.value ?? 0n,
        nonce,
        gas: tx.gas ?? 2_000_000n,
        ...FEES,
      });
      return rpc.sendRawTransaction(serialized);
    },
  };
}

// ───────────────────────────── injected (EIP-1193) ─────────────────────────────

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
  on?(event: string, handler: (...args: unknown[]) => void): void;
  removeListener?(event: string, handler: (...args: unknown[]) => void): void;
}

export const injectedProvider = (): Eip1193Provider | null => (globalThis as unknown as { ethereum?: Eip1193Provider }).ethereum ?? null;

/** Switch the wallet to Somnia, adding the network when it does not know it. */
export async function ensureChain(provider: Eip1193Provider, chain: ChainInfo): Promise<void> {
  const chainId = `0x${chain.id.toString(16)}`;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    return;
  } catch (e) {
    const code = (e as { code?: number; data?: { originalError?: { code?: number } } })?.code ?? (e as { data?: { originalError?: { code?: number } } })?.data?.originalError?.code;
    if (code !== 4902 && code !== -32603) throw e;
  }
  await provider.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId,
        chainName: chain.name,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: [chain.rpcUrl],
        blockExplorerUrls: [chain.explorer],
      },
    ],
  });
  await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
}

export async function connectInjected(chain: ChainInfo): Promise<RelayWallet> {
  const provider = injectedProvider();
  if (!provider) throw new Error("no injected wallet found");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
  const address = accounts[0];
  if (!address) throw new Error("the wallet returned no account");
  await ensureChain(provider, chain);
  return {
    kind: "injected",
    address,
    async send(tx: TxRequest): Promise<Hex> {
      // The wallet owns nonce, gas price and signing; we only state intent.
      const params: Record<string, string> = { from: address, to: tx.to };
      if (tx.data) params.data = tx.data;
      if (tx.value !== undefined && tx.value > 0n) params.value = `0x${tx.value.toString(16)}`;
      if (tx.gas !== undefined) params.gas = `0x${tx.gas.toString(16)}`;
      return (await provider.request({ method: "eth_sendTransaction", params: [params] })) as Hex;
    },
  };
}
